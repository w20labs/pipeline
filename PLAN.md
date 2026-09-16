# Pipeline — Implementation Plan (v2)

Pipeline is a local, open-source tool for running AI coding agents in a defined workflow. A
visual editor writes `pipeline.yaml`, an engine executes it, and herdr hosts the agents in real
terminal panes you can watch. Any agent CLI works through agent profiles.

This plan is built for a two-agent loop: one agent implements a step, a second agent verifies
it. Every step is small, has one clear deliverable, lists the files it should touch, and has a
"Done when" list that can be checked objectively.

## What changed from v1

- **Walking skeleton first.** A real two-agent loop runs on real herdr at step 14, and a live
  view exists at step 17 (v1: step 22 and step 25).
- **Real agent output is captured before code depends on it** (step 04), so the verdict parser
  is tested on real screens, not invented ones.
- **Correct behavior is defined up front.** `SPEC.md` and golden scenarios (step 05) define
  what the engine must do. Tests must match the scenarios, not whatever the code happens to do.
- **Security from day one.** The local server requires a session token and checks `Host` and
  `Origin` (step 15). Unfamiliar pipelines need approval before they run (step 29).
- **A throwaway UI prototype at step 06**, so you can judge the look and feel in the first week.
- **The engine runs inside a herdr pane** (step 13), so runs survive closing your terminal.
- **A size limit per step**, and big steps split into smaller ones.
- **An on-demand live test suite** (step 32) to catch agent CLI updates that break detection
  or verdict parsing.

---

## How to use this plan

1. Work in order unless a step's dependencies allow otherwise.
2. The implementer gets exactly one step. It must not start the next step or "improve" earlier
   ones beyond what the step requires.
3. The reviewer checks every item in "Done when", runs every listed command, and ends with
   `VERDICT: APPROVE` or `VERDICT: REVISE`.
4. A step is done only when the reviewer approves. Then commit with the step ID in the message
   (e.g. `step 07: runtime interface and fake runtime`).
5. Steps marked **Sign-off: you** need your own check after the reviewer approves.

### Rules for the implementer (step 01 puts these in AGENTS.md and CLAUDE.md)

- Implement only the current step. Write ideas for later in `docs/ideas.md` instead of building them.
- Touch only the files listed under "Files", plus tests and fixtures for them. If another file
  must change, say which and why in the summary.
- **Size limit:** if the diff grows past about 400 changed lines (excluding lockfiles, fixtures,
  and generated files), stop and propose how to split the step instead of continuing.
- Every step ends with `pnpm lint && pnpm test` passing.
- No new dependency without naming it in the summary with one line of justification.
- Never commit. Stop when finished and summarize what changed and how to verify it.

### Rules for the reviewer

- Do not modify code. Report findings with file:line references, most severe first.
- Run every command in "Done when". Report the actual output when something fails.
- Check for: files changed outside the step's "Files" list, missing tests for new logic, tests
  that don't prove the behavior, anything from "Not in this step" that crept in, and any
  disagreement with `docs/SPEC.md` or the golden scenarios.
- End with exactly one line: `VERDICT: APPROVE` or `VERDICT: REVISE`.

### Bootstrapping (before Pipeline can run itself)

Until step 18, use the `pipeline-loop.sh` script with `TEST_CMD="pnpm lint && pnpm test"` and a
task of the form `Implement step NN from PLAN.md`. After step 18, Pipeline runs its own
development loop and the live view shows it.

---

## Decisions (defaults — override before step 01)

| Area | Default | Why |
|---|---|---|
| Language | TypeScript, Node 20+ | One language for engine, server, and UI |
| Repo | pnpm monorepo | Clean package boundaries, one install |
| Validation | zod | Schema and types from one definition |
| YAML | `yaml` package, Document API | Preserves user comments on round-trip |
| Tests | vitest; Playwright for UI | Fast unit tests; real browser checks for UI |
| Canvas | React + `@xyflow/react` (React Flow) | Mature node and edge editor |
| Talking to herdr | herdr CLI with JSON output | Easiest to verify; socket API later if needed |
| Where the engine runs | Inside a herdr pane | Survives detaching and closing the terminal |
| License | MIT or Apache-2.0 | Pipeline only calls herdr's CLI; it doesn't include herdr code (not legal advice) |
| Name | `pipeline` as a placeholder | Pick the final name before publishing (step 44) |

### Package layout

