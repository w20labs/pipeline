# Rules for the implementer

_Claude Code reads this file; other agents read `AGENTS.md`. Both carry the same rules — change them together._

Pipeline is built one step at a time from `PLAN.md`: one agent implements a step, a second
agent reviews it. These are the rules for the implementing agent.

- Implement only the current step. Write ideas for later in `docs/ideas.md` instead of building
  them.
- Touch only the files listed under "Files", plus tests and fixtures for them. If another file
  must change, say which and why in the summary.
- **Size limit:** if the diff grows past about 400 changed lines (excluding lockfiles, fixtures,
  and generated files), stop and propose how to split the step instead of continuing.
- Every step ends with `pnpm lint && pnpm test` passing. `pnpm lint` type-checks test files
  too, so a test must compile under the same strict settings as the code it exercises; put
  new tests under a package's `src/` or `test/` or nothing will check them.
- No new dependency without naming it in the summary with one line of justification.
- Never commit. Stop when finished and summarize what changed and how to verify it.

A step is done only when the reviewer answers `VERDICT: APPROVE`. The reviewer does not modify
code; it reports findings with `file:line` references, most severe first, and runs every command
in the step's "Done when" list.
