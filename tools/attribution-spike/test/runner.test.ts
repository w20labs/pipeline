import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configProblem,
  nodeRunnerFs,
  type Phase,
  type RunConfig,
  type RunnerFs,
  runResearch,
} from '../src/runner.js';

const T0 = 1_000_000;
const CONFIG: RunConfig = {
  runId: 'run-1',
  runsRoot: '/cache/research/runs',
  researchConfig: '/cache/research/claude-config',
  operatorClaudeDir: '/home/op/.claude',
  scratch: '/cache/scratch',
  budgetMs: 10_000,
  cleanupReserveMs: 2_000,
};
const PHASE_DEADLINE = T0 + 8_000;
const DEADLINE = T0 + 10_000;
const AT = { startedAt: T0, endedAt: T0 };
const NOT_STARTED = {
  written: false,
  stage: 'not_attempted',
  why: 'the run did not start; nothing was written',
};

/** A filesystem that only logs, so the order of effects is visible. */
const fakeFs = (over: Partial<RunnerFs> = {}) => {
  const log: string[] = [];
  const written: Record<string, string> = {};
  const fs: RunnerFs = {
    mkdirExclusive: async (path) => void log.push(`mkdir ${path}`),
    writeSummary: async (path, text) => {
      log.push(`summary ${path}`);
      written[path] = text;
    },
    ...over,
  };
  return { fs, log, written };
};
const done =
  (evidence?: unknown): Phase['run'] =>
  async () =>
    evidence === undefined ? { kind: 'completed' } : { kind: 'completed', evidence };
const never = () => new Promise<never>(() => undefined);
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());
const clocked = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
};