```
packages/
  core/       schema, validation, engine, run log, verdict parser, templates
  runtime/    RuntimeAdapter interface, FakeRuntime, HerdrRuntime
  profiles/   agent profile schema and built-in profiles
  cli/        the `pipeline` command
  server/     local HTTP and WebSocket server
  ui/         React app (skeleton live view first, full editor later)
spec/
  scenarios/  golden scenarios (expected event sequences)
  pipelines/  pipelines used by the scenarios
prototype/    throwaway UI prototype (step 06)
examples/
  sample-app/ tiny project with real tests, used for end-to-end runs
tools/
  fake-agent/ scriptable fake agent CLI for token-free tests
```

---

## Engine rules (normative — step 05 turns this into docs/SPEC.md)

These rules define correct behavior. Spikes (steps 02–04) may correct details; any change is
made in SPEC.md first and then in code.

**Terms.** A *run* executes one pipeline for one task. A *turn* is one prompt to an agent, or
one execution of a gate, until it settles. An *outcome* is the result of a turn. A *port* is an
outcome a node can produce; an *edge* connects a port to a target node.

- **R1 — Start.** A run begins at the pipeline's `start` node with round = 1. The first prompt
  to the start node contains the task.
- **R2 — Rounds.** Every time control enters the start node after the first entry, from any
  edge, the round increases by one.
- **R3 — Round limit.** If entering the start node would make the round exceed `max_rounds`,
  the engine escalates with reason `max_rounds` instead of sending the prompt.
- **R4 — Agent turns.** The engine sends a prompt and waits until the runtime reports the agent
  settled. Settled idle or done → the node's outcome is decided by R5. Blocked → escalate
  `blocked`. No settle within `turn_timeout` → escalate `timeout`.
- **R5 — Agent outcomes.** An agent without `verdict` produces `done`. An agent with `verdict`
  produces the outcome named by its last verdict line (`approve` or `revise`). No verdict line
  → escalate `missing_verdict`.
- **R6 — Read-only guard.** Before a turn by a `read-only` agent, the engine snapshots the
  working tree (excluding `.pipeline/`). After the turn, any difference → escalate
  `guard_violation`. This check happens before routing.
- **R7 — Gates.** Exit code 0 → `pass`; any other exit code → `fail`; no exit within the gate
  timeout → escalate `timeout`. The last lines of output are saved as a handoff file.
- **R8 — Routing.** After an outcome, the engine follows the edge connected to that port. A
  port with no edge → escalate `unrouted`.
- **R9 — End.** Entering an end node finishes the run with status `done`. The engine sends no
  further prompts. Agent panes stay open.
- **R10 — Escalation.** An escalation pauses the run, records the reason, and notifies you. The
  run's state is saved to the run folder.
- **R11 — Handoffs before prompts.** Any content passed to the next node is written to a file
  in the run folder before the prompt that refers to it is sent.
- **R12 — Resume.** Resume re-evaluates the paused node without re-sending its prompt: for
  `blocked`, it waits for the agent to settle again; for `missing_verdict`, it re-reads the
  output; for `max_rounds`, it requires extra rounds to be granted (e.g. `--extra-rounds 2`);
  for `guard_violation`, it requires an explicit choice to accept the changes or to stop.
- **R13 — Stop.** Stop ends the run with status `stopped`. The engine does not kill agent panes.
- **R14 — The engine never writes to git.** No commits, no resets, no checkouts.
- **R15 — Determinism.** The same pipeline and the same scripted outcomes always produce the
  same event sequence (ignoring timestamps and run IDs).

**Events** (the only event types, written to `events.jsonl` in this order within a turn):
`run_started`, `node_started`, `handoff_written`, `node_finished` (with outcome), `escalated`
(with reason), `resumed`, `run_finished` (with status `done` or `stopped`).

### Golden scenario format

```yaml
name: revise-twice
covers: [R2, R5, R8, R11]
pipeline: reference            # spec/pipelines/reference.yaml
task: Add rate limiting to /api/upload
script:                        # outcomes each node produces, in order
  implementer: [done, done, done]
  test_gate:   [pass, pass, pass]
  reviewer:    [revise, revise, approve]
expect:                        # exact event sequence
  - run_started
  - { node_started: implementer, round: 1 }
  - { node_finished: implementer, outcome: done }
  - { node_started: test_gate, round: 1 }
  - { handoff_written: test_gate }
  - { node_finished: test_gate, outcome: pass }
  # ... continues through round 3 ...
  - { run_finished: done }
```

---

## Security model

- **Local server.** Bound to 127.0.0.1 on a random free port. A new random token on every start,
  printed as part of the URL. Every HTTP and WebSocket request must present it. Requests with a
  `Host` other than `127.0.0.1:<port>` or `localhost:<port>` are rejected (this blocks DNS
  rebinding). Requests with a foreign `Origin` are rejected. No CORS headers.
