/**
 * The contract every runtime must satisfy: a fake driven by golden scenarios (step 07b) and the
 * herdr-backed runtime (step 12). It carries no policy. Deciding outcomes, routing, parsing
 * verdicts, checking the read-only guard and writing events all belong to the engine; this
 * interface only reports what was observed, and reports uncertainty as uncertainty.
 *
 * Shaped by docs/SPEC.md R4-R7 and R12, and by the spike findings in docs/herdr-notes.md and
 * docs/output-capture.md.
 */

/** A terminal pane. Panes are created by {@link RuntimeAdapter.createLayout}. */
export type PaneId = string & { readonly __brand: 'PaneId' };

/**
 * Identity of one agent turn: one prompt submission and everything observed about it.
 * Stable across cancellation, timeout and resumed observation, so a turn that timed out can be
 * watched again without re-prompting (SPEC R12).
 */
export type TurnId = string & { readonly __brand: 'TurnId' };

/** Identity of one gate execution. Stable on the same terms as {@link TurnId}. */
export type ExecutionId = string & { readonly __brand: 'ExecutionId' };

/**
 * An absolute deadline in epoch milliseconds, on the same clock as `Date.now()`.
 *
 * Absolute rather than a duration on purpose. Observation is resumable, and a duration would
 * silently restart the budget every time the caller resumed watching: to keep watching an
 * existing turn the caller passes the *same* value it passed before, so receiving `unconfirmed`
 * and looking again cannot extend the turn. Only an accepted resume computes a new deadline
 * (`Date.now() + turn_timeout`), which is what SPEC R12 requires.
 */
export type DeadlineEpochMs = number;

/**
 * Where a new pane goes. Always explicit: an implementation MUST NOT create a pane relative to
 * whatever is focused. Creating with no target was observed to mutate the operator's focused
 * workspace (docs/herdr-notes.md, "Cleanup, and one accident").
 */
export type LayoutDestination =
  /** Create and take ownership of a fresh workspace. The runtime owns everything it puts there. */
  | { readonly kind: 'new_workspace' }
  /** An existing workspace, named by the caller. */
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  /** Split an existing pane the caller already holds. */
  | { readonly kind: 'split'; readonly pane: PaneId; readonly direction: 'right' | 'down' };

/** Where and how to create a pane. */
export interface LayoutSpec {
  /** Required. There is no "current" or default destination. */
  readonly destination: LayoutDestination;
  /** Working directory for the pane's shell. */
  readonly cwd: string;
  /** Human-readable label, used for the tab or pane title. */
  readonly label: string;
}

/**
 * A launched agent. The pane always identifies it; the runtime-assigned name may be absent.
 *
 * A start that exceeded its deadline can leave a live agent whose name was never registered
 * (docs/herdr-notes.md, agent start). Such an agent is addressed by pane alone, so `name` is
 * optional rather than a lie.
 */
export interface AgentHandle {
  readonly pane: PaneId;
  readonly name?: string;
}

/**
 * Outcome of {@link RuntimeAdapter.launchAgent}.
 *
 * `startup_unconfirmed` is not "nothing launched". A start that exceeds its deadline may still
 * produce a running agent moments later, and in that case the runtime never registered the name
 * (docs/herdr-notes.md, agent start). The pane is therefore returned so the caller can inspect or
 * adopt whatever is there. The adapter MUST NOT answer a startup dialog or relaunch on its own.
 */
export type LaunchResult =
  | { readonly kind: 'ready'; readonly agent: AgentHandle }
  /**
   * The agent exists and is addressable, but its readiness is not established and it cannot be
   * prompted. A startup dialog is the common case; a state that is simply not promptable — busy,
   * or reported as unknown — arrives here too, with `detail` saying which was observed.
   *
   * The finer distinction is {@link inspectAgent}'s: {@link AgentInspection} separates a dialog
   * from working from undetermined, and is the recovery path for deciding what to do next.
   */
  | { readonly kind: 'not_ready'; readonly agent: AgentHandle; readonly detail: string }
  /** Readiness could not be established before the deadline. Whether anything launched is unknown. */
  | { readonly kind: 'startup_unconfirmed'; readonly pane: PaneId; readonly detail: string };