describe('the research run skeleton', () => {
  it.each([
    ['a run id with a separator', { runId: 'a/b' }, 'the run id must be a plain name'],
    ['a relative path', { scratch: 'scratch' }, 'every path must be absolute'],
    [
      'the operator directory itself',
      { researchConfig: '/home/op/.claude' },
      "the research configuration must be separate from the operator's Claude directory",
    ],
    [
      'a directory inside the operator’s',
      { researchConfig: '/home/op/.claude/x' },
      "the research configuration must be separate from the operator's Claude directory",
    ],
    [
      'a directory containing the operator’s',
      { researchConfig: '/home/op' },
      "the research configuration must be separate from the operator's Claude directory",
    ],
    [
      'a research configuration whose name only begins with ..',
      { researchConfig: '/home/op/.claude/..research' },
      "the research configuration must be separate from the operator's Claude directory",
    ],
    [
      'runs under a ..-prefixed name inside the research configuration',
      { runsRoot: '/cache/research/claude-config/..runs' },
      'run directories must not be inside the research configuration',
    ],
    [
      'runs inside the research configuration',
      { runsRoot: '/cache/research/claude-config/runs' },
      'run directories must not be inside the research configuration',
    ],
    [
      'a reserve as large as the budget',
      { cleanupReserveMs: 10_000 },
      'the budget and cleanup reserve must be positive, with the reserve inside the budget',
    ],
    [
      'a fractional budget',
      { budgetMs: 1.5 },
      'the budget and cleanup reserve must be positive, with the reserve inside the budget',
    ],
  ] as const)('refuses %s before touching anything', async (_label, over, why) => {
    const { fs, log } = fakeFs();
    const ran: string[] = [];
    const r = await runResearch(
      { ...CONFIG, ...over },
      [{ name: 'a', run: async () => (ran.push('a'), { kind: 'completed' }) }],
      fs,
    );
    expect(r).toEqual({
      outcome: { name: 'start', status: 'refused', why },
      phases: [{ name: 'a', status: 'not_run', why: 'the run did not start' }],
      cleanupDiagnostics: [],
      summary: NOT_STARTED,
    });
    expect([log, ran]).toEqual([[], []]);
  });

  it('accepts siblings whose names merely begin like a protected directory', () => {
    const siblings = {
      researchConfig: '/home/op/.claude..x',
      runsRoot: '/home/op/.claude..x..runs',
    };
    expect(configProblem({ ...CONFIG, ...siblings })).toBeUndefined();
  });

  it('runs phases in order, keeps only evidence they reported, and writes the summary last', async () => {
    clocked();
    const { fs, log, written } = fakeFs();
    const phases: Phase[] = [
      {
        name: 'versions',
        run: async () => (
          log.push('versions'),
          { kind: 'completed', evidence: { size: 2n ** 60n } }
        ),
      },
      {
        name: 'quiet',
        run: async () => (log.push('quiet'), { kind: 'completed' }),
        cleanup: async () => (log.push('clean quiet'), undefined),
      },
    ];
    const r = await runResearch(CONFIG, phases, fs);
    const path = '/cache/research/runs/run-1/run.json';
    expect(log).toEqual([
      'mkdir /cache/research/runs/run-1',
      'versions',
      'quiet',
      'clean quiet',
      `summary ${path}`,
    ]);
    expect(r).toEqual({
      outcome: { kind: 'completed' },
      phases: [
        { ...AT, name: 'versions', status: 'completed', evidence: { size: 2n ** 60n } },
        { ...AT, name: 'quiet', status: 'completed' }, // no evidence reported, none invented
      ],
      cleanupDiagnostics: [],
      summary: { written: true, path },
    });
    expect(JSON.parse(written[path] ?? '')).toEqual({
      runId: 'run-1',
      budgetMs: 10_000,
      cleanupReserveMs: 2_000,
      outcome: { kind: 'completed' },
      phases: [
        { ...AT, name: 'versions', status: 'completed', evidence: { size: '1152921504606846976' } },
        { ...AT, name: 'quiet', status: 'completed' },
      ],
      cleanupDiagnostics: [],
    });
  });

  it.each([
    [
      'refuses',
      async () => ({ kind: 'refused', why: 'lock held' }) as const,
      { status: 'refused', why: 'lock held' },
    ],
    ['rejects', () => Promise.reject(new Error('boom')), { status: 'failed', why: 'boom' }],
    [
      'throws synchronously',
      () => {
        throw new Error('sync boom');
      },
      { status: 'failed', why: 'sync boom' },
    ],
  ] as [string, Phase['run'], object][])(
    'stops when a phase %s, cleaning only what started, in reverse',
    async (_l, run, stopped) => {
      clocked();
      const { fs, log } = fakeFs();
      // settles 250 ms after it started: the record carries the observed settlement time
      const settling: Phase['run'] = (context) => (vi.setSystemTime(T0 + 250), run(context));
      const clean = (name: string) => async () => (log.push(`clean ${name}`), undefined);
      const r = await runResearch(
        CONFIG,
        [
          { name: 'a', run: done(), cleanup: clean('a') },
          { name: 'b', run: settling, cleanup: clean('b') },
          { name: 'c', run: done(), cleanup: clean('c') },
        ],
        fs,
      );
      expect(r.outcome).toEqual({ name: 'b', ...stopped, startedAt: T0, endedAt: T0 + 250 });
      expect(r.phases[2]).toEqual({ name: 'c', status: 'not_run', why: 'the run stopped at b' });
      expect(log.slice(1)).toEqual([
        'clean b',
        'clean a',
        'summary /cache/research/runs/run-1/run.json',
      ]);
    },
  );

  it('gives every phase the same absolute deadline, and a timeout buys no time', async () => {
    clocked();
    const { fs } = fakeFs();
    const seen: number[] = [];
    let late = false;
    const pending = runResearch(
      CONFIG,
      [
        {
          name: 'slow',
          run: async ({ deadline }) => (
            seen.push(deadline),
            await after(7_000),
            { kind: 'completed' }
          ),
        },
        {
          name: 'hung',
          run: async ({ deadline }) => {
            seen.push(deadline);
            await after(5_000); // past its deadline: the run has already moved on
            late = true;
            return { kind: 'completed', evidence: 'late' };
          },
          cleanup: async (deadline) => (seen.push(deadline), undefined),
        },
        { name: 'next', run: done() },
      ],
      fs,
      Date.now,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const r = await pending;
    expect(seen).toEqual([PHASE_DEADLINE, PHASE_DEADLINE, DEADLINE]);
    expect(r.phases).toEqual([
      { name: 'slow', status: 'completed', startedAt: T0, endedAt: T0 + 7_000 },
      {
        name: 'hung',
        status: 'timed_out',
        why: 'the phase did not finish by its deadline',
        startedAt: T0 + 7_000,
        endedAt: PHASE_DEADLINE, // when waiting ended, not when the phase did
      },
      { name: 'next', status: 'not_run', why: 'the run stopped at hung' },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(late).toBe(true);
    expect(r.phases[1]).toMatchObject({ status: 'timed_out' }); // a late result changes nothing
  });

  it.each([
    ['before the first phase', 0],
    ['between phases', 1],
  ])('never reports success when the budget runs out %s', async (_label, spentAfter) => {
    clocked();
    const spend = async () => void vi.setSystemTime(PHASE_DEADLINE);
    const { fs } = fakeFs(spentAfter === 0 ? { mkdirExclusive: spend } : {});
    const first: Phase = { name: 'a', run: async () => (await spend(), { kind: 'completed' }) };
    const r = await runResearch(
      CONFIG,
      [first, { name: 'b', run: done() }, { name: 'c', run: done() }].slice(
        spentAfter === 0 ? 1 : 0,
      ),
      fs,
      Date.now,
    );
    const skipped = (name: string) => ({
      name,
      status: 'not_run',
      why: 'the run budget was spent',
    });
    expect(r.outcome).toEqual(skipped('b'));
    expect(r.phases.slice(-2)).toEqual([skipped('b'), skipped('c')]); // the budget, not "stopped at b"
  });

  it('counts a result that arrives after the deadline as late, even before any timer fires', async () => {
    clocked();
    const { fs } = fakeFs();
    // each time, the clock passes the deadline while the event loop is busy and no timer can fire
    const r = await runResearch(
      CONFIG,
      [
        {
          name: 'blocked',
          run: async () => (vi.setSystemTime(PHASE_DEADLINE + 1), { kind: 'completed' }),
          cleanup: async () => (vi.setSystemTime(DEADLINE + 1), 'never reported'),
        },
      ],
      fs,
      Date.now,
    );
    expect(r.phases).toEqual([
      {
        name: 'blocked',
        status: 'timed_out',
        why: 'the phase did not finish by its deadline',
        startedAt: T0,
        endedAt: PHASE_DEADLINE + 1,
      },
    ]);
    expect(r.cleanupDiagnostics).toEqual(['blocked: cleanup did not finish by the run deadline']);
  });

  it('keeps cleaning after a cleanup throws or hangs, within the one deadline', async () => {
    clocked();
    const { fs } = fakeFs();
    const pending = runResearch(
      CONFIG,
      [
        { name: 'a', run: done(), cleanup: async () => 'server stop failed' },
        { name: 'b', run: done(), cleanup: never },
        { name: 'c', run: done(), cleanup: () => Promise.reject(new Error('delete failed')) },
      ],
      fs,
      Date.now,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).cleanupDiagnostics).toEqual([
      'c: cleanup threw: delete failed',
      'b: cleanup did not finish by the run deadline',
      'a: cleanup not run: the run budget was spent',
    ]);
  });

  it('keeps the original failure, cleanup diagnostics and a summary failure apart', async () => {
    clocked();
    const { fs } = fakeFs({ writeSummary: () => Promise.reject(new Error('disk full')) });
    const r = await runResearch(
      CONFIG,
      [
        {
          name: 'a',
          run: () => Promise.reject(new Error('boom')),
          cleanup: async () => 'stop failed',
        },
      ],
      fs,
    );
    expect(r).toEqual({
      outcome: { ...AT, name: 'a', status: 'failed', why: 'boom' },
      phases: [{ ...AT, name: 'a', status: 'failed', why: 'boom' }],
      cleanupDiagnostics: ['a: stop failed'],
      summary: { written: false, stage: 'write', why: 'disk full' },
    });
  });

  it('keeps a serialization failure apart from write failures, writing nothing', async () => {
    const { fs, log } = fakeFs();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const r = await runResearch(
      CONFIG,
      [{ name: 'a', run: done(circular), cleanup: async () => 'stop failed' }],
      fs,
    );
    expect(r.cleanupDiagnostics).toEqual(['a: stop failed']);
    expect(r.outcome).toEqual({ kind: 'completed' });
    expect(r.summary).toEqual({
      written: false,
      stage: 'serialization',
      why: expect.stringContaining('circular structure'),
    });
    expect(log).toEqual(['mkdir /cache/research/runs/run-1']);
  });

  /** Filesystem work the test settles by hand, after the run has stopped waiting for it. */
  const deferred = () => {
    let settle: { resolve: () => void; reject: (e: Error) => void } | undefined;
    const promise = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    return { promise, settle: () => settle as NonNullable<typeof settle> };
  };

  it.each(['resolves', 'rejects'])(
    'gives up on a hung directory creation that later %s, starting nothing',
    async (later) => {
      clocked();
      const creation = deferred();
      const { fs, log } = fakeFs({ mkdirExclusive: () => creation.promise });
      const ran: string[] = [];
      const pending = runResearch(
        CONFIG,
        [{ name: 'a', run: async () => (ran.push('a'), { kind: 'completed' }) }],
        fs,
        Date.now,
      );
      let r: Awaited<typeof pending> | undefined;
      void pending.then((result) => (r = result));
      await vi.advanceTimersByTimeAsync(8_000 - 1);
      expect(r).toBeUndefined(); // still waiting until the phase deadline, and not beyond it
      await vi.advanceTimersByTimeAsync(1);
      if (r === undefined) throw new Error('the run did not give up at its phase deadline');
      expect(r).toEqual({
        outcome: {
          name: 'start',
          status: 'refused',
          why: 'the run directory was not created by its deadline; it may still appear',
        },
        phases: [{ name: 'a', status: 'not_run', why: 'the run did not start' }],
        cleanupDiagnostics: [],
        summary: NOT_STARTED,
      });
      const settled = structuredClone(r);
      if (later === 'resolves') creation.settle().resolve();
      else creation.settle().reject(new Error('EACCES')); // handled: no unhandled rejection
      await vi.advanceTimersByTimeAsync(10_000);
      expect([ran, log, r]).toEqual([[], [], settled]);
    },
  );

  it('gives up on a hung summary write at the run deadline', async () => {
    clocked();
    const write = deferred();
    const { fs } = fakeFs({ writeSummary: () => write.promise });
    const pending = runResearch(CONFIG, [{ name: 'a', run: done() }], fs, Date.now);
    let r: Awaited<typeof pending> | undefined;
    void pending.then((result) => (r = result));
    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(r).toBeUndefined(); // the whole run deadline, and no longer
    await vi.advanceTimersByTimeAsync(1);
    if (r === undefined) throw new Error('the run did not give up at its deadline');
    const summary = {
      written: false,
      stage: 'write',
      why: 'the summary write did not finish by the run deadline; a partial file may remain',
    };
    expect(r.summary).toEqual(summary);
    write.settle().reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.summary).toEqual(summary);
  });

  it('does not attempt the summary once serializing it has spent the budget', async () => {
    clocked();
    const { fs, log } = fakeFs();
    const slow = { toJSON: () => (vi.setSystemTime(DEADLINE), 'serialized') };
    const r = await runResearch(CONFIG, [{ name: 'a', run: done(slow) }], fs, Date.now);
    expect(r.summary).toEqual({
      written: false,
      stage: 'not_attempted',
      why: 'the run budget was spent',
    });
    expect(log).toEqual(['mkdir /cache/research/runs/run-1']); // no write call at all
  });

  it('does not attempt the summary once cleanup has spent the budget', async () => {
    clocked();
    const { fs, log } = fakeFs();
    const r = await runResearch(
      CONFIG,
      [{ name: 'a', run: done(), cleanup: async () => void vi.setSystemTime(DEADLINE) }],
      fs,
      Date.now,
    );
    expect(r.summary).toEqual({
      written: false,
      stage: 'not_attempted',
      why: 'the run budget was spent',
    });
    expect(log).toEqual(['mkdir /cache/research/runs/run-1']);
  });

  describe('on a real filesystem', () => {
    const made: string[] = [];
    afterEach(() => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

    it('refuses an existing run directory and leaves it, and its summary, untouched', async () => {
      const runsRoot = mkdtempSync(join(tmpdir(), 'pipeline-runner-'));
      made.push(runsRoot);
      mkdirSync(join(runsRoot, 'run-1'));
      writeFileSync(join(runsRoot, 'run-1', 'run.json'), 'an earlier run');
      const ran: string[] = [];
      const r = await runResearch(
        { ...CONFIG, runsRoot },
        [{ name: 'a', run: async () => (ran.push('a'), { kind: 'completed' }) }],
        nodeRunnerFs,
      );
      expect(r.outcome).toMatchObject({ name: 'start', status: 'refused' });
      expect(r.summary).toEqual(NOT_STARTED);
      expect(ran).toEqual([]);
      expect(readdirSync(join(runsRoot, 'run-1'))).toEqual(['run.json']);
      expect(readFileSync(join(runsRoot, 'run-1', 'run.json'), 'utf8')).toBe('an earlier run');
    });

    it('never overwrites a summary that is already there', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pipeline-runner-'));
      made.push(dir);
      writeFileSync(join(dir, 'run.json'), 'first');
      await expect(nodeRunnerFs.writeSummary(join(dir, 'run.json'), 'second')).rejects.toThrow(
        /EEXIST/,
      );
      expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe('first');
    });

    it('creates the run directory and its summary', async () => {
      const runsRoot = mkdtempSync(join(tmpdir(), 'pipeline-runner-'));
      made.push(runsRoot);
      const r = await runResearch(
        { ...CONFIG, runsRoot },
        [{ name: 'a', run: done() }],
        nodeRunnerFs,
      );
      expect(r.summary).toEqual({ written: true, path: join(runsRoot, 'run-1', 'run.json') });
      expect(JSON.parse(readFileSync(join(runsRoot, 'run-1', 'run.json'), 'utf8'))).toMatchObject({
        outcome: { kind: 'completed' },
      });
    });
  });
});