- **Trust.** Pipelines run shell commands (gates) and launch agents with flags. The first time a
  `pipeline.yaml` or a custom profile runs, and whenever one changes outside the UI, Pipeline
  shows exactly which commands will run and asks for approval. Approvals are stored by content
  hash in `~/.config/pipeline/trusted.json`.
- **Read-only agents** use the agent's enforced read-only mode when one exists (evidence required
  from step 03), and always get the diff guard (R6).

---

## Reference pipeline.yaml (target shape — step 19 formalizes it)

```yaml
version: 1
name: feature-loop
start: implementer
limits:
  max_rounds: 5
  turn_timeout: 60m
nodes:
  implementer:
    type: agent
    profile: claude-code
    permission: edit            # edit | read-only
    role: >
      You implement the task. Write code and tests. Stop when finished. Never commit.
    next:
      done: test_gate
  test_gate:
    type: gate
    run: npm test
    timeout: 10m
    next:
      pass: reviewer
      fail: implementer
  reviewer:
    type: agent
    profile: codex
    permission: read-only
    verdict: true
    role: >
      You review the current diff against the task. Never edit files.
    next:
      approve: done
      revise:
        to: implementer
        message: "The reviewer asked for changes. Findings: {handoff_file}. Address every finding, then stop."
  done:
    type: end
```

Ports per node type: agent without `verdict` → `done`; agent with `verdict` → `approve` and
`revise`; gate → `pass` and `fail`; end → none. Built-in escalation reasons: `blocked`,
`timeout`, `missing_verdict`, `max_rounds`, `guard_violation`, `unrouted`.

---

## Phase 0 — Scaffold and spikes

### Step 01 — Repository scaffold
**Depends on:** — · **Files:** root config files, `packages/*/`, `examples/sample-app/`,
`AGENTS.md`, `CLAUDE.md`, `.github/workflows/ci.yml`, `LICENSE`, `README.md`

**Build:** pnpm monorepo with the package layout above (empty packages, one placeholder test
each), strict TypeScript, eslint and prettier, vitest, root scripts `lint`, `test`, `build`. CI
runs the same three. `AGENTS.md` and `CLAUDE.md` contain the implementer rules. A tiny
`examples/sample-app` with a passing test suite.

**Done when:**
- `pnpm install && pnpm lint && pnpm test && pnpm build` succeeds from a clean clone.
- Each package has at least one passing test; `examples/sample-app` tests pass on their own.
- The CI workflow runs the same commands.

**Not in this step:** any real code.

### Step 02 — herdr CLI spike (research)
**Depends on:** 01 · **Files:** `docs/herdr-notes.md`, `packages/runtime/test/fixtures/herdr/`

**Build:** document the herdr version tested and the real behavior of every command Pipeline
will use: `tab create`, `pane split`, `pane run`, `pane read`, `pane wait-output`,
`agent start`, `agent prompt --wait`, `agent wait --until`, `agent read`, `agent list`,
`agent explain`. For each: exact syntax, JSON returned, and exit codes for success, timeout,
and error. Save real outputs as fixtures. Answer: can agent commands target a pane ID? Which
`--until` values exist? Can `agent start` pass extra flags to the agent? What state does herdr
report for an unrecognized CLI? How does a process find out that it is running inside a herdr pane?

**Done when:**
- Every listed command is documented, with the herdr version recorded.
- At least one fixture file per command.
- All five questions have explicit answers, each backed by a command the reviewer can rerun.

**Not in this step:** adapter code.

### Step 03 — Agent CLI spike (research)
**Depends on:** 01 · **Files:** `docs/agent-cli-notes.md`

**Build:** for Claude Code, Codex, and OpenCode, verify: launch command, how to set the model,
how to start in an edit mode, and whether an enforced read-only mode exists (with exact flags
or config). Test each read-only claim by asking the agent to edit a file and recording what
happens.

**Done when:**
- A table per agent: model flag, edit-mode flags, read-only flags, enforced yes/no, evidence.
- Every "enforced: yes" has a recorded failed edit attempt as evidence.

**Not in this step:** profile code.

### Step 04 — Real output capture (research)
**Depends on:** 02, 03 · **Files:** `docs/output-capture.md`,
`packages/core/test/fixtures/agent-output/`

**Build:** run Claude Code and Codex in herdr panes. Send review prompts that include the verdict
instruction on a sample diff, and capture `agent read` output after the agent settles. At least
five samples per agent: a short review, a long review (200+ lines), an approve, a revise, and one
that hits a permission prompt (blocked). Record the time from prompt to settled, the state
transitions observed, and whether long reviews get cut off by the read window (and how many
lines are needed to capture them).