/**
 * What a pane holds, without launching anything.
 *
 * Recognition, readiness and existence are reported separately, because the underlying CLI
 * conflates them behind a single error code (docs/herdr-notes.md, Q4).
 *
 * Note what `no_agent` does *not* mean. It establishes only that no agent was recognised in that
 * pane. Something may well be running there: an unrecognised process reports exactly this, and the
 * spike produced it with an ordinary `node` REPL occupying the pane. Nothing here licenses a caller
 * to conclude the pane is idle, free to reuse, or that a previously launched agent has exited.
 */
export type AgentInspection =
  | { readonly kind: 'ready'; readonly agent: AgentHandle }
  /** An agent is there but waiting at a dialog. Re-inspect after the operator answers it. */
  | { readonly kind: 'not_ready'; readonly agent: AgentHandle; readonly detail: string }
  /**
   * The agent is recognised and the pane is fine, but its readiness is not established and no
   * dialog explains why. Distinct from `not_ready`, which names a dialog, and from `no_agent`.
   *
   * This is a real observed state, not a defensive case: a recognised agent can report a lifecycle
   * status of `unknown` (test/fixtures/herdr/pane-get/known-agent-unknown.stdout, where `agent` is
   * `claude` and `agent_status` is `unknown`). Waiting on it for the ordinary settled states times
   * out while waiting explicitly for `unknown` succeeds (test/fixtures/herdr/agent-wait/), so the
   * caller must be told that readiness is simply undetermined rather than absent.
   */
  | { readonly kind: 'state_unknown'; readonly agent: AgentHandle; readonly detail: string }
  /**
   * The agent is recognised and actively working. It exists and is healthy, but is mid-turn and
   * cannot take a prompt; the caller waits rather than treating this as an error or a free pane.
   */
  | { readonly kind: 'working'; readonly agent: AgentHandle }
  /**
   * The pane exists and no agent was recognised in it: no `agent` field at all, rather than an
   * agent in an unknown state. See the note above — this does not mean the pane is idle.
   */
  | { readonly kind: 'no_agent'; readonly pane: PaneId }
  /**
   * Established absence: the runtime confirmed this pane does not exist. Reserved for that answer
   * alone. An inspection that simply failed to conclude is `timed_out` or `cancelled`, never this.
   */
  | { readonly kind: 'unknown_pane'; readonly pane: PaneId }
  /** The deadline passed before inspection concluded. Says nothing about what the pane holds. */
  | { readonly kind: 'timed_out'; readonly pane: PaneId }
  /** The caller aborted the inspection. Distinct from a timeout; claims nothing. */
  | { readonly kind: 'cancelled'; readonly pane: PaneId };

/**
 * What was observed about an agent turn.
 *
 * `settled` is the only variant that means the turn completed. It requires text attributable to
 * *this* turn; a lifecycle state of idle or done, pane occupancy, a successful CLI exit status and
 * an advancing lifecycle counter do not, alone, establish completion (docs/output-capture.md).
 *
 * `unconfirmed` records exactly that situation: the runtime saw something that looked settled but
 * has no attributable answer. It is not an outcome and never means `missing_verdict`. The turn
 * stays pending until a later observation settles it or its deadline passes.
 */
export type AgentObservation =
  | { readonly kind: 'settled'; readonly turnId: TurnId; readonly text: string }
  /** Waiting at a permission or approval dialog. The turn is still live. */
  | { readonly kind: 'blocked'; readonly turnId: TurnId; readonly detail: string }
  /** Looked settled, but no text belongs to this turn. Still pending. */
  | { readonly kind: 'unconfirmed'; readonly turnId: TurnId; readonly detail: string }
  /** The deadline passed with no result. The prompt may still have been delivered. */
  | { readonly kind: 'timed_out'; readonly turnId: TurnId }
  /** Observation was cancelled by the caller. Distinct from a timeout: nothing about the turn is claimed. */
  | { readonly kind: 'cancelled'; readonly turnId: TurnId }
  /**
   * The turn cannot be observed at all: the id is unknown to this runtime, or its state was lost.
   * Never reported as a timeout — SPEC R12 requires a resume that cannot identify its execution to
   * be refused and the run left paused, which the engine can only do if it is told the difference.
   */
  | {
      readonly kind: 'unrecoverable';
      readonly turnId: TurnId;
      readonly reason: 'unknown_turn' | 'state_lost';
    };

