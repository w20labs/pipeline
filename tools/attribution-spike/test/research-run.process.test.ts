import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireLockBounded, releaseLockBounded } from '../src/lock.js';
import type { LockDeps } from '../src/lock-phase.js';
import { researchRun, type RunContext } from '../src/research-run.js';
import { SNAPSHOT_CAP } from '../src/snapshot-phase.js';
import type { Phase, RunConfig, RunnerFs, RunResult } from '../src/runner.js';
import type { Snapshot } from '../src/snapshot.js';

/** A composed run driving the real lock helper. Every process here is the test's own child. */

interface Tracked {
  readonly child: ChildProcess;
  /** What it was asked to run, so a test can say which helper a child was. */
  readonly argv: readonly string[];
  readonly kills: string[];
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: Error;
}
let tracked: Tracked[] = [];
let dirs: { readonly path: string; why?: string }[] = [];
/** Kept, not deleted: work that could still use this path was never confirmed settled. */
const retain = (path: string, why: string) => {
  const entry = dirs.find((d) => d.path === path);
  if (entry !== undefined) entry.why = why;
};
/**
 * Removes what nothing can be using and keeps what was retained, reporting every kept path. Called
 * only once the tracked children are known to have ended.
 */
const disposeOf = (entries: readonly { path: string; why?: string }[]): string[] => {
  const kept: string[] = [];
  for (const entry of entries) {
    if (entry.why === undefined) rmSync(entry.path, { recursive: true, force: true });
    else kept.push(`retained ${entry.path}: ${entry.why}`);
  }
  return kept;
};
const realSetTimeout = setTimeout; // captured before any test fakes timers
const sleepReal = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
/**
 * Bounded by its own counted sleeps rather than a clock, so a faked `Date` cannot stall it, and it
 * names what was missing instead of spinning. It checks a predicate: it knows nothing about why.
 */
const untilReady = async (what: string, ready: () => boolean, within = 10_000) => {
  for (let waited = 0; waited < within; waited += 20) {
    if (ready()) return;
    await sleepReal(20);
  }
  throw new Error(`not ready within ${String(within)} ms: ${what}`);
};
/** Watches a promise from the moment it exists, so no later await can meet an unobserved rejection. */
const observed = <T>(work: Promise<T>) => {
  const state = { done: false, error: undefined as unknown };
  void work.then(
    () => (state.done = true),
    (error: unknown) => ((state.error = error), (state.done = true)),
  );
  return { work, state };
};

const trackingSpawn = ((command: string, args: string[], options: object) => {
  const child = spawn(command, args, options);
  const t: Tracked = { child, argv: [...args], kills: [] };
  tracked.push(t);
  child.once('exit', (code, signal) => (t.exit = { code, signal }));
  child.once('error', (error) => (t.error = error));
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => (t.kills.push(String(signal)), kill(signal));
  return child;
}) as unknown as typeof spawn;

/**
 * Ends every child not already known to have ended, and reports the ones it cannot confirm. One
 * unconfirmed child never stops the rest from being signalled and waited for.
 */
const reapChildren = async (children: readonly Tracked[]): Promise<string[]> => {
  const unconfirmed: string[] = [];
  for (const t of children) {
    if (t.exit !== undefined || (t.error !== undefined && t.child.pid === undefined)) continue;
    try {
      t.child.kill('SIGKILL');
    } catch (cause) {
      unconfirmed.push(`pid ${String(t.child.pid)}: SIGKILL threw: ${String(cause)}`);
    }
    const ended = await new Promise<boolean>((resolve) => {
      const timer = realSetTimeout(() => resolve(false), 2_000);
      t.child.once('exit', () => (clearTimeout(timer), resolve(true)));
    });
    if (!ended) unconfirmed.push(`pid ${String(t.child.pid)}: no exit within 2 s of SIGKILL`);
  }
  return unconfirmed;
};

afterEach(async () => {
  const [children, created] = [tracked, dirs];
  [tracked, dirs] = [[], []];
  const unconfirmed = await reapChildren(children);
  // a directory goes only once every process that could still be using it is known to have ended
  if (unconfirmed.length > 0)
    throw new Error(
      `termination unconfirmed; kept ${created.map((d) => d.path).join(', ')}: ${unconfirmed.join('; ')}`,
    );
  const kept = disposeOf(created); // only now: every child that could use these has ended
  if (kept.length > 0) throw new Error(kept.join('; '));
}, 30_000);