**Done when:**
- At least 10 fixture files exist, each with a note of the agent version and the expected verdict.
- `docs/output-capture.md` answers the timing, state, and truncation questions with data.

**Not in this step:** parser code.

### Step 04b — Turn attribution research
**Depends on:** 04 · **Files:** `docs/turn-attribution.md`, `tools/attribution-spike/`,
`packages/runtime/test/fixtures/turn-attribution/`

**Build:** run real Claude Code and Codex turns in an isolated herdr session and record, for each
turn, what the *pane* showed and what the agent's own transcript held, sampled on a timeline.

Step 04 established that a settled state and a successful exit do not establish that *this* prompt
completed. This step asks the next question: what evidence does establish it. Two captures can show
that a pane changed; they cannot show that a completed answer belongs to a given submission. The
candidates compared are the rendered pane and the agents' native transcripts
(`~/.claude/projects/<slug>/<session>.jsonl`, `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`),
which are read-only to Pipeline and written by the agent itself — so reading them grants a
read-only reviewer nothing, and R6 stands.

Agents run with the read-only settings verified in `docs/agent-cli-notes.md`. Paths, record shapes
and flags are version-specific findings, recorded with the versions they were observed on.

**Done when:**
- `docs/turn-attribution.md` answers, with data: can a transcript be bound to a pane when two
  sessions of the same agent share a working directory; what distinguishes commentary, tool
  activity and partial output from a completed answer **that carries no verdict**; which records
  tell two identical submissions apart; how far apart the pane and transcript reads are, and
  whether a capture taken at settlement is complete.
- Fixtures exist for each scenario, with the run's own `run.json` recording versions and bounds.

**Not in this step:** any attribution rule in production code. This is evidence for step 12.

### Step 05 — SPEC.md and golden scenarios
**Depends on:** 04 · **Files:** `docs/SPEC.md`, `spec/scenario.schema.json`,
`spec/events.schema.json`, `spec/pipelines/`, `spec/scenarios/`, one test that validates them ·
**Sign-off: you**

**Build:** turn the engine rules in this plan into `docs/SPEC.md`, with any corrections from the
spikes. Write the reference pipeline and one golden scenario per rule path: approve-round-1,
gate-fail-then-pass, revise-twice, max-rounds, blocked, timeout, missing-verdict,
guard-violation, unrouted-port, resume-after-blocked, resume-with-extra-rounds, stop-mid-turn.

**Done when:**
- Every rule R1–R15 is listed in the `covers` field of at least one scenario.
- A test validates every scenario and pipeline against the schemas.
- You have read and approved SPEC.md (commit message: `step 05: spec approved`).

**Not in this step:** engine code.

### Step 06 — UI feel prototype (throwaway)
**Depends on:** 01 · **Files:** `prototype/` only · **Sign-off: you**

**Build:** a clickable prototype using hard-coded data, built with React and React Flow so you
judge the real library. It includes: the canvas with 4 nodes and edges, the node inspector,
the Design/Run toggle with a fake run animating on a timer, a timeline with a handoff viewer,
and an escalation banner.

**Done when:**
- `pnpm --filter prototype dev` opens it and every interaction above works.
- You've tried it and written your feedback in `docs/ui-feedback.md`.

**Not in this step:** server, real data, tests. This code will not be reused directly.

---

## Phase 1 — Walking skeleton

The goal: a real two-agent loop on real herdr, with a live view, as early as possible. The
skeleton uses a minimal config and hard-coded messages. Phase 2 replaces its internals.

### Step 07 — RuntimeAdapter interface and FakeRuntime
**Depends on:** 02, 04, 05 · **Files:** `packages/runtime/src/adapter.ts`,
`packages/runtime/src/fake.ts`

**Build:** the interface, shaped by the spike findings: `createLayout`, `launchAgent`,
`promptAgent` (returns settled, blocked, or timeout), `readAgentOutput`, `runProcess` (returns
exit code and output), `shutdown`. FakeRuntime is driven by the `script` section of a golden
scenario.

**Done when:**
- The interface is documented with JSDoc.
- Contract tests cover every method on FakeRuntime, including blocked and timeout.
- FakeRuntime loads any file in `spec/scenarios/`.

**Not in this step:** HerdrRuntime.

### Step 08 — Verdict parser
**Depends on:** 04, 05 · **Files:** `packages/core/src/verdict.ts`

**Build:** `parseVerdict(output)` returns `approve`, `revise`, or `missing`, using the last
verdict line only.

**Done when:**
- Every real fixture from step 04 parses to its expected verdict.
- Synthetic cases pass: the verdict instruction echoed above the answer, box-drawing characters
  and bullet prefixes around the line, several verdicts (the last one wins), no verdict, and the
  word appearing mid-sentence (must not count).

