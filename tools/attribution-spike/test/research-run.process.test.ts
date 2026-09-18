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

import { afterEach, describe, expect, it } from 'vitest';

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
let dirs: string[] = [];

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
      `termination unconfirmed; kept ${created.join(', ')}: ${unconfirmed.join('; ')}`,
    );
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
}, 30_000);

/** Separate directories for every path the configuration keeps apart. */
const workspace = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-research-run-'));
  dirs.push(base);
  const at: Record<string, string> = {};
  for (const name of ['runs', 'control', 'research', 'operator', 'scratch']) {
    at[name] = join(base, name);
    mkdirSync(at[name] as string);
  }
  return at as {
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
});
