import { type ChildProcess, spawn } from 'node:child_process';
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
import { researchRun } from '../src/research-run.js';
import type { Phase, RunConfig, RunnerFs, RunResult } from '../src/runner.js';

/** A composed run driving the real lock helper. Every process here is the test's own child. */

interface Tracked {
  readonly child: ChildProcess;
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
  const t: Tracked = { child, kills: [] };
  tracked.push(t);
  child.once('exit', (code, signal) => (t.exit = { code, signal }));
  child.once('error', (error) => (t.error = error));
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => (t.kills.push(String(signal)), kill(signal));
  return child;
}) as unknown as typeof spawn;

afterEach(async () => {
  const [children, created] = [tracked, dirs];
  [tracked, dirs] = [[], []];
  const unconfirmed: string[] = [];
  for (const t of children) {
    if (t.exit !== undefined || (t.error !== undefined && t.child.pid === undefined)) continue;
    try {
      t.child.kill('SIGKILL');
    } catch (cause) {
      unconfirmed.push(`pid ${String(t.child.pid)}: SIGKILL threw: ${String(cause)}`);
    }
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      t.child.once('exit', () => (clearTimeout(timer), resolve(true)));
    });
    if (!ended) unconfirmed.push(`pid ${String(t.child.pid)}: no exit within 2 s of SIGKILL`);
  }
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
    expect(readdirSync(at.control)).toEqual([]); // released, and its temporary file cleaned up
    expect(result.cleanupDiagnostics).toEqual([]);

    const summary = JSON.parse(
      readFileSync(join(at.runs, 'run-1', 'run.json'), 'utf8'),
    ) as RunResult;
    expect(status(summary)).toEqual([
      ['lock', 'completed'],
      ['observe', 'completed'],
    ]);
    expect(tracked).toHaveLength(2); // one acquisition, one release
    expect(tracked.map((t) => [t.exit?.code, t.kills])).toEqual([
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
      phases: [{ name: 'lock', status: 'not_run', why: 'the run did not start' }],
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
    after.push(observing('late', () => ran.push('late'), at.control)); // ...the list...
    observer.run = async () => (ran.push('replaced'), { kind: 'completed' }); // ...and a method
    release.resolve();
    const result = await run;

    expect(ran).toEqual(['original']); // the bound method, and no phase added after the fact
    expect(status(result)).toEqual([
      ['lock', 'completed'],
      ['observe', 'completed'],
    ]);
    // the lock identified the run the snapshot named, in the directory it named
    expect(JSON.parse(held[0] ?? '')).toMatchObject({ runId: 'run-1' });
    expect(result.phases[0]).toMatchObject({
      evidence: { controlDir: at.control, runId: 'run-1' },
    });
    expect(existsSync(join(at.runs, 'run-1', 'run.json'))).toBe(true);
    expect(existsSync(join(at.runs, 'moved'))).toBe(false);
    expect(readdirSync(at.control)).toEqual([]);
  }, 60_000);

  it('reports a spent budget without a summary, and says the lock was left behind', async () => {
    const at = workspace();
    const slow = deferred<undefined>();
    let timer: NodeJS.Timeout | undefined;
    const result = await researchRun(configOf(at, { budgetMs: 2_000, cleanupReserveMs: 1_000 }), {
      spawn: trackingSpawn,
      after: [
        {
          name: 'slow',
          run: async () => ({ kind: 'completed' }),
          // outlives the run deadline, so the cleanups after it never get their turn
          cleanup: () => ((timer = setTimeout(() => slow.resolve(undefined), 5_000)), slow.promise),
        },
      ],
    });

    try {
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
      expect(tracked).toHaveLength(1); // the acquisition only: no release was ever started
      // the lock this run took is still there, which is exactly what the diagnostics say
      expect(JSON.parse(readFileSync(join(at.control, 'run.lock'), 'utf8'))).toMatchObject({
        runId: 'run-1',
      });
    } finally {
      // however the assertions ended, the delayed cleanup settles before teardown removes the
      // directory it was handed: a failure must not let disposal outrun work still holding it
      clearTimeout(timer);
      slow.resolve(undefined);
      await slow.promise;
      rmSync(join(at.control, 'run.lock'), { force: true });
    }
  }, 60_000);

  it('reads the run id once, and everything it builds uses that one value', async () => {
    const at = workspace();
    const reads: string[] = [];
    const config = configOf(at) as Mutable<RunConfig>;
    // a valid getter, answering differently after the first read: one snapshot sees only 'run-1'
    Object.defineProperty(config, 'runId', {
      get: () => (reads.push('read'), reads.length === 1 ? 'run-1' : 'moved'),
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
    // an advancing clock a minute behind: the deadline computed here must reach the wrappers, or
    // acquisition compares it against the wall clock and reports a run that never happened
    const result = await researchRun(configOf(at), {
      spawn: trackingSpawn,
      now: () => Date.now() - 60_000,
    });

    expect(result.outcome).toEqual({ kind: 'completed' });
    expect(status(result)).toEqual([['lock', 'completed']]);
    expect(result.phases[0]).toMatchObject({ evidence: { runId: 'run-1', diagnostics: [] } });
    expect(result.cleanupDiagnostics).toEqual([]); // the release measured on it too
    expect(tracked.map((t) => t.exit?.code)).toEqual([0, 0]); // acquisition and release both ran
    expect(readdirSync(at.control)).toEqual([]);
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
    expect(readdirSync(at.control)).toEqual([]);
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

      expect(result.phases.map((p) => p.status)).toEqual(['timed_out']);
      expect(result.cleanupDiagnostics).toEqual([]); // reconciled, then released
      expect(readdirSync(at.control)).toEqual([]);
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
    const reads: string[] = [];
    const ran: string[] = [];
    const impostor = observing('lock', () => ran.push('impostor'), at.control);
    const options = { spawn: trackingSpawn };
    Object.defineProperty(options, 'after', {
      get: () => (reads.push('read'), reads.length === 1 ? [] : [impostor]),
      enumerable: true,
    });

    const result = await researchRun(configOf(at), options);
    expect(reads).toHaveLength(1); // one read, and the composition is built from it
    expect(status(result)).toEqual([['lock', 'completed']]);
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
});