**Not in this step:** reading output from herdr.

### Step 09 — Run folder and event log
**Depends on:** 05 · **Files:** `packages/core/src/runlog/`

**Build:** `.pipeline/runs/<run-id>/` containing `events.jsonl` (append-only), `state.json`, and
`handoffs/`. Event types exactly as in `spec/events.schema.json`. A reader that replays events
into state.

**Done when:**
- Tests: write events, replay them, and get identical state; a corrupt last line is detected and
  reported.
- Every event written is validated against `spec/events.schema.json` in tests.

**Not in this step:** the engine.

### Step 10 — Skeleton engine
**Depends on:** 07, 08, 09 · **Files:** `packages/core/src/skeleton/`

**Build:** a hard-coded loop — implementer, then gate, then reviewer, then route — configured
by a minimal `pipeline.skeleton.yaml` (implementer command, reviewer command, gate command,
`max_rounds`). Handoffs are written to files before prompts (R11). Messages are hard-coded.

**Done when:**
- Golden scenarios approve-round-1, gate-fail-then-pass, revise-twice, and max-rounds produce
  exactly their expected event sequences on FakeRuntime.

**Not in this step:** graph routing, diff guard, resume.

### Step 11 — HerdrRuntime: layout and processes
**Depends on:** 02, 07 · **Files:** `packages/runtime/src/herdr/layout.ts`,
`packages/runtime/src/herdr/process.ts`

**Build:** `createLayout`, `runProcess`, and `shutdown` using the herdr CLI, as documented in
step 02. Unit tests use the step 02 fixtures. Integration tests use real herdr and are skipped
unless `PIPELINE_HERDR_IT=1`.