/** Separate directories for every path the configuration keeps apart. */
const workspace = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-research-run-'));
  dirs.push({ path: base });
  const at: Record<string, string> = { base };
  for (const name of ['runs', 'control', 'research', 'operator', 'scratch']) {
    at[name] = join(base, name);
    mkdirSync(at[name] as string);
  }
  return at as {
    base: string;
    runs: string;
    control: string;
    research: string;
    operator: string;
    scratch: string;
  };
};
const configOf = (at: ReturnType<typeof workspace>, over: Partial<RunConfig> = {}): RunConfig => ({
  runId: 'run-1',
  runsRoot: at.runs,
  researchConfig: at.research,
  operatorClaudeDir: at.operator,
  scratch: at.scratch,
  controlDir: at.control,
  budgetMs: 30_000,
  cleanupReserveMs: 10_000,
  ...over,
});
/** A phase that does something to the control directory while the run is live. */
const observing = (name: string, seen: (dir: string) => void, dir: string): Phase => ({
  name,
  run: async () => (seen(dir), { kind: 'completed' }),
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
/** A promise the test resolves itself, so a run can be held at an exact point. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (value: T) => resolve(value) };
};
const status = (result: RunResult) => result.phases.map((p) => [p.name, p.status]);
/** A bootstrap manifest the manifest phase accepts, for this workspace's research configuration. */
const bootstrapManifest = (at: { control: string; research: string }) => {
  const body = `${JSON.stringify({
    version: 1,
    configPath: at.research,
    claudeVersion: '2.1.0',
    bootstrappedAt: '2026-09-17T08:00:00Z',
    separateAuthorization: 'unknown',
    bootstrapSessionClosed: true,
  })}\n`;
  writeFileSync(join(at.control, 'bootstrap.json'), body);
  return body;
};
/** Another run's lock, written exactly as the helper writes one. */
const foreignLock = (dir: string) =>
  writeFileSync(
    join(dir, 'run.lock'),
    `${JSON.stringify({
      version: 1,
      runId: 'run-other',
      pid: process.pid,
      startedAt: '2026-09-17T08:30:00Z',
      token: 'f1'.repeat(16),
    })}\n`,
  );

describe('a composed run', () => {
  it('holds the lock while the run is under way, and gives it back at the end', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const held: string[] = [];
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [
        observing(
          'observe',
          (dir) => held.push(readFileSync(join(dir, 'run.lock'), 'utf8')),
          at.control,
        ),
      ],
    });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
      ['observe', 'completed'],
    ]);
    expect(result.phases[0]).toMatchObject({
      evidence: { controlDir: at.control, runId: 'run-1', diagnostics: [] },
    });
    // the lock the observer read was this run's own, published while the run was live
    expect(JSON.parse(held[0] ?? '')).toMatchObject({
      version: 1,
      runId: 'run-1',
      pid: process.pid,
    });
    // the lock and its temporary file are gone; the manifest it was given is untouched
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(result.cleanupDiagnostics).toEqual([]);

    const summary = JSON.parse(
      readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8'),
    ) as RunResult;
    expect(status(summary)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
      ['observe', 'completed'],
    ]);
    expect(tracked).toHaveLength(5); // acquisition, manifest read, two walks, release
    expect(tracked.map((t) => [t.exit?.code, t.kills])).toEqual([
      [0, []],
      [0, []],
      [0, []],
      [0, []],
      [0, []],
    ]);
  }, 60_000);

  it('refuses when another run holds the lock, and leaves that lock as it found it', async () => {
    const at = workspace();
    foreignLock(at.control);
    const before = {
      bytes: readFileSync(join(at.control, 'run.lock'), 'utf8'),
      ino: statSync(join(at.control, 'run.lock')).ino,
    };
    const ran: string[] = [];
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [observing('observe', () => ran.push('observe'), at.control)],
    });

    expect(result.outcome).toMatchObject({ name: 'lock', status: 'refused' });
    expect((result.outcome as { why: string }).why).toBe('another run holds the lock');
    expect(status(result)).toEqual([
      ['lock', 'refused'],
      ['manifest', 'not_run'],
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
      ['observe', 'not_run'],
    ]);
    expect(ran).toEqual([]); // nothing ran behind a lock this run does not hold
    // cleanup still asks, and reports that what it found was not this run's to remove
    expect(result.cleanupDiagnostics).toEqual([
      "lock: the lock in place was not this run's (not_ours); it was left as found",
    ]);
    expect({
      bytes: readFileSync(join(at.control, 'run.lock'), 'utf8'),
      ino: statSync(join(at.control, 'run.lock')).ino,
    }).toEqual(before);
    expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true);
  }, 60_000);

  it('reports a lock replaced during the run, leaving the replacement in place', async () => {
    const at = workspace();
    bootstrapManifest(at);
    let put: { bytes: string; ino: number } | undefined;
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [
        observing(
          'replace',
          (dir) => {
            rmSync(join(dir, 'run.lock'));
            foreignLock(dir);
            // captured while it is the file just put in place, so cleanup cannot have touched it
            put = {
              bytes: readFileSync(join(dir, 'run.lock'), 'utf8'),
              ino: statSync(join(dir, 'run.lock')).ino,
            };
          },
          at.control,
        ),
      ],
    });

    expect(result.outcome).toEqual({ kind: 'completed' }); // the run itself did its work
    expect(result.cleanupDiagnostics).toEqual([
      "lock: the lock in place was not this run's (not_ours); it was left as found",
    ]);
    const summary = JSON.parse(
      readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8'),
    ) as RunResult;
    expect(summary.cleanupDiagnostics).toEqual(result.cleanupDiagnostics);
    // whoever put it there still has it: this run removed nothing of theirs
    expect(readFileSync(join(at.control, 'run.lock'), 'utf8')).toBe(put?.bytes);
    expect(statSync(join(at.control, 'run.lock')).ino).toBe(put?.ino);
    rmSync(join(at.control, 'run.lock'));
  }, 60_000);

  it('puts the lock first, and refuses a supplied phase that claims its name', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const order: string[] = [];
    const ordered = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [
        observing('first', () => order.push('first'), at.control),
        observing('second', () => order.push('second'), at.control),
      ],
    });
    expect(status(ordered)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
      ['first', 'completed'],
      ['second', 'completed'],
    ]);
    expect(order).toEqual(['first', 'second']); // after the lock, in the order supplied

    const claimed = await researchRun(configOf(at, { runId: 'run-2' }), {
      spawn: trackingSpawn,
      after: [observing('lock', () => order.push('impostor'), at.control)],
    });
    expect(claimed).toEqual({
      outcome: { name: 'start', status: 'refused', why: 'a supplied phase may not be named lock' },
      phases: ['lock', 'manifest', 'snapshot', 'quiescence', 'lock'].map((name) => ({
        name,
        status: 'not_run',
        why: 'the run did not start',
      })),
      cleanupDiagnostics: [],
      summary: {
        written: false,
        stage: 'not_attempted',
        why: 'the run did not start; nothing was written',
      },
    });
    expect(order).toEqual(['first', 'second']); // the impostor never ran
    expect(existsSync(join(at.runs, 'run-2'))).toBe(false); // and nothing was created for it
  }, 60_000);

  it('uses one snapshot: nothing a caller changes mid-run moves the lock or the work', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const config = configOf(at) as Mutable<RunConfig>;
    const held: string[] = [];
    const ran: string[] = [];
    const observer: Mutable<Phase> = {
      name: 'observe',
      run: async () => {
        ran.push('original');
        held.push(readFileSync(join(at.control, 'run.lock'), 'utf8'));
        return { kind: 'completed' };
      },
    };
    const after: Phase[] = [observer];
    const creating = deferred<void>();
    const release = deferred<void>();

    const run = researchRun(config, {
      spawn: trackingSpawn,
      after,
      fs: {
        mkdirExclusive: async (path) => {
          creating.resolve();
          await release.promise; // the run is held here, before any acquisition has started
          mkdirSync(path);
        },
        writeSummary: async (path, text) => writeFileSync(path, text, { flag: 'wx' }),
      },
    });

    await creating.promise;
    config.runId = 'moved'; // the configuration...
    config.controlDir = at.scratch;
    config.researchConfig = at.scratch; // including the path the manifest is validated against
    after.push(observing('late', () => ran.push('late'), at.control)); // ...the list...
    observer.run = async () => (ran.push('replaced'), { kind: 'completed' }); // ...and a method
    release.resolve();
    const result = await run;

    expect(ran).toEqual(['original']); // the bound method, and no phase added after the fact
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
      ['observe', 'completed'],
    ]);
    // the lock identified the run the snapshot named, in the directory it named
    expect(JSON.parse(held[0] ?? '')).toMatchObject({ runId: 'run-1' });
    expect(result.phases[0]).toMatchObject({
      evidence: { controlDir: at.control, runId: 'run-1' },
    });
    expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true);
    expect(existsSync(join(at.runs, 'moved'))).toBe(false);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']); // the manifest is not the lock's
  }, 60_000);

  it('reports a spent budget without a summary, and says the lock was left behind', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const BUDGET = 4_000;
    const RESERVE = 2_000;
    const origin = 2_000_000; // one captured origin, as everywhere else on controlled time
    const clock = { t: origin };
    const gate = deferred<undefined>();
    const cleanup = { started: false, settled: false };
    const slow: Phase = {
      name: 'slow',
      run: async () => ({ kind: 'completed' }),
      // held open until the test lets go, so the run deadline arrives while it is still running
      cleanup: async () => {
        cleanup.started = true;
        await gate.promise;
        cleanup.settled = true;
        return undefined;
      },
    };

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = observed(
      researchRun(configOf(at, { budgetMs: BUDGET, cleanupReserveMs: RESERVE }), {
        spawn: trackingSpawn,
        now: () => clock.t,
        after: [slow],
      }),
    );

    try {
      // bounded on real timers: the cleanup must be running, and the runner's timeout for it
      // registered, before any fake time moves — inferring either from elapsed time is what made
      // this test depend on which side of the deadline the real clock happened to be on
      await untilReady('the slow cleanup to start', () => cleanup.started, 20_000);
      await untilReady('its runner timeout', () => vi.getTimerCount() >= 1, 20_000);

      clock.t = origin + BUDGET; // exactly the run deadline
      await vi.advanceTimersByTimeAsync(BUDGET);
      await untilReady('the composed run', () => run.state.done, 20_000);
      const result = await run.work;

      // the runner gave up on the cleanup it was inside, then found no budget for the next one
      expect(result.cleanupDiagnostics).toEqual([
        'slow: cleanup did not finish by the run deadline',
        'lock: cleanup not run: the run budget was spent',
      ]);
      expect(result.summary).toEqual({
        written: false,
        stage: 'not_attempted',
        why: 'the run budget was spent',
      });
      expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(false); // correctly unwritten
      expect(tracked).toHaveLength(4); // acquisition, manifest read, two walks; no release
      // the lock this run took is still there, which is exactly what the diagnostics say
      expect(JSON.parse(readFileSync(join(at.control, 'run.lock'), 'utf8'))).toMatchObject({
        runId: 'run-1',
      });
    } finally {
      vi.useRealTimers();
      gate.resolve(undefined);
      const outstanding: string[] = [];
      for (const [what, done] of [
        ['the slow cleanup', () => cleanup.settled],
        ['the composed run', () => run.state.done],
      ] as [string, () => boolean][])
        if (!(await confirmed(what, done))) outstanding.push(`${what} did not settle`);
      if (outstanding.length > 0) retain(at.base, outstanding.join('; '));
      else rmSync(join(at.control, 'run.lock'), { force: true });
    }
  }, 60_000);

  it('reads the run id once, and everything it builds uses that one value', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const reads: string[] = [];
    const config = configOf(at) as Mutable<RunConfig>;
    // a valid getter, answering differently after the first read: one snapshot sees only 'run-1'
    Object.defineProperty(config, 'runId', {
      get: () => (reads.push('runId'), reads.length === 1 ? 'run-1' : 'moved'),
    });
    // the same for the path the manifest is validated against: read once, or it validates another
    const configReads: string[] = [];
    Object.defineProperty(config, 'researchConfig', {
      get: () => (configReads.push('read'), configReads.length === 1 ? at.research : at.scratch),
    });
    const held: string[] = [];
    const result = await researchRun(config, {
      spawn: trackingSpawn,
      after: [
        observing(
          'observe',
          (dir) => held.push(readFileSync(join(dir, 'run.lock'), 'utf8')),
          at.control,
        ),
      ],
    });

    expect(reads).toHaveLength(1);
    expect(JSON.parse(held[0] ?? '')).toMatchObject({ runId: 'run-1' }); // the published record
    expect(result.phases[0]).toMatchObject({ evidence: { runId: 'run-1' } });
    expect(result.phases[1]).toMatchObject({ name: 'manifest', status: 'completed' });
    expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true); // and the run directory
    expect(existsSync(join(at.runs, 'moved'))).toBe(false);
  }, 60_000);

  it('uses the filesystem methods it captured, not ones swapped in mid-run', async () => {
    const at = workspace();
    const swapped: string[] = [];
    const creating = deferred<void>();
    const release = deferred<void>();
    const fs: Mutable<RunnerFs> = {
      mkdirExclusive: async (path) => {
        creating.resolve();
        await release.promise;
        mkdirSync(path);
      },
      writeSummary: async (path, text) => writeFileSync(path, text, { flag: 'wx' }),
    };

    const run = researchRun(configOf(at), { spawn: trackingSpawn, fs });
    await creating.promise;
    fs.writeSummary = async (path) => void swapped.push(path); // the run must not see these
    fs.mkdirExclusive = async () => void swapped.push('mkdir');
    release.resolve();
    const result = await run;

    expect(swapped).toEqual([]); // neither replacement was ever called
    expect(result.summary).toEqual({ written: true, path: join(at.runs, 'run-1', 'run.json') });
    expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true); // written by the original
  }, 60_000);

  it('measures the lock on the clock it was given, not on the wall clock', async () => {
    const at = workspace();
    bootstrapManifest(at);
    // an advancing clock a minute behind: the deadline computed here must reach the wrappers, or
    // acquisition compares it against the wall clock and reports a run that never happened
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      now: () => Date.now() - 60_000,
    });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
    ]);
    expect(result.phases[0]).toMatchObject({ evidence: { runId: 'run-1', diagnostics: [] } });
    expect(result.cleanupDiagnostics).toEqual([]); // the release measured on it too
    // the interpreter, the spawn and this clock reached the manifest reader and the walk as well
    expect(tracked.map((t) => t.exit?.code)).toEqual([0, 0, 0, 0, 0]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  it('cleans up after an acquisition that published and then hung', async () => {
    const at = workspace();
    const marker = join(at.scratch, 'published');
    // the barrier is inside the helper process: os.link does the real link, says so, then blocks
    const shim = join(at.scratch, 'barrier-python');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env python3',
        'import os, runpy, sys, time',
        'real_link = os.link',
        'def linked(*args, **kwargs):',
        '    real_link(*args, **kwargs)',
        `    open(${JSON.stringify(marker)}, "w").close()`,
        '    time.sleep(3600)',
        'os.link = linked',
        'os.supports_dir_fd = set(os.supports_dir_fd) | {linked}',
        'os.supports_follow_symlinks = set(os.supports_follow_symlinks) | {linked}',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = await researchRun(configOf(at, { budgetMs: 6_000, cleanupReserveMs: 3_000 }), {
      spawn: trackingSpawn,
      python: shim,
    });

    expect(existsSync(marker)).toBe(true); // publication was reached before the helper was stopped
    expect(result.outcome).toMatchObject({ name: 'lock', status: 'refused' });
    const why = (result.outcome as { why: string }).why;
    expect(why).toContain('whether the lock was taken is not established');
    expect(why).toContain('the lock may remain');
    // its exit was confirmed, so the acquisition is eligible: cleanup takes the lock back
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual([]);
    expect(tracked).toHaveLength(2); // the barriered acquisition, then the release
    expect(tracked[0]?.kills).toEqual(['SIGTERM']);
    expect(tracked[1]?.exit?.code).toBe(0);
  }, 60_000);

  it('uses the lock functions it captured, not ones swapped in mid-run', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const swapped: string[] = [];
    const used: string[] = [];
    const creating = deferred<void>();
    const release = deferred<void>();
    const lock: Mutable<Pick<LockDeps, 'acquire' | 'release'>> = {
      acquire: async (dir, owner, options) => (
        used.push('acquire'),
        acquireLockBounded(dir, owner, options)
      ),
      release: async (handle, options) => (
        used.push('release'),
        releaseLockBounded(handle, options)
      ),
    };

    const run = researchRun(configOf(at), {
      spawn: trackingSpawn,
      lock,
      fs: {
        mkdirExclusive: async (path) => {
          creating.resolve();
          await release.promise;
          mkdirSync(path);
        },
        writeSummary: async (path, text) => writeFileSync(path, text, { flag: 'wx' }),
      },
    });
    await creating.promise;
    lock.acquire = async () => (
      swapped.push('acquire'),
      { kind: 'not_attempted', reason: 'invalid_request' }
    );
    lock.release = async () => (swapped.push('release'), { kind: 'missing', diagnostics: [] });
    release.resolve();
    const result = await run;

    expect(swapped).toEqual([]); // neither replacement was reached
    expect(used).toEqual(['acquire', 'release']); // both captured functions were
    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  /**
   * Wraps an acquisition — the genuine one by default — and withholds its result until the test
   * opens the gate. A failure is recorded and both waits are released, so nothing can hang on it.
   */
  const withheld = (inner: LockDeps['acquire'] = acquireLockBounded) => {
    const gate = deferred<void>();
    const arrived = deferred<void>();
    const state = { invoked: false, arrived: false, settled: false, failure: undefined as unknown };
    const acquire: LockDeps['acquire'] = async (dir, owner, options) => {
      state.invoked = true;
      let outcome: Awaited<ReturnType<LockDeps['acquire'] & object>>;
      try {
        outcome = await inner(dir, owner, options);
      } catch (cause) {
        state.failure = cause;
        state.arrived = true;
        state.settled = true;
        arrived.resolve();
        throw cause;
      }
      state.arrived = true;
      arrived.resolve();
      await gate.promise;
      state.settled = true;
      return outcome;
    };
    return { acquire, gate, state, acquired: arrived.promise };
  };

  type Withheld = ReturnType<typeof withheld>;
  /** Bounded, and answers rather than throws: both settlement states are checked either way. */
  const confirmed = async (what: string, done: () => boolean) => {
    try {
      await untilReady(what, done, 5_000);
      return true;
    } catch {
      return false;
    }
  };
  /**
   * Opens the gate and waits, bounded, for the withheld acquisition and for the run. Both states
   * are checked even when the first cannot be confirmed, and whatever is left unsettled keeps its
   * workspace: the registry entry is marked, never removed, so teardown still reaps its children.
   */
  const settleWithheld = async (w: Withheld, run: { state: { done: boolean } }, base: string) => {
    vi.useRealTimers();
    w.gate.resolve();
    const ranOut = await confirmed('the composed run', () => run.state.done);
    // an acquisition that was never invoked is outstanding until the run itself has settled: one
    // still inside directory creation could yet start it
    const acquisitionOut = w.state.invoked
      ? await confirmed('the withheld acquisition', () => w.state.settled)
      : ranOut;
    const outstanding: string[] = [];
    if (!acquisitionOut)
      outstanding.push(
        w.state.invoked ? 'the withheld acquisition did not settle' : 'the run could still acquire',
      );
    if (!ranOut) outstanding.push('the composed run did not settle');
    if (outstanding.length > 0) retain(base, outstanding.join('; '));
    return outstanding;
  };

  it('reconciles an acquisition delivered during the cleanup reserve', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const w = withheld();
    // the phase deadline falls at +2 s, the run deadline at +6 s: delivery lands inside the reserve
    const run = observed(
      researchRun(configOf(at, { budgetMs: 6_000, cleanupReserveMs: 4_000 }), {
        spawn: trackingSpawn,
        lock: { acquire: w.acquire },
      }),
    );
    try {
      await untilReady('the acquisition to arrive', () => w.state.arrived, 15_000);
      await sleepReal(3_000); // past the phase deadline, inside the reserve
      w.gate.resolve();
      await untilReady('the composed run', () => run.state.done, 15_000);
      const result = await run.work;

      expect(result.phases.map((p) => p.status)).toEqual([
        'timed_out',
        'not_run',
        'not_run',
        'not_run',
      ]);
      expect(result.cleanupDiagnostics).toEqual([]); // reconciled, then released
      expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
      expect(tracked).toHaveLength(2);
    } finally {
      expect(await settleWithheld(w, run, at.base)).toEqual([]);
    }
  }, 60_000);

  it('spawns no release for an acquisition still withheld at the cleanup deadline', async () => {
    const at = workspace();
    const w = withheld();
    const BUDGET = 4_000;
    const RESERVE = 2_000;
    const origin = 1_000_000; // one captured origin: every deadline below derives from it
    const clock = { t: origin };
    const run = observed(
      researchRun(configOf(at, { budgetMs: BUDGET, cleanupReserveMs: RESERVE }), {
        spawn: trackingSpawn,
        now: () => clock.t,
        lock: { acquire: w.acquire },
      }),
    );

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // bounded on observed state, by real sleeps: fake timers cannot stall it, and a run that
      // refused before acquisition cannot leave this suspended
      await untilReady('the acquisition to arrive', () => w.state.arrived, 15_000);

      // to the phase deadline, clock and timers moved together, so the runner gives up on run()
      clock.t = origin + BUDGET - RESERVE;
      await vi.advanceTimersByTimeAsync(BUDGET - RESERVE);
      // cleanup runs synchronously before `until` is entered, so reconcile registers its timer
      // first; both delays come from this same clock, so they are equal. Two registered timers is
      // the signal that both exist — never elapsed real time, and bounded so a miss cannot spin.
      await untilReady('both cleanup timers registered', () => vi.getTimerCount() >= 2, 10_000);

      // to the cleanup deadline exactly: `now() > deadline` is false there, so the phase's own
      // result is accepted rather than discarded as late
      clock.t = origin + BUDGET;
      await vi.advanceTimersByTimeAsync(RESERVE);
      await untilReady('the composed run', () => run.state.done, 15_000);
      const result = await run.work;

      expect(result.cleanupDiagnostics).toEqual([
        'lock: the acquisition did not resolve by the cleanup deadline; the lock may remain',
      ]);
      expect(tracked).toHaveLength(1); // nothing was released: the handle was never known
      expect(JSON.parse(readFileSync(join(at.control, 'run.lock'), 'utf8'))).toMatchObject({
        runId: 'run-1',
      });
    } finally {
      expect(await settleWithheld(w, run, at.base)).toEqual([]);
      await sleepReal(100); // a turn of real time: a late release would have been recorded by now
      expect(tracked).toHaveLength(1); // late settlement starts nothing
      rmSync(join(at.control, 'run.lock'), { force: true });
    }
  }, 60_000);

  it('reads the supplied phase list once', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const reads: string[] = [];
    const ran: string[] = [];
    const impostor = observing('lock', () => ran.push('impostor'), at.control);
    const options = { spawn: trackingSpawn };
    Object.defineProperty(options, 'after', {
      get: () => (reads.push('read'), reads.length === 1 ? [] : [impostor]),
      enumerable: true,
    });

    const result = await researchRun(configOf(at), options);
    expect(reads).toHaveLength(1);
    expect(reads).toHaveLength(1); // one read, and the composition is built from it
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'], // validated against the path read the first time
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
    ]);
    expect(ran).toEqual([]);
  }, 60_000);

  it('gives up on a readiness condition that never holds, and says what was missing', async () => {
    // the helper only, with a predicate that cannot become true: nothing here reproduces a runner
    // state, and the bound is what stops an unmet condition from spinning past a test timeout
    const started = Date.now();
    await expect(untilReady('two cleanup timers', () => false, 200)).rejects.toThrow(
      'not ready within 200 ms: two cleanup timers',
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps a workspace whose withheld work cannot be confirmed settled', async () => {
    const at = workspace();
    const never = deferred<void>();
    // fabricated unsettled state, driven through the real teardown: the acquisition never settles
    const w = withheld(() => never.promise as never);
    const run = observed(new Promise<string>(() => undefined)); // never settles either
    // invoked, so the acquisition itself is the outstanding work, not a run that might yet start one
    const attempt = observed(
      w.acquire(
        at.control,
        { runId: 'run-1', pid: 1, startedAt: '2026-09-17T08:30:00Z' },
        {
          deadline: Date.now() + 1_000,
        },
      ),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const outstanding = await settleWithheld(w, run, at.base);

    // both are checked: failing to confirm the first never skips the second
    expect(outstanding).toEqual([
      'the withheld acquisition did not settle',
      'the composed run did not settle',
    ]);
    expect(vi.isFakeTimers()).toBe(false); // real timers restored by the teardown itself
    expect(dirs.find((d) => d.path === at.base)?.why).toBe(
      'the withheld acquisition did not settle; the composed run did not settle',
    );
    expect(existsSync(at.control)).toBe(true); // a real directory, kept rather than deleted

    // nothing can be using it now: this fixture disposes of itself and clears its own mark
    never.resolve();
    await untilReady('the fabricated acquisition', () => attempt.state.done, 5_000);
    const entry = dirs.find((d) => d.path === at.base);
    if (entry !== undefined) delete entry.why;
    rmSync(at.base, { recursive: true, force: true });
  }, 30_000);

  it('records an acquisition that fails instead of leaving its waiters pending', async () => {
    const failing = withheld(() => {
      throw new Error('spawn SENTINEL-SECRET ENOENT');
    });
    const attempt = observed(
      failing.acquire(
        '/cache/control',
        { runId: 'run-1', pid: 1, startedAt: '2026-09-17T08:30:00Z' },
        {
          deadline: Date.now() + 1_000,
        },
      ),
    );

    // resolved by the failure, so no waiter is left pending — and bounded even if it were not
    await untilReady('the failed acquisition to arrive', () => failing.state.arrived, 5_000);
    await untilReady('the failed acquisition', () => attempt.state.done, 5_000);
    expect(failing.state.settled).toBe(true);
    expect(String(failing.state.failure)).toContain('ENOENT');
    expect(attempt.state.error).toBe(failing.state.failure);
  }, 30_000);

  it('keeps a workspace when a run that has not acquired yet cannot be confirmed settled', async () => {
    const at = workspace();
    const w = withheld(); // never invoked: the run is still somewhere before acquisition
    const run = observed(new Promise<string>(() => undefined));
    try {
      const outstanding = await settleWithheld(w, run, at.base);
      // not invoked is not proof of nothing outstanding while the run could still start one
      expect(outstanding).toEqual([
        'the run could still acquire',
        'the composed run did not settle',
      ]);
      expect(dirs.find((d) => d.path === at.base)?.why).toContain('could still acquire');
      expect(existsSync(at.control)).toBe(true);
    } finally {
      const entry = dirs.find((d) => d.path === at.base);
      if (entry !== undefined) delete entry.why; // nothing here ever started work on this path
      rmSync(at.base, { recursive: true, force: true });
    }
  }, 30_000);

  it('reaches teardown when startup refuses before acquisition', async () => {
    const at = workspace();
    const w = withheld();
    const run = observed(
      researchRun(configOf(at), {
        spawn: trackingSpawn,
        lock: { acquire: w.acquire },
        fs: {
          mkdirExclusive: () => Promise.reject(new Error('EACCES')),
          writeSummary: async (path, text) => writeFileSync(path, text, { flag: 'wx' }),
        },
      }),
    );
    try {
      await untilReady('the refused run', () => run.state.done, 15_000);
      const result = await run.work;
      expect(result.outcome).toMatchObject({ name: 'start', status: 'refused' });
      expect((result.outcome as { why: string }).why).toContain(
        'the run directory could not be created',
      );
      expect(w.state.invoked).toBe(false); // acquisition was never reached
      expect(tracked).toEqual([]);
    } finally {
      // the run settled, so a never-invoked acquisition leaves nothing outstanding
      expect(await settleWithheld(w, run, at.base)).toEqual([]);
    }
  }, 30_000);

  it('disposes of what is finished and keeps what is retained, naming it', () => {
    const gone = mkdtempSync(join(tmpdir(), 'pipeline-dispose-gone-'));
    const kept = mkdtempSync(join(tmpdir(), 'pipeline-dispose-kept-'));
    try {
      const report = disposeOf([
        { path: gone },
        { path: kept, why: 'a helper may still be there' },
      ]);
      expect(existsSync(gone)).toBe(false); // nothing could be using it
      expect(existsSync(kept)).toBe(true); // something might
      expect(report).toEqual([`retained ${kept}: a helper may still be there`]);
    } finally {
      for (const dir of [gone, kept]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a workspace whose acquisition is unsettled even though the run finished', async () => {
    const at = workspace();
    const never = deferred<void>();
    const w = withheld(() => never.promise as never);
    const run = observed(Promise.resolve('the runner gave up and returned')); // settled
    const attempt = observed(
      w.acquire(
        at.control,
        { runId: 'run-1', pid: 1, startedAt: '2026-09-17T08:30:00Z' },
        {
          deadline: Date.now() + 1_000,
        },
      ),
    );

    try {
      // a settled runner says nothing about the acquisition it abandoned: that is checked on its own
      expect(await settleWithheld(w, run, at.base)).toEqual([
        'the withheld acquisition did not settle',
      ]);
      expect(dirs.find((d) => d.path === at.base)?.why).toBe(
        'the withheld acquisition did not settle',
      );
      expect(existsSync(at.control)).toBe(true); // registered, marked, and still there
    } finally {
      never.resolve();
      await untilReady('the fabricated acquisition', () => attempt.state.done, 5_000);
      const entry = dirs.find((d) => d.path === at.base);
      if (entry !== undefined) delete entry.why; // only now: its work is known to have ended
      rmSync(at.base, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the manifest it was given, and carries its evidence into the summary', async () => {
    const at = workspace();
    const body = bootstrapManifest(at);
    const before = statSync(join(at.control, 'bootstrap.json')).ino;

    const result = await researchRun(configOf(at), { spawn: trackingSpawn });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(result.phases[1]).toMatchObject({
      name: 'manifest',
      status: 'completed',
      evidence: {
        claudeVersion: '2.1.0',
        bootstrappedAt: '2026-09-17T08:00:00Z',
        separateAuthorization: 'unknown',
      },
    });
    const summary = JSON.parse(
      readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8'),
    ) as RunResult;
    expect(summary.phases[1]).toMatchObject({
      evidence: { claudeVersion: '2.1.0', separateAuthorization: 'unknown' },
    });
    // the lock and its temporary file go; the manifest is not this run's to touch
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(body);
    expect(statSync(join(at.control, 'bootstrap.json')).ino).toBe(before);
  }, 60_000);

  it('stops supplied work when the manifest is missing, and still releases the lock', async () => {
    const at = workspace();
    const ran: string[] = [];
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [observing('observe', () => ran.push('observe'), at.control)],
    });

    expect(result.outcome).toMatchObject({ name: 'manifest', status: 'refused' });
    expect((result.outcome as { why: string }).why).toBe('the bootstrap manifest is missing');
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'refused'],
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
      ['observe', 'not_run'],
    ]);
    expect(ran).toEqual([]); // nothing supplied runs without a manifest
    // the lock is given back even though the run stopped at the phase after it
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual([]);
  }, 60_000);

  it('stops supplied work when the manifest is invalid, and leaves it exactly as found', async () => {
    const at = workspace();
    const body = `${JSON.stringify({
      version: 1,
      configPath: '/somewhere/else', // not this run's research configuration
      claudeVersion: '2.1.0',
      bootstrappedAt: '2026-09-17T08:00:00Z',
      separateAuthorization: true,
      bootstrapSessionClosed: true,
    })}\n`;
    writeFileSync(join(at.control, 'bootstrap.json'), body);
    const before = statSync(join(at.control, 'bootstrap.json')).ino;
    const ran: string[] = [];

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [observing('observe', () => ran.push('observe'), at.control)],
    });

    expect((result.outcome as { why: string }).why).toBe(
      'the bootstrap manifest is invalid: configPath does not name this research configuration',
    );
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'refused'],
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
      ['observe', 'not_run'],
    ]);
    expect(ran).toEqual([]);
    expect(result.cleanupDiagnostics).toEqual([]); // released regardless of why the run stopped
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(body);
    expect(statSync(join(at.control, 'bootstrap.json')).ino).toBe(before);
  }, 60_000);

  it('refuses a supplied phase that claims the manifest’s name', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const ran: string[] = [];
    const claimed = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [observing('manifest', () => ran.push('impostor'), at.control)],
    });

    expect(claimed.outcome).toEqual({
      name: 'start',
      status: 'refused',
      why: 'a supplied phase may not be named manifest',
    });
    expect(status(claimed).map(([name]) => name)).toEqual([
      'lock',
      'manifest',
      'snapshot',
      'quiescence',
      'manifest',
    ]);
    expect(ran).toEqual([]);
    expect(tracked).toEqual([]); // nothing was started at all
    expect(existsSync(join(at.runs, 'run-1'))).toBe(false);
  }, 60_000);

  it('sends the interpreter it captured to the manifest reader as well', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const marker = join(at.scratch, 'interpreters');
    const shim = join(at.scratch, 'recording-python');
    writeFileSync(
      shim,
      ['#!/bin/sh', `printf 'x' >> ${JSON.stringify(marker)}`, 'exec python3 "$@"', ''].join('\n'),
      { mode: 0o755 },
    );

    const result = await researchRun(configOf(at), { spawn: trackingSpawn, python: shim });

    expect(result.outcome).toEqual({ kind: 'completed' });
    // acquisition, the manifest read, the walk and the release all used the captured interpreter
    expect(readFileSync(marker, 'utf8')).toBe('xxxxx');
    expect(tracked).toHaveLength(5);
  }, 60_000);

  it('exhausts the phase budget after the lock, leaving the manifest and later work unrun', async () => {
    const at = workspace();
    const body = bootstrapManifest(at);
    const before = statSync(join(at.control, 'bootstrap.json')).ino;
    const BUDGET = 8_000;
    const RESERVE = 4_000;
    const origin = 3_000_000;
    const clock = { t: origin };
    const ran: string[] = [];
    const result = await researchRun(
      configOf(at, { budgetMs: BUDGET, cleanupReserveMs: RESERVE }),
      {
        spawn: trackingSpawn,
        now: () => clock.t,
        // the budget is spent the moment the lock is taken: deterministic, and no waiting
        lock: {
          acquire: async (dir, owner, options) => {
            const outcome = await acquireLockBounded(dir, owner, options);
            clock.t = origin + BUDGET - RESERVE; // exactly the phase deadline
            return outcome;
          },
        },
        after: [observing('observe', () => ran.push('observe'), at.control)],
      },
    );

    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'not_run'],
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
      ['observe', 'not_run'],
    ]);
    expect(result.phases[1]).toMatchObject({ why: 'the run budget was spent' });
    expect(ran).toEqual([]);
    // the reserve was untouched, so the lock still went back
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(body);
    expect(statSync(join(at.control, 'bootstrap.json')).ino).toBe(before);
    expect(tracked.map((t) => t.exit?.code)).toEqual([0, 0]); // acquisition and release only
  }, 60_000);

  it('reaps every tracked child even when one cannot be confirmed', async () => {
    // fabricated records: nothing here has a real pid, so no live process is ever signalled
    const stub = (ends: boolean) => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        kill: (signal?: NodeJS.Signals | number) => {
          signalled.push(String(signal));
          if (ends) queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
          return true;
        },
      });
      return { child, kills: [] } as unknown as Tracked;
    };
    const signalled: string[] = [];
    const ended = {
      child: { pid: 1 },
      kills: [],
      exit: { code: 0, signal: null },
    } as unknown as Tracked;

    const unconfirmed = await reapChildren([ended, stub(false), stub(true)]);

    expect(signalled).toEqual(['SIGKILL', 'SIGKILL']); // the third was still signalled
    expect(unconfirmed).toEqual(['pid undefined: no exit within 2 s of SIGKILL']);
    // and the workspace that one belongs to is kept, named, by the same decision afterEach uses
    const kept = mkdtempSync(join(tmpdir(), 'pipeline-reap-kept-'));
    try {
      expect(disposeOf([{ path: kept, why: unconfirmed.join('; ') }])).toEqual([
        `retained ${kept}: pid undefined: no exit within 2 s of SIGKILL`,
      ]);
      expect(existsSync(kept)).toBe(true);
    } finally {
      rmSync(kept, { recursive: true, force: true });
    }
  }, 30_000);

  it('escalates to SIGKILL when the manifest helper resists, leaving the lock work normal', async () => {
    const at = workspace();
    const body = bootstrapManifest(at);
    // the shim stands in for the interpreter, but resists only the manifest read: acquisition and
    // release run through it untouched, so what escalation does here is not confused with them
    const shim = join(at.scratch, 'stubborn-python');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env python3',
        'import os, runpy, signal, sys, time',
        "if sys.argv[1].endswith('read-control-file.py'):",
        '    signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        '    time.sleep(3600)',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = await researchRun(configOf(at, { budgetMs: 8_000, cleanupReserveMs: 4_000 }), {
      spawn: trackingSpawn,
      python: shim,
    });

    expect(result.outcome).toMatchObject({ name: 'manifest', status: 'refused' });
    expect((result.outcome as { why: string }).why).toContain(
      'the bootstrap manifest could not be read',
    );
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'refused'],
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
    ]);
    // the manifest child ignored SIGTERM and was killed; its own exit says so, independently
    expect(tracked).toHaveLength(3);
    expect(tracked[1]?.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(tracked[1]?.exit).toEqual({ code: null, signal: 'SIGKILL' });
    // acquisition and release were ordinary runs through the same interpreter
    expect([tracked[0]?.exit, tracked[2]?.exit]).toEqual([
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    expect(tracked[0]?.kills).toEqual([]);
    expect(tracked[2]?.kills).toEqual([]);
    // the lock went back, and the manifest it could not read is exactly as it was
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(body);
  }, 60_000);

  it('calls the supplied builder once, before anything is spawned, with the run’s own inputs held', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const calls: { spawned: number; baseline: unknown }[] = [];
    const config = configOf(at) as Mutable<RunConfig>;
    const ran: string[] = [];
    const observer: Mutable<Phase> = {
      name: 'observe',
      run: async () => (ran.push('original'), { kind: 'completed' }),
    };
    const built: Phase[] = [observer];
    const creating = deferred<void>();
    const release = deferred<void>();

    const run = observed(
      researchRun(config, {
        spawn: trackingSpawn,
        after: (context) => {
          calls.push({ spawned: tracked.length, baseline: context.baseline() });
          config.controlDir = at.scratch; // mutating the caller's object now is already too late
          config.runId = 'moved';
          return built;
        },
        fs: {
          mkdirExclusive: async (path) => {
            creating.resolve();
            await release.promise; // held here: the builder has returned, no phase has run
            mkdirSync(path);
          },
          writeSummary: async (path, text) => writeFileSync(path, text, { flag: 'wx' }),
        },
      }),
    );

    try {
      await untilReady('the run to reach directory creation', () => calls.length > 0, 20_000);
      built.push(observing('late', () => ran.push('late'), at.control)); // after the builder returned
      observer.run = async () => (ran.push('replaced'), { kind: 'completed' });
      release.resolve();
      await untilReady('the composed run', () => run.state.done, 20_000);
      const result = await run.work;

      expect(calls).toEqual([{ spawned: 0, baseline: undefined }]); // once, before any child
      expect(ran).toEqual(['original']); // the copied list, and the method bound when it was copied
      expect(status(result).map(([name]) => name)).toEqual([
        'lock',
        'manifest',
        'snapshot',
        'quiescence',
        'observe',
      ]);
      expect(result.phases[0]).toMatchObject({ evidence: { runId: 'run-1' } });
      expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true);
    } finally {
      release.resolve(); // whatever happened above, nothing stays held
      if (!(await confirmed('the composed run', () => run.state.done)))
        retain(at.base, 'the composed run did not settle');
    }
  }, 60_000);

  it.each([
    [
      'throws where it is called',
      () => {
        throw new Error('SENTINEL-SECRET while building');
      },
    ],
    ['returns something that is not a list', () => ({ name: 'observe' }) as never],
    ['returns a phase that is not an object', () => ['observe' as never]],
    [
      'returns a phase without a name',
      () => [{ run: async () => ({ kind: 'completed' }) } as never],
    ],
    [
      'returns a phase whose run is not a function',
      () => [{ name: 'observe', run: 'soon' } as never],
    ],
    [
      'returns a phase whose cleanup is not a function',
      () => [{ name: 'observe', run: async () => ({ kind: 'completed' }), cleanup: 1 } as never],
    ],
    [
      // bindable, so only validation catches it: binding alone would let it through to the runner
      'returns a phase whose cleanup merely looks bindable',
      () =>
        [
          {
            name: 'observe',
            run: async () => ({ kind: 'completed' }),
            cleanup: { bind: () => 'not a function' },
          },
        ] as never,
    ],
    [
      'returns a phase whose name throws when read',
      () =>
        [
          {
            get name(): string {
              throw new Error('SENTINEL-SECRET from a getter');
            },
            run: async () => ({ kind: 'completed' }),
          },
        ] as never,
    ],
  ])(
    'refuses before starting when the builder %s',
    async (_label, after) => {
      const at = workspace();
      bootstrapManifest(at);
      const result = await researchRun(configOf(at), {
        spawn: trackingSpawn,
        after: after as never,
      });

      expect(result.outcome).toEqual({
        name: 'start',
        status: 'refused',
        why: 'the supplied phases could not be built',
      });
      expect(JSON.stringify(result)).not.toContain('SENTINEL');
      expect(status(result).map(([name]) => name)).toEqual([
        'lock',
        'manifest',
        'snapshot',
        'quiescence',
      ]);
      expect(tracked).toEqual([]); // nothing was started
      expect(existsSync(join(at.runs, 'run-1'))).toBe(false);
      expect(readdirSync(at.control)).toEqual(['bootstrap.json']); // and nothing was touched
    },
    60_000,
  );

  it('refuses an accidentally asynchronous builder, and leaves no rejection unobserved', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', watch);
    try {
      const result = await researchRun(configOf(at), {
        spawn: trackingSpawn,
        after: (async () => {
          throw new Error('SENTINEL-SECRET from an async builder');
        }) as never,
      });
      expect(result.outcome).toMatchObject({
        status: 'refused',
        why: 'the supplied phases could not be built',
      });
      expect(tracked).toEqual([]); // refused without awaiting it, and without starting anything
      await sleepReal(100); // a turn in which an unobserved rejection would have surfaced
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', watch);
    }
  }, 60_000);

  it('hands later phases the identical baseline, while its own evidence carries only counts', async () => {
    const at = workspace();
    bootstrapManifest(at);
    writeFileSync(join(at.research, 'notes.txt'), 'observed\n');
    const seen: { first?: unknown; second?: unknown } = {};

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: (context) => [
        {
          name: 'observe',
          run: async () => {
            seen.first = context.baseline();
            seen.second = context.baseline();
            // a supplied phase may report whatever it likes, entries included: this boundary is
            // about what the run writes on its own, not about what a caller chooses to return
            return {
              kind: 'completed',
              evidence: { entries: (seen.first as Snapshot).entries.length },
            };
          },
        },
      ],
    });

    expect(seen.first).toBe(seen.second); // the same object, not a copy per call
    const baseline = seen.first as Snapshot;
    expect(baseline.complete).toBe(true);
    expect(baseline.entries.map((e) => e.path)).toContain('notes.txt');
    expect(Object.isFrozen(baseline)).toBe(true);
    // the phase's own evidence names counts and nothing else
    expect(result.phases[2]).toMatchObject({
      name: 'snapshot',
      evidence: { root: at.research, entries: baseline.entries.length, complete: true },
    });
    const written = readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8');
    expect(written).not.toContain('notes.txt'); // automatic evidence carries no entry of the tree
  }, 60_000);

  it('keeps the partial baseline of a walk stopped at the deadline, and stops supplied work', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const marker = join(at.scratch, 'walked');
    // the shim resists only the walk: it emits one valid entry, says so, then blocks
    const shim = join(at.scratch, 'blocking-python');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env python3',
        'import json, os, runpy, sys, time',
        "if sys.argv[1].endswith('snapshot-tree.py'):",
        '    entry = {"type": "entry", "path": "notes.txt", "kind": "file",',
        '             "size": "1", "mtimeNs": "2", "dev": "3", "ino": "4"}',
        '    sys.stdout.write(json.dumps(entry) + "\\n")',
        '    sys.stdout.flush()',
        `    open(${JSON.stringify(marker)}, "w").close()`,
        '    time.sleep(3600)',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const ran: string[] = [];
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at, { budgetMs: 8_000, cleanupReserveMs: 4_000 }), {
      spawn: trackingSpawn,
      python: shim,
      after: (given) => (
        (context = given),
        [observing('observe', () => ran.push('observe'), at.control)]
      ),
    });

    await untilReady('the walk to reach its barrier', () => existsSync(marker), 20_000);
    expect(result.outcome).toMatchObject({ name: 'snapshot', status: 'refused' });
    expect((result.outcome as { why: string }).why).toContain(
      'the baseline snapshot is incomplete',
    );
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'refused'],
      ['quiescence', 'not_run'],
      ['observe', 'not_run'],
    ]);
    expect(ran).toEqual([]); // supplied work never ran behind a baseline that was not established
    // the partial walk is still the baseline, inspected through the context the builder captured
    const partial = context?.baseline();
    expect(partial?.complete).toBe(false);
    expect(partial?.entries.map((e) => e.path)).toEqual(['notes.txt']);
    // and the lock went back despite the run stopping here
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    // it does not resist the signal, so SIGTERM alone ended it; the exit says which
    expect(tracked[2]?.kills).toEqual(['SIGTERM']);
    expect(tracked[2]?.exit).toEqual({ code: null, signal: 'SIGTERM' });
  }, 60_000);

  it('observes the promise a thenable’s then returns, not only the thenable', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', watch);
    try {
      const result = await researchRun(configOf(at), {
        spawn: trackingSpawn,
        // adoption would call then and discard what it returned: that promise rejects on its own
        after: {
          async then() {
            throw new Error('SENTINEL-SECRET from an async then');
          },
        } as never,
      });
      expect(result.outcome).toMatchObject({
        status: 'refused',
        why: 'the supplied phases could not be built',
      });
      expect(tracked).toEqual([]);
      await sleepReal(100); // a turn in which an unobserved rejection would have surfaced
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('SENTINEL');
    } finally {
      process.off('unhandledRejection', watch);
    }
  }, 60_000);

  it('reports a directory the walk could not list, keeping what it did see', async () => {
    const at = workspace();
    bootstrapManifest(at);
    mkdirSync(join(at.research, 'closed'));
    writeFileSync(join(at.research, 'closed', 'inside.txt'), 'hidden\n');
    writeFileSync(join(at.research, 'open.txt'), 'seen\n');
    // the real helper, with one directory made unlistable by its own device and inode, so the
    // fault lands the same way whatever user runs this
    const shim = join(at.scratch, 'blind-python');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env python3',
        'import os, runpy, sys',
        "if sys.argv[1].endswith('snapshot-tree.py'):",
        `    target = os.stat(${JSON.stringify(join(at.research, 'closed'))})`,
        '    real_scandir = os.scandir',
        '    def scandir(fd):',
        '        seen = os.fstat(fd)',
        '        if (seen.st_dev, seen.st_ino) == (target.st_dev, target.st_ino):',
        '            raise PermissionError(13, "Permission denied")',
        '        return real_scandir(fd)',
        '    os.scandir = scandir',
        '    os.supports_fd = set(os.supports_fd) | {scandir}',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      python: shim,
      after: (given) => ((context = given), []),
    });

    expect(result.outcome).toMatchObject({ name: 'snapshot', status: 'refused' });
    expect((result.outcome as { why: string }).why).toBe(
      'the baseline snapshot is incomplete; diagnostics: cannot list ×1',
    );
    const baseline = context?.baseline();
    expect(baseline?.complete).toBe(false);
    const paths = baseline?.entries.map((e) => e.path) ?? [];
    expect(paths).toContain('open.txt'); // what it could read is kept
    expect(paths).toContain('closed'); // the directory itself was seen
    expect(paths).not.toContain('closed/inside.txt'); // its contents were never listed
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  it('reports a root the walk could not open at all', async () => {
    const at = workspace();
    bootstrapManifest(at);
    rmSync(at.research, { recursive: true, force: true }); // the tree named by the configuration
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: (given) => ((context = given), []),
    });

    expect((result.outcome as { why: string }).why).toBe(
      'the baseline snapshot is incomplete; diagnostics: cannot open root ×1',
    );
    expect(context?.baseline()).toMatchObject({ complete: false, entries: [], problems: [] });
    expect(result.cleanupDiagnostics).toEqual([]); // the lock still went back
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  it('dispatches the walk with the bounds the phase owns', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const argv = join(at.scratch, 'argv');
    const shim = join(at.scratch, 'recording-python');
    writeFileSync(
      shim,
      ['#!/bin/sh', `printf '%s\\n' "$*" >> ${JSON.stringify(argv)}`, 'exec python3 "$@"', ''].join(
        '\n',
      ),
      { mode: 0o755 },
    );

    const result = await researchRun(configOf(at), { spawn: trackingSpawn, python: shim });

    expect(result.outcome).toEqual({ kind: 'completed' });
    const walk = readFileSync(argv, 'utf8')
      .split('\n')
      .find((line) => line.includes('snapshot-tree.py'));
    expect(walk).toContain(`--cap ${String(SNAPSHOT_CAP)}`); // the phase's own cap, not a caller's
    expect(walk).toContain(`--root ${at.research}`);
  }, 60_000);

  it('leaves the walk unrun when the budget goes after the manifest, and still releases the lock', async () => {
    const at = workspace();
    const body = bootstrapManifest(at);
    const BUDGET = 8_000;
    const RESERVE = 4_000;
    const origin = 4_000_000;
    const clock = { t: origin };
    let context: RunContext | undefined;
    // the manifest's own child, identified by what it was asked to run. The clock moves on close,
    // not exit: close is where its output is known complete. This listener is registered before
    // runChild's, so it advances the clock, and runChild then records that same close event before
    // any promise continuation runs — the reader still gets a whole stream, and the budget is spent
    // by the time the loop considers the phase after it.
    const watching = ((command: string, args: string[], options: object) => {
      const child = trackingSpawn(command, args, options);
      if (args.some((a) => a.endsWith('read-control-file.py')))
        child.once('close', () => (clock.t = origin + BUDGET - RESERVE));
      return child;
    }) as unknown as typeof spawn;

    const result = await researchRun(
      configOf(at, { budgetMs: BUDGET, cleanupReserveMs: RESERVE }),
      { spawn: watching, now: () => clock.t, after: (given) => ((context = given), []) },
    );

    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'], // validated after the clock moved, so its work still counted
      ['snapshot', 'not_run'],
      ['quiescence', 'not_run'],
    ]);
    expect(result.phases[2]).toMatchObject({ why: 'the run budget was spent' });
    expect(context?.baseline()).toBeUndefined(); // no walk was started
    expect(tracked.map((t) => t.exit?.code)).toEqual([0, 0, 0]); // acquire, manifest read, release
    expect(tracked.some((t) => t.argv?.some((a) => a.endsWith('snapshot-tree.py')))).toBe(false);
    expect(result.cleanupDiagnostics).toEqual([]); // released inside the reserve
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(body);
  }, 60_000);

  it('reports an interpreter that fails before the walk’s helper can run', async () => {
    const at = workspace();
    bootstrapManifest(at);
    // not the helper failing: the interpreter exits before it ever executes the walk
    const shim = join(at.scratch, 'refusing-python');
    writeFileSync(
      shim,
      ['#!/bin/sh', 'case "$1" in *snapshot-tree.py) exit 3 ;; esac', 'exec python3 "$@"', ''].join(
        '\n',
      ),
      { mode: 0o755 },
    );
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      python: shim,
      after: (given) => ((context = given), []),
    });

    expect((result.outcome as { why: string }).why).toBe(
      'the baseline snapshot is incomplete (exited 3, the stream has no done)',
    );
    expect(context?.baseline()).toMatchObject({ complete: false, entries: [] });
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  /**
   * An interpreter that counts invocations of the walk in a file, so a shim can act on the second
   * one only: both walks run the same helper, and the baseline must be left alone.
   */
  const secondWalkShim = (at: { scratch: string }, body: readonly string[]) => {
    const counter = join(at.scratch, 'walks');
    const shim = join(at.scratch, 'second-walk-python');
    writeFileSync(
      shim,
      [
        '#!/usr/bin/env python3',
        'import os, runpy, sys',
        "if sys.argv[1].endswith('snapshot-tree.py'):",
        `    counter = ${JSON.stringify(counter)}`,
        '    walks = (open(counter).read() if os.path.exists(counter) else "") + "x"',
        '    open(counter, "w").write(walks)',
        '    if len(walks) == 2:',
        ...body.map((line) => `        ${line}`),
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { shim, walks: () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0) };
  };

  it('completes when two consecutive walks find the tree unchanged', async () => {
    const at = workspace();
    bootstrapManifest(at);
    writeFileSync(join(at.research, 'settings.json'), '{"a":1}\n');
    const seen: {
      baseline?: unknown;
      second?: unknown;
      twice?: unknown;
      compared?: unknown;
      comparedAgain?: unknown;
    } = {};

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: (context) => [
        {
          name: 'observe',
          run: async () => {
            seen.baseline = context.baseline();
            seen.second = context.second();
            seen.twice = context.second();
            seen.compared = context.comparison();
            seen.comparedAgain = context.comparison();
            return { kind: 'completed' };
          },
        },
      ],
    });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(result.phases[3]).toMatchObject({
      name: 'quiescence',
      status: 'completed',
      evidence: {
        root: at.research,
        rows: {
          total: 0,
          zone: {
            transcript: { created: 0, deleted: 0, changed: 0, unconfirmed: 0 },
            configuration: { created: 0, deleted: 0, changed: 0, unconfirmed: 0 },
          },
        },
      },
    });
    expect(seen.second).toBe(seen.twice); // the identical walk, not a copy per call
    expect(seen.second).not.toBe(seen.baseline); // and not the baseline either
    expect(seen.compared).toBeDefined(); // a comparison was made, and it is one object as well
    expect(seen.compared).toBe(seen.comparedAgain);
    expect((seen.compared as { rows: unknown[] }).rows).toEqual([]);
    expect((seen.second as Snapshot).complete).toBe(true);
    expect(tracked).toHaveLength(5);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  it('refuses when a file grows between the walks, and says so in the summary', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const grows = join(at.research, 'settings.json');
    writeFileSync(grows, '{"a":1}\n');
    // deterministic: the file's size changes, whatever the filesystem's timestamp resolution
    const { shim, walks } = secondWalkShim(at, [
      `open(${JSON.stringify(grows)}, "a").write("padding that changes the size\\n")`,
    ]);
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      python: shim,
      after: (given) => ((context = given), [observing('observe', () => undefined, at.control)]),
    });

    expect(walks()).toBe(2); // both walks ran the same helper; only the second changed anything
    expect(result.outcome).toMatchObject({ name: 'quiescence', status: 'refused' });
    expect((result.outcome as { why: string }).why).toBe('the tree differs between the two walks');
    const rows = context?.comparison()?.rows ?? [];
    // the size row is the established one; whether the timestamp also moved is the filesystem's business
    expect(rows.filter((r) => r.type === 'changed' && r.field === 'size')).toHaveLength(1);
    expect(rows.every((r) => r.type === 'changed' && r.zone === 'configuration')).toBe(true);
    const evidence = (
      result.phases[3] as {
        evidence: { rows: { total: number; zone: Record<string, Record<string, number>> } };
      }
    ).evidence;
    expect(evidence.rows.total).toBe(rows.length);
    expect(evidence.rows.zone.configuration?.changed).toBe(rows.length);
    expect(evidence.rows.zone.transcript).toEqual({
      created: 0,
      deleted: 0,
      changed: 0,
      unconfirmed: 0,
    });
    // the same evidence reaches the written summary, not only the returned result
    const summary = JSON.parse(
      readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8'),
    ) as RunResult;
    expect(summary.phases[3]).toMatchObject({
      status: 'refused',
      why: 'the tree differs between the two walks',
      evidence: {
        root: at.research,
        rows: {
          total: rows.length,
          zone: {
            configuration: {
              created: 0,
              deleted: 0,
              changed: rows.length, // every row is this file's, and every one is a change
              unconfirmed: 0,
            },
            transcript: { created: 0, deleted: 0, changed: 0, unconfirmed: 0 },
          },
        },
      },
    });
    expect(result.cleanupDiagnostics).toEqual([]);
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
  }, 60_000);

  it('refuses when the second walk cannot finish, keeping the baseline it already had', async () => {
    const at = workspace();
    const manifest = bootstrapManifest(at);
    writeFileSync(join(at.research, 'settings.json'), '{"a":1}\n');
    const { shim, walks } = secondWalkShim(at, ['import time', 'time.sleep(3600)']);
    const ran: string[] = [];
    let context: RunContext | undefined;

    const result = await researchRun(configOf(at, { budgetMs: 8_000, cleanupReserveMs: 4_000 }), {
      spawn: trackingSpawn,
      python: shim,
      after: (given) => (
        (context = given),
        [observing('observe', () => ran.push('observe'), at.control)]
      ),
    });

    expect(walks()).toBe(2);
    expect(result.outcome).toMatchObject({ name: 'quiescence', status: 'refused' });
    expect((result.outcome as { why: string }).why).toBe('the second walk is incomplete');
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'refused'],
      ['observe', 'not_run'],
    ]);
    expect(ran).toEqual([]);
    expect(context?.baseline()?.complete).toBe(true); // the first walk is untouched
    expect(context?.second()?.complete).toBe(false); // the second is kept as far as it got
    expect(result.cleanupDiagnostics).toEqual([]); // and the lock still went back
    // said by the directory itself: the lock and its temporary file are gone, the manifest is not
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(manifest);
  }, 60_000);

  it('refuses a supplied phase that claims the quiescence name', async () => {
    const at = workspace();
    bootstrapManifest(at);
    const claimed = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      after: [observing('quiescence', () => undefined, at.control)],
    });
    expect(claimed.outcome).toEqual({
      name: 'start',
      status: 'refused',
      why: 'a supplied phase may not be named quiescence',
    });
    expect(tracked).toEqual([]);
    expect(existsSync(join(at.runs, 'run-1'))).toBe(false);
  }, 60_000);

  it('leaves the second walk unrun when the budget goes after the first', async () => {
    const at = workspace();
    const manifest = bootstrapManifest(at);
    const BUDGET = 8_000;
    const RESERVE = 4_000;
    const origin = 5_000_000;
    const clock = { t: origin };
    let context: RunContext | undefined;
    // on the first walk's close — its output is complete then, and this listener is registered
    // before runChild's, so the clock moves before any promise continuation of the reader
    const watching = ((command: string, args: string[], options: object) => {
      const child = trackingSpawn(command, args, options);
      if (args.some((a) => a.endsWith('snapshot-tree.py')))
        child.once('close', () => (clock.t = origin + BUDGET - RESERVE));
      return child;
    }) as unknown as typeof spawn;

    const result = await researchRun(
      configOf(at, { budgetMs: BUDGET, cleanupReserveMs: RESERVE }),
      { spawn: watching, now: () => clock.t, after: (given) => ((context = given), []) },
    );

    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'not_run'],
    ]);
    expect(result.phases[3]).toMatchObject({ why: 'the run budget was spent' });
    expect(context?.baseline()?.complete).toBe(true);
    expect(context?.second()).toBeUndefined();
    expect(context?.comparison()).toBeUndefined();
    expect(tracked.filter((t) => t.argv.some((a) => a.endsWith('snapshot-tree.py')))).toHaveLength(
      1,
    );
    expect(result.cleanupDiagnostics).toEqual([]); // released inside the reserve
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(manifest);
  }, 60_000);

  it('rehearses a whole pre-launch run offline, and leaves exactly its summary behind', async () => {
    const at = workspace();
    const manifest = bootstrapManifest(at);
    // a small research tree of known shape: what the walk reports is what is here
    mkdirSync(join(at.research, 'projects'));
    const tree = {
      'notes.txt': 'kept as written\n',
      'settings.json': '{"cohort":"fictitious"}\n',
      'projects/a.jsonl': '{"turn":1}\n',
    };
    for (const [path, body] of Object.entries(tree)) writeFileSync(join(at.research, path), body);
    const entries = ['notes.txt', 'projects', 'projects/a.jsonl', 'settings.json'];

    // no injected phases, no injected wrappers, no clock: only the spawn this test accounts for
    const result = await researchRun(configOf(at), { spawn: trackingSpawn });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(result.summary).toEqual({ written: true, path: join(at.runs, 'run-1', 'run.json') });

    // the summary as written, field by field, with nothing unexpected in it
    const written = JSON.parse(readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(written).sort()).toEqual([
      'budgetMs',
      'cleanupDiagnostics',
      'cleanupReserveMs',
      'outcome',
      'phases',
      'runId',
    ]);
    expect([written.runId, written.budgetMs, written.cleanupReserveMs]).toEqual([
      'run-1',
      30_000,
      10_000,
    ]);
    expect(written.outcome).toEqual({ kind: 'completed' });
    expect(written.cleanupDiagnostics).toEqual([]);

    const phases = written.phases as Record<string, unknown>[];
    expect(phases.map((p) => [p.name, p.status])).toEqual([
      ['lock', 'completed'],
      ['manifest', 'completed'],
      ['snapshot', 'completed'],
      ['quiescence', 'completed'],
    ]);
    for (const phase of phases)
      expect(Object.keys(phase).sort()).toEqual([
        'endedAt',
        'evidence',
        'name',
        'startedAt',
        'status',
      ]);
    // timestamps by type and order, never by value
    let previous = 0;
    for (const phase of phases) {
      const started = phase.startedAt as number;
      const ended = phase.endedAt as number;
      expect([typeof started, typeof ended]).toEqual(['number', 'number']);
      expect(ended).toBeGreaterThanOrEqual(started);
      expect(started).toBeGreaterThanOrEqual(previous);
      previous = ended;
    }
    const none = { created: 0, deleted: 0, changed: 0, unconfirmed: 0 };
    expect(phases.map((p) => p.evidence)).toEqual([
      { controlDir: at.control, runId: 'run-1', diagnostics: [] },
      {
        claudeVersion: '2.1.0',
        bootstrappedAt: '2026-09-17T08:00:00Z',
        separateAuthorization: 'unknown',
      },
      { root: at.research, entries: entries.length, complete: true, diagnostics: [] },
      {
        root: at.research,
        before: entries.length,
        after: entries.length,
        rows: { total: 0, zone: { transcript: none, configuration: none } },
        second: { problems: [], diagnostics: [] },
      },
    ]);

    // five children, each identified by what it was asked to do, each ending on its own
    const asked = tracked.map((t) => {
      // each helper named explicitly: anything else is reported as itself and fails the sequence
      if (t.argv.some((a) => a.endsWith('lock-file.py')))
        return `lock:${String(t.argv[t.argv.indexOf('--mode') + 1])}`;
      if (t.argv.some((a) => a.endsWith('read-control-file.py'))) return 'manifest';
      if (t.argv.some((a) => a.endsWith('snapshot-tree.py'))) return 'walk';
      return `unknown: ${t.argv.join(' ')}`;
    });
    expect(asked).toEqual(['lock:acquire', 'manifest', 'walk', 'walk', 'lock:release']);
    expect(tracked.map((t) => [t.exit?.code, t.exit?.signal, t.kills])).toEqual(
      Array.from({ length: 5 }, () => [0, null, []]),
    );

    // the lock is gone and the manifest is not: the control directory says both
    expect(readdirSync(at.control)).toEqual(['bootstrap.json']);
    expect(readFileSync(join(at.control, 'bootstrap.json'), 'utf8')).toBe(manifest);
    // the summary is here now, before any teardown runs
    expect(readdirSync(join(at.runs, 'run-1'))).toEqual(['run.json']);
    // the tree it read is exactly as it was, and nothing was put anywhere else
    for (const [path, body] of Object.entries(tree))
      expect(readFileSync(join(at.research, path), 'utf8')).toBe(body);
    expect(
      readdirSync(at.research, { recursive: true })
        .map((name) => String(name))
        .sort(),
    ).toEqual(entries);
    expect([readdirSync(at.operator), readdirSync(at.scratch)]).toEqual([[], []]);
    // the workspace itself goes only once afterEach confirms every child ended
  }, 120_000);
});
