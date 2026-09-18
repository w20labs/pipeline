/**
 * Composing a run: the lock phase first, then whatever else the caller supplies.
 *
 * Lock-only by design. The bootstrap manifest, the agent launches and everything they need are not
 * composed here, so a run assembled by this module is not a complete research run — it establishes
 * who holds the lock and nothing more.
 *
 * Everything the run depends on is copied before the first await, and the same copy reaches both
 * the lock phase and the runner: a caller changing its configuration, its list or a phase object
 * while the run is under way cannot make the lock identify a different run or directory.
 */
import type { spawn as nodeSpawn } from 'node:child_process';

import { type LockDeps, lockPhase } from './lock-phase.js';
import type { LockOwner } from './lock.js';
import {
  nodeRunnerFs,
  type Phase,
  type RunConfig,
  type RunnerFs,
  type RunResult,
  runResearch,
} from './runner.js';

const LOCK = 'lock';

export interface ResearchRunOptions {
  /** Phases to run after the lock, in order. The lock is always first and cannot be replaced. */
  readonly after?: readonly Phase[];
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
  const after: readonly Phase[] = Object.freeze(
    (options.after ?? []).map((p) =>
      Object.freeze({
        name: p.name,
        run: p.run.bind(p),
        ...(p.cleanup === undefined ? {} : { cleanup: p.cleanup.bind(p) }),
      }),
    ),
  );
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

  if (after.some((p) => p.name === LOCK))
    return refusedBeforeStart(
      after.map((p) => p.name),
      `a supplied phase may not be named ${LOCK}`,
    );

  const owner: LockOwner = Object.freeze({
    runId: c.runId,
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
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
  return runResearch(c, [lock, ...after], fs, now);
};