**Departure — gates do not run through herdr.** `pane run` reports that keystrokes were delivered,
not that a command ran, and herdr exposes no exit status for the inner command anywhere
(`docs/herdr-notes.md`, "Differences from PLAN.md" #2). SPEC R7 routes on a real exit status, so
`startProcess`/`observeProcess` run gates directly with `child_process.spawn` rather than scraping a
sentinel out of terminal text. Layout still goes through herdr. Making gate output visible in a pane
is a later concern, and must not put the exit status back at risk.

**Done when:**
- Unit tests pass in CI.
- With `PIPELINE_HERDR_IT=1`, an integration test creates a tab with panes, runs `echo ok`,
  reads exit code 0, and cleans up.

**Not in this step:** agents.

### Step 12 — HerdrRuntime: agents
**Depends on:** 11, and 04b for everything past `inspectAgent` ·
**Files:** `packages/runtime/src/herdr/agent.ts`

**Build:** `launchAgent`, `inspectAgent`, `promptAgent`, `observeAgentTurn` and `readAgentOutput`
using herdr's agent state. The read window is sized from the step 04 findings.

**Correction.** This line previously named three of the five. `observeAgentTurn` is required by this
step's own "Done when" — settled, blocked and timeout are turn *observations* — and the skeleton
engine already calls it; `inspectAgent` is the recovery path a `startup_unconfirmed` launch depends
on, so a launch without it is unusable. Both belong here. Step 31 still owns the fake agent and its
end-to-end runs through real herdr, and step 32 the live agent CLIs.

**Done when:**
- Unit tests on fixtures cover settled, blocked, and timeout, and reading a long output.

**Not in this step:** fake agents (step 31), live tests (step 32).

### Step 13 — `pipeline run` and `pipeline status` (skeleton)
**Depends on:** 10, 12 · **Files:** `packages/cli/`

**Build:** `pipeline run "task"` reads `pipeline.skeleton.yaml`. When run outside herdr with the
herdr runtime, it opens an engine pane in the run's herdr tab and runs itself there, then
prints where to find it. `pipeline status` shows the current node, round, and last events.
`--runtime fake --scenario <file>` runs against FakeRuntime.

**Done when:**
- `pipeline run --runtime fake --scenario spec/scenarios/revise-twice.yaml "task"` exits 0, and
  `pipeline status` shows the finished run.
- Exit codes are documented: 0 done, 2 escalated, 1 error.
- A documented manual check passes: start a herdr run, detach herdr, reattach, and the engine
  pane is still running.

**Not in this step:** the server.

### Step 14 — First real run (CLI)
**Depends on:** 13 · **Files:** `docs/first-run.md`, `docs/evidence/first-run/` ·
**Sign-off: you**

**Build:** a checklist for running Claude Code (implementer) and Codex (reviewer) on
`examples/sample-app` with a small real task, using launch flags from step 03.

**Done when:**
- The checklist has been run once and the run folder is committed as evidence.
- Any issues found are added as new steps at the end of this plan.

**Not in this step:** fixing those issues.

### Step 15 — Local server and security baseline
**Depends on:** 09 · **Files:** `packages/server/src/` (server, auth)

**Build:** `pipeline ui` starts a server following the security model: 127.0.0.1 only, random
port, a new token each start, token required on every request, `Host` and `Origin` checks, no
CORS. One endpoint: `GET /api/runs/latest`.

**Done when:**
- Tests: missing or wrong token → 401; a bad `Host` header → 403 (DNS rebinding case); a
  foreign `Origin` → 403; a valid request → 200.
- The server refuses to bind to anything except 127.0.0.1.

**Not in this step:** WebSocket, UI.

### Step 16 — Live event stream
**Depends on:** 15 · **Files:** `packages/server/src/events.ts`

**Build:** a WebSocket endpoint (token required) that streams a run's events as they're
appended to `events.jsonl`, replaying earlier events on connect.

**Done when:**
- Tests: a client receives the full event sequence of a FakeRuntime run in order; reconnecting
  mid-run replays missed events without duplicates; a connection without the token is refused.

**Not in this step:** the page.

### Step 17 — Skeleton live view
**Depends on:** 16 · **Files:** `packages/ui/` (first page only)

**Build:** a read-only page: the four skeleton nodes with live state colors, a round counter,
a timeline, and clicking a handoff shows the file's contents.

**Done when:**
- Playwright, with a FakeRuntime run: node states change in the right order, the timeline
  shows every event, and the handoff contents shown match the files.

**Not in this step:** editing.

### Step 18 — Skeleton acceptance
**Depends on:** 14, 17 · **Files:** `docs/evidence/skeleton/` · **Sign-off: you**

**Build:** repeat the real run from step 14 with the live view open.

**Done when:**
- You watched a real run in the live view from start to finish, and the evidence is committed.

**Checkpoint:** from here on, build Pipeline with Pipeline.

---

## Phase 2 — Engine hardening

Every step in this phase must keep all golden scenarios passing.

### Step 19 — Pipeline schema
**Depends on:** 05 · **Files:** `packages/core/src/schema/`

**Build:** zod schema and types for pipeline.yaml v1, including edge shorthand
(`fail: implementer`) and the object form (`{ to, message }`), duration strings, and defaults.

**Done when:**
- Every pipeline in `spec/pipelines/` parses.
- At least 10 invalid documents each fail with a specific, readable error message.

**Not in this step:** graph checks, file I/O.

### Step 20 — YAML load and save
**Depends on:** 19 · **Files:** `packages/core/src/yaml.ts`

**Build:** `loadPipeline` and `savePipeline` using the `yaml` Document API, preserving comments
and key order.

**Done when:**
- Load then save with no changes produces byte-identical output.
- Changing one field in a commented file changes only that line.

### Step 21 — Graph validation and `pipeline validate`
**Depends on:** 20 · **Files:** `packages/core/src/validate.ts`, `packages/cli/` (one command)

**Build:** `start` exists; every edge target exists; port names are valid for each node type;
an end node is reachable from start. Warnings for unreachable nodes and unconnected ports.
`pipeline validate [path]` exits 0 or 1.

**Done when:**
- One unit test per rule, valid and invalid.
- The reference pipeline exits 0; a broken fixture exits 1 with the expected message.

### Step 22 — Agent profiles
**Depends on:** 03, 19 · **Files:** `packages/profiles/`

**Build:** profile schema (command, args, model flag, permission flag sets, readiness via
`herdr` or `sentinel` regex, verdict pattern) and built-in profiles for claude-code, codex, and
opencode. A missing read-only flag set means "not enforced". Custom profiles load from
`.pipeline/profiles/*.yaml`.

**Done when:**
- `resolveLaunch(node, profile)` tests cover edit, enforced read-only, unenforced read-only, a
  custom model, and a custom profile.
- Every flag in a built-in profile traces to evidence in `docs/agent-cli-notes.md`.

### Step 23 — Routing reducer
**Depends on:** 09, 19 · **Files:** `packages/core/src/engine/reducer.ts`

**Build:** a pure function `step(state, event) → { state, actions }` implementing R1–R10 and
R15. No I/O.

**Done when:**
- For every golden scenario, feeding its scripted outcomes through the reducer produces
  exactly the expected event sequence.

### Step 24 — Handoffs and message templates
**Depends on:** 09, 19 · **Files:** `packages/core/src/handoff.ts`

**Build:** write handoff files; render edge templates with `{task}`, `{round}`,
`{handoff_file}`, and `{node}`; default templates for every port.

**Done when:**
- Every placeholder renders; an unknown placeholder fails validation with a clear message.

### Step 25 — Diff guard
**Depends on:** 01 · **Files:** `packages/core/src/guard.ts`

**Build:** `snapshot` and `compare` using `git status --porcelain` plus content hashes,
excluding `.pipeline/`.

**Done when:**
- Tests with a temp git repo: no change → clean; modified, created, and deleted files → each
  detected; changes in `.pipeline/` → ignored.

### Step 26 — Engine v1: normal paths
**Depends on:** 21, 22, 23, 24 · **Files:** `packages/core/src/engine/run.ts`, `packages/cli/`

**Build:** replace the skeleton loop with the reducer-driven engine reading the full
`pipeline.yaml`. Remove `pipeline.skeleton.yaml` support.

**Done when:**
- The approve, gate-fail, revise, and unrouted golden scenarios pass on FakeRuntime.
- The live view (step 17) still passes its tests.

### Step 27 — Engine v1: escalations
**Depends on:** 25, 26 · **Files:** `packages/core/src/engine/`

**Build:** blocked, timeout, missing verdict, max rounds, and guard violation, wired to the
diff guard.

**Done when:**
- Every escalation golden scenario passes on FakeRuntime.

### Step 28 — Pause, resume, stop
**Depends on:** 27 · **Files:** `packages/core/src/engine/`, `packages/cli/`

**Build:** resume per R12, stop per R13, and the CLI commands `pipeline resume` and
`pipeline stop`.

**Done when:**
- The resume and stop golden scenarios pass; resuming a finished run is refused with a clear
  message.

### Step 29 — Trust approval for pipelines
**Depends on:** 21, 22 · **Files:** `packages/core/src/trust.ts`, `packages/cli/`

**Build:** the trust rules from the security model. `pipeline run` on an untrusted or changed
pipeline shows the gate commands and agent launch commands and asks for approval;
non-interactive runs refuse; `pipeline trust` approves explicitly.

**Done when:**
- Tests: a new file asks; a trusted file runs; a file changed after trust asks again; a changed
  custom profile asks again.

### Step 30 — `pipeline init`
**Depends on:** 21, 22 · **Files:** `packages/cli/`

**Build:** checks for git, herdr, and each profile's command (reports, doesn't fail on missing
optional agents); writes the starter `pipeline.yaml`; adds `.pipeline/runs/` to `.gitignore`;
offers to install herdr integrations for detected agents.

