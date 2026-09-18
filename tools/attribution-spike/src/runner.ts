import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * The research run's skeleton: phases in a fixed order under one absolute budget, cleanup inside
 * that budget, and a summary written last. Every external effect arrives through `RunnerFs` and the
 * phases themselves; nothing here launches, locks or reads the research configuration.
 *
 * **One deadline.** `deadline = start + budgetMs`. Creating the run directory and every phase must
 * finish by `deadline − cleanupReserveMs`; the reserve covers cleanups and the summary, which must
 * finish by `deadline`. A timed-out step buys no further time. Racing work only stops waiting for it:
 * a filesystem call or process may still finish later, so nothing that timed out is undone or
 * trusted, and a phase that starts processes must bound them itself with the deadline it is given.
 */

export interface RunConfig {
  readonly runId: string;
  /** Where run directories are created. Never inside the research configuration. */
  readonly runsRoot: string;
  readonly researchConfig: string;
  /** The operator's own Claude directory, named only so the research configuration can avoid it. */
  readonly operatorClaudeDir: string;
  readonly scratch: string;
  /** Holds the run lock, the bootstrap manifest and the process records. Separate from all of the above. */
  readonly controlDir: string;
  readonly budgetMs: number;
  readonly cleanupReserveMs: number;
}

export const CONTROL_FILES = Object.freeze({
  lock: 'run.lock',
  manifest: 'bootstrap.json',
  processes: 'processes.jsonl',
});

export interface RunnerFs {
  /** Create exactly this directory; throw if it exists. */
  readonly mkdirExclusive: (path: string) => Promise<void>;
  readonly writeSummary: (path: string, text: string) => Promise<void>;
}

/** Never recursive, never overwriting: an existing directory or summary is left exactly as it was. */
export const nodeRunnerFs: RunnerFs = {
  mkdirExclusive: async (path) => {
    await mkdir(path);
  },
  writeSummary: (path, text) => writeFile(path, text, { flag: 'wx' }),
};

export interface PhaseContext {
  readonly runDir: string;
  /** Absolute: the time by which phases must be done, leaving the cleanup reserve untouched. */
  readonly deadline: number;
}

/** A phase either completes with evidence, or refuses to let the run continue. Throwing is failure. */
export type PhaseResult =
  /** `evidence` is structure the phase established; a refusal may carry it too. */
  | { readonly kind: 'completed'; readonly evidence?: unknown }
  | { readonly kind: 'refused'; readonly why: string; readonly evidence?: unknown };

export interface Phase {
  readonly name: string;
  readonly run: (context: PhaseContext) => Promise<PhaseResult>;
  /** Registered once the phase starts, run in reverse order, whatever happened after. */
  readonly cleanup?: (deadline: number) => Promise<string | undefined>;
}

/**
 * When a started phase was observed to settle; for `timed_out`, when the run stopped waiting for it.
 * A phase that never started has no timestamps.
 */
interface Timed {
  readonly startedAt: number;
  readonly endedAt: number;
}

export type PhaseRecord =
  /** `evidence` is absent when the phase reported none: nothing is filled in on its behalf. */
  | (Timed & { readonly name: string; readonly status: 'completed'; readonly evidence?: unknown })
  | (Timed & {
      readonly name: string;
      readonly status: 'refused' | 'failed' | 'timed_out';
      readonly why: string;
      /** Only a refusing phase supplies this; nothing is filled in on its behalf. */
      readonly evidence?: unknown;
    })
  | { readonly name: string; readonly status: 'not_run'; readonly why: string };

export interface RunResult {
  /** The first phase that stopped the run, or `completed`. Never replaced by a cleanup failure. */
  readonly outcome:
    | { readonly kind: 'completed' }
    /** The run never started a phase: bad config, or the run directory was not created. */
    | { readonly name: 'start'; readonly status: 'refused'; readonly why: string }
    | Extract<PhaseRecord, { why: string }>;
  readonly phases: readonly PhaseRecord[];
  readonly cleanupDiagnostics: readonly string[];
  readonly summary:
    | { readonly written: true; readonly path: string }
    | {
        readonly written: false;
        readonly stage: 'not_attempted' | 'serialization' | 'write';
        readonly why: string;
      };
}

