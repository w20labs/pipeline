/**
 * Composing a run: the lock first, then the bootstrap manifest, then whatever the caller supplies.
 *
 * Both are the run's own preconditions: nothing supplied runs until this run holds the lock and the
 * manifest it was given validates. The bootstrap session itself, the agent launches and everything
 * they need are not composed here, so this is still not a complete research run.
 *
 * Everything the run depends on is copied before the first await, and the same copy reaches both
 * the lock phase and the runner: a caller changing its configuration, its list or a phase object
 * while the run is under way cannot make the lock identify a different run or directory.
 */
import type { spawn as nodeSpawn } from 'node:child_process';

import { readControlFile } from './control-file.js';
import { type LockDeps, lockPhase } from './lock-phase.js';
import { manifestPhase } from './manifest.js';
import { quiescencePhase } from './quiescence-phase.js';
import type { SnapshotDiff } from './snapshot-diff.js';
import { snapshotPhase } from './snapshot-phase.js';
import type { Snapshot } from './snapshot.js';
import type { LockOwner } from './lock.js';
import {
  nodeRunnerFs,
  type Phase,
  type RunConfig,
  type RunnerFs,
  type RunResult,
  runResearch,
} from './runner.js';

const RESERVED = ['lock', 'manifest', 'snapshot', 'quiescence'] as const;

/** What a supplied phase may ask the run about. Frozen, and answering from the phase that owns it. */
export interface RunContext {
  /** The baseline exactly as taken — partial entries included — or `undefined` before the walk. */
  readonly baseline: () => Snapshot | undefined;
  /** The second walk, once quiescence has taken one. */
  readonly second: () => Snapshot | undefined;
  /** What the two walks differed in, when they were compared at all. */
  readonly comparison: () => SnapshotDiff | undefined;
}
/** Phases to run after the run's own, or a function given the context once, before the run starts. */
export type SuppliedPhases = readonly Phase[] | ((context: RunContext) => readonly Phase[]);

const FAILED = 'failed';

type Settler = (ok: () => void, failed: () => void) => unknown;
const quietly = (work: unknown, then: Settler) =>
  then.call(
    work,
    () => undefined,
    () => undefined,
  );

/**
 * Whether the value is a thenable, and if so, observed. `then` is read once and called with
 * handlers, and what that call returns is observed too: an `async then` rejects the promise it
 * returns, which promise adoption would discard, leaving that rejection unhandled.
 *
 * What this covers is the value itself and the promise its `then` returned. It cannot contain
 * arbitrary work a caller starts — a `then` that schedules its own chain, or a timer that rejects
 * something later, is beyond any boundary here. Reading or calling `then` may throw; the caller
 * runs this inside its own guard, where a throw means the same as any other malformed value.
 */
const observedThenable = (value: unknown): boolean => {
  const then = (value as { then?: unknown } | null | undefined)?.then;
  if (typeof then !== 'function') return false;
  const returned: unknown = quietly(value, then as Settler);
  // never re-read value.then: what came back is a separate object with its own settlement
  const settling = (returned as { then?: unknown } | null | undefined)?.then;
  if (typeof settling === 'function') quietly(returned, settling as Settler);
  return true;
};

/**
 * Calls the caller's code, if any, and copies what it returns — all inside one boundary. Each
 * entry's `name`, `run` and `cleanup` is read exactly once here, so a throwing getter is a
 * malformed value like any other, and nothing the caller wrote is repeated.
 */
const supplyPhases = (
  supplied: SuppliedPhases | undefined,
  context: RunContext,
): Phase[] | typeof FAILED => {
  try {
    const list: unknown = typeof supplied === 'function' ? supplied(context) : (supplied ?? []);
    if (observedThenable(list)) return FAILED; // an async callback: refused, never awaited
    if (!Array.isArray(list)) return FAILED;
    const copied: Phase[] = [];
    for (const entry of list as unknown[]) {
      if (typeof entry !== 'object' || entry === null) return FAILED;
      const { name, run, cleanup } = entry as Partial<Phase>;
      if (typeof name !== 'string' || typeof run !== 'function') return FAILED;
      if (cleanup !== undefined && typeof cleanup !== 'function') return FAILED;
      copied.push(
        Object.freeze({
          name,
          run: run.bind(entry),
          ...(cleanup === undefined ? {} : { cleanup: cleanup.bind(entry) }),
        }),
      );
    }
    return copied;
  } catch {
    return FAILED;
  }
};