**Done when:**
- Tests in a temp dir: first init creates the files; a second init changes nothing and says so;
  missing tools are listed with install hints.

### Step 31 — Fake agent and end-to-end on herdr
**Depends on:** 22, 28 · **Files:** `tools/fake-agent/`, `packages/runtime/test/it/`

**Build:** a scriptable fake agent CLI with a `fake-agent` profile using sentinel readiness.
Integration tests run golden scenarios in real herdr panes.

**Done when:**
- With `PIPELINE_HERDR_IT=1`, gate-fail-then-pass and revise-twice pass on real herdr, and their
  events match the FakeRuntime runs.

**What this step cannot establish.** A scriptable fake agent exercises the engine's conformance
through real herdr; it renders nothing a real Claude or Codex renders. Evidence about agent output
and turn attribution comes from step 04b, and ongoing compatibility with live agent CLIs from
step 32.

### Step 32 — Live test suite
**Depends on:** 31 · **Files:** `packages/runtime/test/live/`, `docs/test-live.md`

**Build:** `pnpm test:live`, run on demand (not in CI). For each built-in profile: launch,
prompt, detect settling, and parse a verdict. On failure, it saves the screen output as a new
fixture for triage.

**Done when:**
- `docs/test-live.md` explains when to run it (after updating any agent CLI) and how to turn a
  failure into a verdict-parser fixture.

---

## Phase 3 — Editor UI

Every UI step is verified with Playwright tests and saved screenshots, and uses the feedback in
`docs/ui-feedback.md`.

### Step 33 — UI app scaffold
**Depends on:** 17, 21 · **Files:** `packages/ui/`

**Build:** a Vite, React, and React Flow app served by `pipeline ui` (token flow unchanged). It
renders the real `pipeline.yaml` read-only with automatic layout and keeps the live run view.

**Done when:**
- Playwright: the reference pipeline shows 4 nodes and 5 edges with correct port labels.
- The step 17 tests still pass.

### Step 34 — Pipeline read and write API
**Depends on:** 15, 20, 21 · **Files:** `packages/server/src/pipeline.ts`

**Build:** `GET /api/pipeline` and `PUT /api/pipeline`. Writes are validated first and preserve
comments. A save through the authenticated UI updates the trust record.