const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  // `..research` is a name inside the parent; only a whole `..` segment leaves it
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
/** Equal, or either inside the other. */
const overlap = (a: string, b: string): boolean => inside(a, b) || inside(b, a);
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

/**
 * Separation is lexical: the paths are compared as written. Directory ancestry is trusted, so this
 * cannot establish physical separation through symlinks; it only refuses configurations whose own
 * paths already overlap.
 */
export const configProblem = (c: RunConfig): string | undefined => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.runId)) return 'the run id must be a plain name';
  const paths = [c.runsRoot, c.researchConfig, c.operatorClaudeDir, c.scratch, c.controlDir];
  if (!paths.every((p) => isAbsolute(p) && !p.includes('\0'))) return 'every path must be absolute';
  if (overlap(c.operatorClaudeDir, c.researchConfig))
    return "the research configuration must be separate from the operator's Claude directory";
  if (overlap(c.researchConfig, c.runsRoot))
    return 'run directories must be separate from the research configuration';
  const protectedDirs: [string, string][] = [
    [c.researchConfig, 'the research configuration'],
    [c.operatorClaudeDir, "the operator's Claude directory"],
    [c.runsRoot, 'the run directories'],
  ];
  for (const [dir, what] of protectedDirs)
    if (overlap(c.controlDir, dir)) return `the control directory must be separate from ${what}`;
  // stated for the files themselves, so renaming one can never place it where a run writes
  for (const name of Object.values(CONTROL_FILES))
    if (protectedDirs.some(([dir]) => inside(dir, join(c.controlDir, name))))
      return 'a control file must not be inside a protected directory';
  if (!positive(c.budgetMs) || !positive(c.cleanupReserveMs) || c.cleanupReserveMs >= c.budgetMs)
    return 'the budget and cleanup reserve must be positive, with the reserve inside the budget';
  return undefined;
};

/**
 * Settles with `work`, or unsettled once `deadline` passes. The clock is checked before a result is
 * accepted, so work whose callback arrives late on a blocked event loop still counts as late.
 */
const until = <T>(work: Promise<T>, deadline: number, now: () => number) =>
  new Promise<{ settled: true; value: T } | { settled: false; error?: unknown }>((resolve) => {
    const timer = setTimeout(() => resolve({ settled: false }), Math.max(0, deadline - now()));
    const settle = (outcome: { settled: true; value: T } | { settled: false; error: unknown }) => {
      clearTimeout(timer);
      resolve(now() > deadline ? { settled: false } : outcome);
    };
    work.then(
      (value) => settle({ settled: true, value }),
      (error: unknown) => settle({ settled: false, error: error ?? 'threw' }),
    );
  });