export interface ResearchRunOptions {
  /** Phases to run after the lock, in order. The lock is always first and cannot be replaced. */
  readonly after?: SuppliedPhases;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  /**
   * Dependency injection for the lock wrappers: whatever is given here is used in their place, so
   * a caller can replace acquisition or release outright. Tests wrap the real ones by choice; that
   * is their decision, not a guarantee this seam makes.
   */
  readonly lock?: Pick<LockDeps, 'acquire' | 'release'>;
  readonly fs?: RunnerFs;
  readonly now?: () => number;
}

/** The runner's own shape for a run that never started, built here so nothing is thrown at a caller. */
const refusedBeforeStart = (names: readonly string[], why: string): RunResult => ({
  outcome: { name: 'start', status: 'refused', why },
  phases: names.map((name) => ({ name, status: 'not_run', why: 'the run did not start' })),
  cleanupDiagnostics: [],
  summary: {
    written: false,
    stage: 'not_attempted',
    why: 'the run did not start; nothing was written',
  },
});

export const researchRun = async (
  config: RunConfig,
  options: ResearchRunOptions = {},
): Promise<RunResult> => {
  // copied before anything is awaited: field by field, and each phase with its methods bound
  const c: RunConfig = Object.freeze({
    runId: config.runId,
    runsRoot: config.runsRoot,
    researchConfig: config.researchConfig,
    operatorClaudeDir: config.operatorClaudeDir,
    scratch: config.scratch,
    controlDir: config.controlDir,
    budgetMs: config.budgetMs,
    cleanupReserveMs: config.cleanupReserveMs,
  });
  const supplied = options.after; // read before any caller code runs, with everything else
  // the methods too, bound to the object that supplied them: replacing one mid-run changes nothing
  const given = options.fs ?? nodeRunnerFs;
  const fs: RunnerFs = Object.freeze({
    mkdirExclusive: given.mkdirExclusive.bind(given),
    writeSummary: given.writeSummary.bind(given),
  });
  const now = options.now ?? Date.now;
  const python = options.python;
  const spawn = options.spawn;
  // read once, both functions captured: replacing either afterwards reaches no run already under way
  const injected = options.lock;
  const acquire = injected?.acquire;
  const release = injected?.release;

  const owner: LockOwner = Object.freeze({
    runId: c.runId,
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
  });
  // captured with everything else, so the reader cannot be redirected once the run is under way
  const bounds = Object.freeze({
    ...(python === undefined ? {} : { python }),
    ...(spawn === undefined ? {} : { spawn }),
    now,
  });
  const lock = lockPhase(
    { controlDir: c.controlDir, owner },
    {
      now,
      ...(python === undefined ? {} : { python }),
      ...(spawn === undefined ? {} : { spawn }),
      ...(acquire === undefined ? {} : { acquire }),
      ...(release === undefined ? {} : { release }),
    },
  );
  const manifest = manifestPhase(
    { controlDir: c.controlDir, researchConfig: c.researchConfig },
    (dir, name, readOptions) => readControlFile(dir, name, { ...readOptions, ...bounds }),
  );
  const snapshot = snapshotPhase({ root: c.researchConfig }, bounds);
  const quiescence = quiescencePhase(
    { root: c.researchConfig, baseline: () => snapshot.taken() },
    bounds,
  );

  // caller code runs only now, with every input already captured, and exactly once
  const context: RunContext = Object.freeze({
    baseline: () => snapshot.taken(),
    second: () => quiescence.taken(),
    comparison: () => quiescence.comparison(),
  });
  const after = supplyPhases(supplied, context);
  const built = RESERVED.map((name) => name);
  if (after === FAILED) return refusedBeforeStart(built, 'the supplied phases could not be built');
  const claimed = after.find((p) => (RESERVED as readonly string[]).includes(p.name));
  if (claimed !== undefined)
    return refusedBeforeStart(
      [...built, ...after.map((p) => p.name)],
      `a supplied phase may not be named ${claimed.name}`,
    );
  return runResearch(c, [lock, manifest, snapshot.phase, quiescence.phase, ...after], fs, now);
};