**Done when:**
- An invalid PUT returns 400 with validation errors and leaves the file untouched; a valid PUT
  changes only the edited fields.

### Step 35 — Agent node inspector
**Depends on:** 33, 34 · **Files:** `packages/ui/src/inspector/agent*`

**Build:** name, profile, model, role briefing, permission, and verdict toggle; saves through the API.

**Done when:**
- Playwright: editing the role briefing changes only that field on disk; server validation
  errors appear next to the field.

### Step 36 — Gate and end inspectors
**Depends on:** 35 · **Files:** `packages/ui/src/inspector/gate*`, `end*`

**Build:** gate fields (name, command, timeout) and end fields (notify, leave uncommitted).

**Done when:**
- Playwright tests equivalent to step 35 pass for both node types.

### Step 37 — Permission badges
**Depends on:** 35, 22 · **Files:** `packages/ui/src/inspector/badge*`

**Build:** "Enforced via …" when the profile has a verified read-only flag set; "Prompt-only,
diff guard on" otherwise. The text comes from profile data.

**Done when:**
- Playwright: switching the profile updates the badge; a custom profile with no read-only flags
  shows the warning badge.

### Step 38 — Creating and deleting edges
**Depends on:** 33, 34 · **Files:** `packages/ui/src/canvas/edges*`

**Build:** ports rendered per node type; drag from a port to a node to create an edge; one edge
per port (dragging from a used port replaces its edge); delete an edge; unconnected ports shown
as "routes to you".

**Done when:**
- Playwright: creating, replacing, and deleting edges changes the `next` entries on disk exactly.

### Step 39 — Adding and deleting nodes
**Depends on:** 38 · **Files:** `packages/ui/src/canvas/nodes*`, toolbar

**Build:** add agent, gate, and end nodes; delete a node and its edges after confirmation.

**Done when:**
- Playwright: an added gate appears in the file with a unique id; deleting it removes it and
  its edges; deleting the start node is refused with a message.

### Step 40 — Edge inspector: message templates
**Depends on:** 38, 24 · **Files:** `packages/ui/src/inspector/edge*`

**Build:** clicking an edge shows its message template with a live preview using sample values.

**Done when:**
- Playwright: editing a template updates the file; an unknown placeholder shows a validation error.

### Step 41 — Run controls in the UI
**Depends on:** 28, 33 · **Files:** `packages/server/src/runs.ts`, `packages/ui/src/run/`

**Build:** `POST /api/runs` (start), `POST /api/runs/:id/stop`; Start and Stop buttons; the
Design/Run toggle.

**Done when:**
- Playwright with FakeRuntime: start from the UI, watch the states change, stop mid-run →
  status `stopped`.

### Step 42 — Escalations in the UI
**Depends on:** 41 · **Files:** `packages/server/src/runs.ts`, `packages/ui/src/run/`

**Build:** an escalation banner with the reason; Resume with the options from R12 (extra rounds,
accept or reject guard changes).

**Done when:**
- Playwright: the max-rounds scenario shows the banner, granting 2 extra rounds resumes the run,
  and the result matches the resume-with-extra-rounds golden scenario.

---

## Phase 4 — Release

### Step 43 — Documentation
**Depends on:** 42 · **Files:** `README.md`, `docs/`

**Build:** a README quick start (install → init → first fake-agent run in under 10 minutes), a
profile authoring guide, and a link to SPEC.md.

**Done when:**
- The reviewer follows the README literally on a clean machine with herdr installed and
  completes a fake-agent run.

### Step 44 — Name and packaging
**Depends on:** 43 · **Files:** `package.json` files, release workflow · **Sign-off: you**

**Build:** the final project name, and an npm package for the CLI with the UI bundled.

**Done when:**
- The package installs globally and `<name> --version` works.

---

## Deliberately out of v1

Fan-out (one port to several nodes), parallel pipelines, worktree isolation per agent,
surviving a herdr server restart mid-run, a profile manager UI, run history browsing, remote
machines, and runtimes other than herdr (the RuntimeAdapter interface keeps that possible).

## Known risks to watch

- **herdr CLI details** are assumptions until step 02 confirms them. Steps 11–13 depend on those notes.
- **Read-only enforcement per agent** is an assumption until step 03 confirms it. Nothing is
  labeled "enforced" without evidence.
- **Verdict parsing from screen output** is the most fragile part. Step 04 grounds it in real
  output, and step 32 catches breakage after agent updates. Add a fixture every time a real run breaks it.
- **Engine-in-a-pane** depends on how a process detects herdr (step 02). If that's unreliable,
  fall back to requiring `pipeline run` to be started inside a herdr pane.