/**
 * What was observed about a gate execution.
 *
 * `completed` carries a real process exit status and its output, which may be an empty string.
 * `timed_out` carries neither: a runtime that cannot obtain an exit status MUST NOT invent one,
 * because SPEC R7 routes on it. A timeout is not a failure and never triggers a rerun.
 */
export type ProcessObservation =
  | {
      readonly kind: 'completed';
      readonly executionId: ExecutionId;
      readonly exitStatus: number;
      readonly output: string;
    }
  | { readonly kind: 'timed_out'; readonly executionId: ExecutionId }
  | { readonly kind: 'cancelled'; readonly executionId: ExecutionId }
  /** Unknown or lost execution. Never a fabricated timeout, for the same reason as agent turns. */
  | {
      readonly kind: 'unrecoverable';
      readonly executionId: ExecutionId;
      readonly reason: 'unknown_execution' | 'state_lost';
    }
  /**
   * The execution ended in a way that produced no exit status, so none is invented.
   *
   * `spawn_failed` means nothing ran at all; `signal_terminated` means it ran and was killed, with
   * the signal named in `detail`; `output_limit_exceeded` means its output outgrew what this
   * runtime will hold, so the result cannot be reported in full and is not reported in part. All
   * three carry a diagnostic `detail`, because the reason alone does not say enough to act on.
   */
  | {
      readonly kind: 'unrecoverable';
      readonly executionId: ExecutionId;
      readonly reason: 'spawn_failed' | 'signal_terminated' | 'output_limit_exceeded';
      readonly detail: string;
    };

/**
 * Text belonging to one turn.
 *
 * Absence is never an empty string: an unknown turn, a turn that has not settled, and a turn whose
 * text was not retained are each reported explicitly, so a caller cannot mistake "no answer yet"
 * for "answered with nothing".
 */
export type AgentOutput =
  | { readonly kind: 'available'; readonly turnId: TurnId; readonly text: string }
  | {
      readonly kind: 'unavailable';
      readonly turnId: TurnId;
      readonly reason: 'unknown_turn' | 'not_settled' | 'not_retained';
    };

/**
 * How a submission fared. Separate from what the turn or execution then does.
 *
 * `unconfirmed` is the case the spikes actually produced: a submission reported as stalled, and a
 * submission that returned success with no answer present, both left delivery unknown
 * (docs/output-capture.md). The caller MUST NOT resend on it — the prompt may well have arrived.
 */
export type SubmissionOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'unconfirmed'; readonly detail: string }
  /**
   * Dispatch definitely did not start: nothing ran, and `detail` says why. Distinct from
   * `unconfirmed`, where delivery is unknown — here there is nothing to double-submit.
   */
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'cancelled' };

/**
 * A submission in flight. `turnId` is available **before any external I/O**: the runtime registers
 * the turn locally and returns synchronously, so a caller whose acknowledgement stalls still holds
 * the handle it needs to observe, cancel or recover.
 */
export interface AgentSubmission {
  readonly turnId: TurnId;
  /** Settles when submission is accepted, cannot be confirmed, or is cancelled. */
  readonly submitted: Promise<SubmissionOutcome>;
}

/** A gate launch in flight, on the same terms as {@link AgentSubmission}. */
export interface ProcessLaunch {
  readonly executionId: ExecutionId;
  readonly started: Promise<SubmissionOutcome>;
}

/** What to run for a gate. */
export interface ProcessSpec {
  /**
   * The pipeline node this execution belongs to — identity, not decoration.
   *
   * Two gate nodes may legitimately share a command and a working directory, and their results must
   * never be confused, so the caller names the node rather than leaving a runtime to guess it from
   * the command. Display labels are a separate concern and are not identity.
   */
  readonly node: string;
  readonly command: string;
  readonly cwd: string;
}

export interface RuntimeAdapter {
  /** Create a pane. Every target is named explicitly; nothing is created relative to focus. */
  createLayout(spec: LayoutSpec): Promise<PaneId>;

