import type { spawn } from 'node:child_process';

import type {
  DeadlineEpochMs,
  ExecutionId,
  LayoutSpec,
  PaneId,
  ProcessLaunch,
  ProcessObservation,
  ProcessSpec,
  RuntimeAdapter,
} from '../adapter.js';
import type { HerdrOptions } from './cli.js';
import { createLayout } from './layout.js';
import { createGateRunner } from './process.js';

/**
 * The herdr-backed runtime, as far as it goes.
 *
 * A `Pick` rather than a `RuntimeAdapter`, because the agent half is step 12's. Every parameter of
 * every method named here is implemented; nothing is accepted and ignored. Naming the four honestly
 * is better than presenting a `RuntimeAdapter` with three methods missing.
 */
export type HerdrRuntime = Pick<
  RuntimeAdapter,
  'createLayout' | 'startProcess' | 'observeProcess' | 'shutdown'
>;

/**
 * Explicit rather than the two internal option bags, so the public surface says exactly what a
 * caller may set.
 *
 * Neither a deadline nor a cancellation signal belongs here, and both are refused. A runtime is
 * built once and used many times, while {@link HerdrOptions.deadline} is one absolute instant and
 * {@link HerdrOptions.signal} one cancellation: held at this level they would bound not a call but
 * every call the runtime ever makes, expiring partway through a session that was going fine.
 *
 * Bounding is therefore the caller's: a caller that stops waiting stops waiting, and that is all it
 * does. Ending the work is {@link HerdrRuntime.shutdown}, which cancels this runtime's in-flight
 * CLI children — and only those.
 */
export interface HerdrRuntimeOptions {
  /** How the herdr CLI is invoked for layout work. Bounding and cancellation are not settings. */
  readonly herdr?: Omit<HerdrOptions, 'signal' | 'deadline'>;
  /** The shell that interprets a gate's command. Defaults to `/bin/sh`. */
  readonly shell?: string;
  /** Raw bytes across both of a gate's streams before its result is refused rather than truncated. */
  readonly outputLimit?: number;
  /** How a gate child is started. A seam, so a test need never run a real process. */
  readonly spawn?: typeof spawn;
  /** The clock deadlines are measured against. A seam, for the reason `spawn` is one. */
  readonly now?: () => number;
}

export function createHerdrRuntime(options: HerdrRuntimeOptions = {}): HerdrRuntime {
  // The gate fields sit at the top level of the options, so they pass straight through.
  const runner = createGateRunner(options);
  /**
   * What actually reaches the CLI.
   *
   * `Omit` is a claim the compiler checks at one call site and nowhere else: a wider object
   * assigned to this parameter keeps its extra properties, and a JavaScript caller was never
   * checked at all. Both are removed here, so no path through this runtime can impose either.
   * A denylist rather than a list of what to keep, so a field added to `HerdrOptions` later is
   * forwarded rather than silently dropped.
   */
  const forwarded = ((): Omit<HerdrOptions, 'signal' | 'deadline'> => {
    const copy: Record<string, unknown> = { ...options.herdr };
    delete copy['deadline'];
    delete copy['signal'];
    return copy as Omit<HerdrOptions, 'signal' | 'deadline'>;
  })();
  /**
   * Layout work runs herdr CLI children that belong to this adapter. Shutdown ends *those*, and
   * nothing else: the herdr server, the panes and workspaces already created, the agents in them
   * and the gate commands all keep running, as SPEC R13 requires callers to assume.
   */
  const own = new AbortController();
  /** Layout calls still in flight. Shutdown is not finished while any of them is still ending. */
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let cleanup: Promise<void> | undefined;

  return {
    createLayout(spec: LayoutSpec): Promise<PaneId> {
      // Refused before anything is invoked, and with the plain error FakeRuntime gives, so the two
      // runtimes fail the same way. `LayoutError` would be a lie: it reports what a call created.
      if (closed) return Promise.reject(new Error('createLayout after shutdown'));
      // Registered *before* anything is invoked. The supplied herdr runner is called synchronously
      // from inside the layout call, so a runner that shuts this runtime down right there must find
      // the operation already tracked rather than an empty set.
      let ended: () => void = () => undefined;
      const ending = new Promise<void>((resolve) => {
        ended = resolve;
      });
      inFlight.add(ending);
      void ending.then(() => inFlight.delete(ending));

      const work = createLayout(spec, { ...forwarded, signal: own.signal });
      // Followed through a separate settlement, so knowing when the call ends neither handles the
      // caller's rejection for them nor alters it: `work` is returned exactly as it came.
      void work.then(ended, ended);
      return work;
    },

    startProcess(
      spec: ProcessSpec,
      deadline: DeadlineEpochMs,
      signal?: AbortSignal,
    ): ProcessLaunch {
      return runner.start(spec, deadline, signal);
    },

    observeProcess(
      executionId: ExecutionId,
      deadline: DeadlineEpochMs,
      signal?: AbortSignal,
    ): Promise<ProcessObservation> {
      return runner.observe(executionId, deadline, signal);
    },

    shutdown(): Promise<void> {
      if (cleanup !== undefined) return cleanup;
      // Closed first, so a layout call arriving while cleanup runs is refused rather than slipping
      // in behind it and being tracked by nothing.
      closed = true;
      // The shared promise is put in place *before* any callback can fire. Abort listeners run
      // synchronously, so a listener that calls shutdown() again does so while this call is still
      // on the stack, and it must receive this promise rather than start a second cleanup.
      let settle: (done: Promise<void>) => void = () => undefined;
      cleanup = new Promise<void>((resolve) => {
        settle = resolve;
      });
      // Waiters are released at once; the herdr children then get as long as they need to end.
      const gate = runner.shutdown();
      own.abort();
      settle(Promise.all([gate, ...inFlight]).then(() => undefined));
      return cleanup;
    },
  };
}