const text = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const runResearch = async (
  config: RunConfig,
  phases: readonly Phase[],
  fs: RunnerFs,
  now: () => number = Date.now,
): Promise<RunResult> => {
  // Copied before anything else: a caller changing its config, its list or a phase object while the
  // run is under way must not move a path, a deadline or which work runs. Methods keep their object.
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
  const plan: readonly Phase[] = Object.freeze(
    phases.map((p) =>
      Object.freeze({
        name: p.name,
        run: p.run.bind(p),
        ...(p.cleanup === undefined ? {} : { cleanup: p.cleanup.bind(p) }),
      }),
    ),
  );
  const refusedBeforeStart = (why: string): RunResult => ({
    outcome: { name: 'start', status: 'refused', why },
    phases: plan.map((p) => ({ name: p.name, status: 'not_run', why: 'the run did not start' })),
    cleanupDiagnostics: [],
    summary: {
      written: false,
      stage: 'not_attempted',
      why: 'the run did not start; nothing was written',
    },
  });
  const problem = configProblem(c);
  if (problem !== undefined) return refusedBeforeStart(problem);

  const deadline = now() + c.budgetMs;
  const phaseDeadline = deadline - c.cleanupReserveMs;
  const runDir = join(c.runsRoot, c.runId);
  const created = await until((async () => fs.mkdirExclusive(runDir))(), phaseDeadline, now);
  // Either way the directory is left alone: an existing one may belong to another run, and one whose
  // creation timed out may still appear, and is not known to be ours.
  if (!created.settled)
    return refusedBeforeStart(
      'error' in created
        ? `the run directory could not be created: ${text(created.error)}`
        : 'the run directory was not created by its deadline; it may still appear',
    );

  const records: PhaseRecord[] = [];
  const cleanups: Phase[] = [];
  let stop: Extract<PhaseRecord, { why: string }> | undefined;
  for (const phase of plan) {
    if (stop !== undefined || now() >= phaseDeadline) {
      const why =
        stop === undefined || stop.status === 'not_run'
          ? 'the run budget was spent'
          : `the run stopped at ${stop.name}`;
      const skipped: PhaseRecord = { name: phase.name, status: 'not_run', why };
      records.push(skipped);
      stop ??= skipped; // required work did not run: never a completed run
      continue;
    }
    if (phase.cleanup !== undefined) cleanups.push(phase);
    const startedAt = now();
    const run = await until(
      (async () => phase.run({ runDir, deadline: phaseDeadline }))(),
      phaseDeadline,
      now,
    );
    const at = { startedAt, endedAt: now() };
    const record: PhaseRecord = run.settled
      ? run.value.kind === 'completed'
        ? {
            ...at,
            name: phase.name,
            status: 'completed',
            ...(run.value.evidence === undefined ? {} : { evidence: run.value.evidence }),
          }
        : {
            ...at,
            name: phase.name,
            status: 'refused',
            why: run.value.why,
            ...(run.value.evidence === undefined ? {} : { evidence: run.value.evidence }),
          }
      : 'error' in run
        ? { ...at, name: phase.name, status: 'failed', why: text(run.error) }
        : {
            ...at,
            name: phase.name,
            status: 'timed_out',
            why: 'the phase did not finish by its deadline',
          };
    records.push(record);
    if (record.status !== 'completed') stop = record;
  }

  const cleanupDiagnostics: string[] = [];
  for (const phase of cleanups.reverse()) {
    if (now() >= deadline) {
      cleanupDiagnostics.push(`${phase.name}: cleanup not run: the run budget was spent`);
      continue;
    }
    const cleaned = await until((async () => phase.cleanup?.(deadline))(), deadline, now);
    if (!cleaned.settled)
      cleanupDiagnostics.push(
        'error' in cleaned
          ? `${phase.name}: cleanup threw: ${text(cleaned.error)}`
          : `${phase.name}: cleanup did not finish by the run deadline`,
      );
    else if (cleaned.value !== undefined)
      cleanupDiagnostics.push(`${phase.name}: ${cleaned.value}`);
  }

  const result = {
    outcome: stop ?? { kind: 'completed' as const },
    phases: records,
    cleanupDiagnostics,
  };
  const path = join(runDir, 'run.json');
  const notWritten = (stage: 'not_attempted' | 'serialization' | 'write', why: string) => ({
    ...result,
    summary: { written: false as const, stage, why },
  });
  if (now() >= deadline) return notWritten('not_attempted', 'the run budget was spent');
  let body: string;
  try {
    body = JSON.stringify(
      {
        runId: c.runId,
        budgetMs: c.budgetMs,
        cleanupReserveMs: c.cleanupReserveMs,
        ...result,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    );
  } catch (cause) {
    return notWritten('serialization', text(cause));
  }
  // serializing can take the time that was left: check again immediately before writing
  if (now() >= deadline) return notWritten('not_attempted', 'the run budget was spent');
  const wrote = await until((async () => fs.writeSummary(path, `${body}\n`))(), deadline, now);
  if (wrote.settled) return { ...result, summary: { written: true, path } };
  return notWritten(
    'write',
    'error' in wrote
      ? text(wrote.error)
      : 'the summary write did not finish by the run deadline; a partial file may remain',
  );
};