  /**
   * Start an agent in an existing pane. Never creates, splits or moves panes, and never answers a
   * startup dialog. Resolves once readiness is established or `deadline` passes.
   */
  launchAgent(pane: PaneId, profile: string, deadline: DeadlineEpochMs): Promise<LaunchResult>;

  /**
   * Report what a pane holds. Launches nothing, answers no dialog, and never relaunches.
   *
   * This is the recovery path for {@link LaunchResult} `startup_unconfirmed`: the caller adopts
   * whatever is in the pane, obtaining an {@link AgentHandle} that may have no name. It is also how
   * readiness is re-checked after an operator clears a startup dialog, without a second
   * {@link launchAgent}.
   */
  inspectAgent(
    pane: PaneId,
    deadline: DeadlineEpochMs,
    signal?: AbortSignal,
  ): Promise<AgentInspection>;

  /**
   * Submit a prompt. **Synchronous**, and returns before any external I/O: the turn is registered
   * locally first, so {@link AgentSubmission.turnId} exists even if dispatch then stalls. Waiting
   * on the turn is a separate call.
   *
   * `signal` cancels the submission; `deadline` bounds it. Neither says anything about the turn.
   */
  promptAgent(
    agent: AgentHandle,
    prompt: string,
    deadline: DeadlineEpochMs,
    signal?: AbortSignal,
  ): AgentSubmission;

  /**
   * Watch an existing turn until it settles, blocks, is found unconfirmed, hits `deadline`, or is
   * cancelled via `signal`. Submits nothing: this is the method that continues watching after
   * `blocked`, `unconfirmed` or `timed_out`, preserving the same {@link TurnId} (SPEC R12).
   *
   * Pass the turn's original deadline to keep watching on the existing budget; pass a new one only
   * for an accepted resume.
   */
  observeAgentTurn(
    turnId: TurnId,
    deadline: DeadlineEpochMs,
    signal?: AbortSignal,
  ): Promise<AgentObservation>;

  /**
   * Text attributable to `turnId` and to no other turn: reading a turn MUST NOT return an earlier
   * turn's answer from shared scrollback. Text is returned raw, with terminal decoration intact —
   * stripping it is the parser's job in step 08.
   *
   * A settled turn's text stays readable without re-prompting, so a run that paused and resumed can
   * recover the answer it already has.
   */
  readAgentOutput(turnId: TurnId): Promise<AgentOutput>;

  /** Start a gate command. Synchronous and identity-first, on the same terms as {@link promptAgent}. */
  startProcess(spec: ProcessSpec, deadline: DeadlineEpochMs, signal?: AbortSignal): ProcessLaunch;

  /**
   * Watch an existing execution. Launches nothing; a second call never re-runs the command.
   *
   * A completed result is retained and replayed: observing a finished execution again returns the
   * same `completed` result, with the same exit status and output, for as long as the runtime holds
   * it. That is what lets a paused run recover a gate result on resume without rerunning the gate
   * (SPEC R12). Once the result is no longer held, the answer is `unrecoverable`, never a timeout.
   *
   * After {@link shutdown} a result the runtime still holds is replayed as usual — shutdown ends
   * waiting, not memory. An execution that has not ended is `cancelled`, whatever `deadline` says,
   * because no new wait is installed for it; a caller that wants a result arriving later looks
   * again rather than waiting here.
   */
  observeProcess(
    executionId: ExecutionId,
    deadline: DeadlineEpochMs,
    signal?: AbortSignal,
  ): Promise<ProcessObservation>;

  /**
   * Stop observing everything and release the adapter's own resources.
   *
   * Settles every outstanding observation promptly with its `cancelled` variant, and is idempotent.
   *
   * Pending submissions settle the same way: an in-flight {@link AgentSubmission.submitted} or
   * {@link ProcessLaunch.started} resolves `cancelled`, and its id stays valid, so a caller can
   * still record which turn or execution it had already registered. A cancelled submission does not
   * mean the prompt failed to arrive.
   *
   * It does **not** terminate agents or commands: they keep running and may keep writing to the
   * working tree, which SPEC R13 requires callers to assume. Panes and workspaces already created
   * are left in place too; only the adapter's own clients are released.
   *
   * Afterwards {@link createLayout} is refused outright rather than creating something nothing will
   * own, and {@link startProcess} starts nothing.
   */
  shutdown(): Promise<void>;
}
