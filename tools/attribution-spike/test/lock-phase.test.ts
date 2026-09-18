import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcquireOutcome, LockOwner, ReleaseOutcome } from '../src/lock.js';
import { lockPhase } from '../src/lock-phase.js';
import { type Phase, type PhaseResult, runResearch } from '../src/runner.js';

const DIR = '/cache/research/control';
const OWNER: LockOwner = { runId: 'run-1', pid: 4_242, startedAt: '2026-09-17T08:30:00Z' };
const HANDLE = Object.freeze({ controlDir: DIR, runId: 'run-1' });
const DEADLINE = 10_000;
const ACQUIRED: AcquireOutcome = { kind: 'acquired', handle: HANDLE, diagnostics: [] };
const RELEASED: ReleaseOutcome = { kind: 'released', diagnostics: [] };

/**
 * The phase driven with stand-ins for the two wrappers, so a test states exactly what the lock
 * established. Every call is recorded: a phase that spawns when it must not is a visible fact.
 */
const driven = (
  outcomes: {
    acquire?: AcquireOutcome | Promise<AcquireOutcome>;
    release?: ReleaseOutcome | Promise<ReleaseOutcome>;
  } = {},
  now: () => number = () => 0,
) => {
  const asked: { deadline: number }[] = [];
  const gave: { handle: unknown; deadline: number }[] = [];
  const phase: Phase = lockPhase(
    { controlDir: DIR, owner: OWNER },
    {
      acquire: (async (_dir: string, _owner: LockOwner, options: { deadline: number }) => {
        asked.push({ deadline: options.deadline });
        return await (outcomes.acquire ?? ACQUIRED);
      }) as never,
      release: (async (handle: unknown, options: { deadline: number }) => {
        gave.push({ handle, deadline: options.deadline });
        return await (outcomes.release ?? RELEASED);
      }) as never,
      now,
    },
  );
  return { phase, asked, gave };
};
const ran = (phase: Phase): Promise<PhaseResult> =>
  phase.run({ runDir: '/runs/run-1', deadline: DEADLINE });

afterEach(() => vi.useRealTimers());

describe('the lock phase', () => {
  it('completes with what the acquisition established, and gives the lock back', async () => {
    const run = driven();
    expect(await ran(run.phase)).toEqual({
      kind: 'completed',
      evidence: { controlDir: DIR, runId: 'run-1', diagnostics: [] },
    });
    expect(run.asked).toEqual([{ deadline: DEADLINE }]); // bounded by the phase's own deadline
    expect(await run.phase.cleanup?.(DEADLINE)).toBeUndefined(); // released cleanly: nothing to say
    expect(run.gave).toEqual([{ handle: HANDLE, deadline: DEADLINE }]);
  });

  it('keeps every diagnostic, from the acquisition and from the release', async () => {
    const run = driven({
      acquire: {
        kind: 'acquired',
        handle: HANDLE,
        diagnostics: [
          { step: 'unlink_temp', errno: 'EIO' },
          { step: 'close_temp', errno: null },
        ],
      },
      release: { kind: 'released', diagnostics: [{ step: 'temp_replaced', errno: null }] },
    });
    expect(await ran(run.phase)).toEqual({
      kind: 'completed',
      evidence: {
        controlDir: DIR,
        runId: 'run-1',
        diagnostics: ['unlink_temp EIO', 'close_temp'],
      },
    });
    // a released lock is not silent when it reported something on the way
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(
      'the lock was released; diagnostics: temp_replaced',
    );
  });

  it('refuses when another run holds it, keeping the acquisition’s diagnostics', async () => {
    const run = driven({
      acquire: {
        kind: 'held',
        handle: HANDLE,
        diagnostics: [{ step: 'unlink_temp', errno: 'EPERM' }],
      },
      release: { kind: 'missing', diagnostics: [{ step: 'temp_unlink_failed', errno: 'EIO' }] },
    });
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'another run holds the lock; diagnostics: unlink_temp EPERM',
    });
    // cleanup still runs: this run's own leftover is its to remove
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(
      'the lock was missing; diagnostics: temp_unlink_failed EIO',
    );
    expect(run.gave).toHaveLength(1);
  });

  it('reports a refusal by its reason and errno, and repeats nothing else', async () => {
    const run = driven({
      acquire: {
        kind: 'refused',
        handle: HANDLE,
        reason: 'link_failed',
        errno: 'EXDEV',
        diagnostics: [{ step: 'temp_may_remain', errno: null }],
      },
      release: {
        kind: 'refused',
        reason: 'lock_unusable',
        errno: 'EIO',
        diagnostics: [{ step: 'close_directory', errno: 'EBADF' }],
      },
    });
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the lock was refused (link_failed, EXDEV); diagnostics: temp_may_remain',
    });
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(
      'the lock could not be released (lock_unusable, EIO); the lock may remain; diagnostics: close_directory EBADF',
    );
  });

  it('says the lock may remain when the acquisition established nothing', async () => {
    const run = driven({
      acquire: {
        kind: 'unknown',
        handle: HANDLE,
        problems: ['exited 1', 'the output is not exactly one line'],
      },
      release: { kind: 'unknown', problems: ['killed by SIGTERM'], mayRemain: true },
    });
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'whether the lock was taken is not established (exited 1, the output is not exactly one line); the lock may remain',
    });
    // it published something or it did not: cleanup asks, and reports that it still cannot tell
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(
      'whether the lock was released is not established (killed by SIGTERM); the lock may remain',
    );
  });

  it.each([
    ['nothing was spawned', { kind: 'not_attempted', reason: 'invalid_request' } as AcquireOutcome],
    ['the secret failed', { kind: 'not_attempted', reason: 'random_failed' } as AcquireOutcome],
  ])('does not warn when %s', async (_label, acquire) => {
    const run = driven({ acquire });
    const result = await ran(run.phase);
    expect(result).toEqual({
      kind: 'refused',
      why: `the lock was not attempted (${'reason' in acquire ? acquire.reason : ''})`,
    });
    expect(String((result as { why: string }).why)).not.toContain('may remain');
    expect(await run.phase.cleanup?.(DEADLINE)).toBeUndefined(); // no work, so no uncertainty
    expect(run.gave).toEqual([]);
  });

  it('says nothing when the release helper never ran', async () => {
    const run = driven({ release: { kind: 'not_attempted', reason: 'never_ran' } });
    await ran(run.phase);
    expect(await run.phase.cleanup?.(DEADLINE)).toBeUndefined(); // nothing was published
  });

  it.each([
    ['unresolved', 'the lock was not released (unresolved); the lock may remain'],
    ['budget_spent', 'the lock was not released (budget_spent); the lock may remain'],
  ] as const)('warns when a release was refused as %s', async (reason, why) => {
    const run = driven({ release: { kind: 'not_attempted', reason, mayRemain: true } });
    await ran(run.phase);
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(why);
  });

  it('reconciles an acquisition that cleanup did not wait for in vain', async () => {
    // the runner stopped waiting for run(); the helper's answer arrives during cleanup
    let settle: (outcome: AcquireOutcome) => void = () => undefined;
    const pending = new Promise<AcquireOutcome>((resolve) => (settle = resolve));
    const run = driven({ acquire: pending });
    void ran(run.phase);
    const cleaned = run.phase.cleanup?.(DEADLINE);
    settle(ACQUIRED);
    expect(await cleaned).toBeUndefined();
    expect(run.gave).toEqual([{ handle: HANDLE, deadline: DEADLINE }]); // it was released after all
  });

  it('spawns no release for an acquisition still in flight at its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    let settle: (outcome: AcquireOutcome) => void = () => undefined;
    const pending = new Promise<AcquireOutcome>((resolve) => (settle = resolve));
    const run = driven({ acquire: pending }, Date.now);
    void ran(run.phase);
    const cleaned = run.phase.cleanup?.(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cleaned).toBe(
      'the acquisition did not resolve by the cleanup deadline; the lock may remain',
    );
    expect(run.gave).toEqual([]); // the handle is unknown and the budget is gone

    settle(ACQUIRED); // late settlement: heard by no one, and cleanup is over
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.gave).toEqual([]);
  });

  it('rechecks the clock after reconciling, before starting a release', async () => {
    let clock = 0;
    const run = driven({ acquire: Promise.resolve(ACQUIRED) }, () => clock);
    await ran(run.phase);
    clock = 9_000; // reconciling spent what was left of the cleanup budget
    expect(await run.phase.cleanup?.(5_000)).toBe(
      'the cleanup budget was spent before release; the lock may remain',
    );
    expect(run.gave).toEqual([]);
  });

  it('repeats nothing when the acquisition rejects, and keeps the uncertainty', async () => {
    const run = driven({ acquire: Promise.reject(new Error('spawn SENTINEL-SECRET /x ENOENT')) });
    const result = await ran(run.phase);
    expect(result).toEqual({
      kind: 'refused',
      why: 'the lock could not be asked for; the lock may remain',
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    // a call that failed may still have published: silence would claim more than is known
    expect(await run.phase.cleanup?.(DEADLINE)).toBe(
      'the lock could not be asked for; the lock may remain',
    );
    expect(run.gave).toEqual([]); // no handle came back, so nothing is released
  });

  it.each([
    [
      'throws where it is called',
      () => {
        throw new Error('spawn SENTINEL-SECRET ENOENT');
      },
    ],
    [
      'rejects later',
      async () => {
        throw new Error('spawn SENTINEL-SECRET ENOENT');
      },
    ],
  ])('contains an acquisition that %s', async (_label, acquire) => {
    const phase = lockPhase({ controlDir: DIR, owner: OWNER }, { acquire: acquire as never });
    const result = await ran(phase);
    expect(result).toEqual({
      kind: 'refused',
      why: 'the lock could not be asked for; the lock may remain',
    });
    expect(await phase.cleanup?.(DEADLINE)).toBe(
      'the lock could not be asked for; the lock may remain',
    );
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('contains a release that throws where it is called', async () => {
    const gave: unknown[] = [];
    const phase = lockPhase(
      { controlDir: DIR, owner: OWNER },
      {
        now: () => 0,
        acquire: (async () => ACQUIRED) as never,
        release: ((handle: unknown) => {
          gave.push(handle);
          throw new Error('spawn SENTINEL-SECRET ENOENT');
        }) as never,
      },
    );
    await ran(phase);
    const said = await phase.cleanup?.(DEADLINE);
    expect(said).toBe('the lock could not be given back; the lock may remain');
    expect(String(said)).not.toContain('SENTINEL');
    expect(gave).toEqual([HANDLE]); // it was asked: the failure is in the answer, not the request
  });

  it('acquires once: a second run refuses and leaves the first acquisition’s ownership', async () => {
    const run = driven();
    await ran(run.phase);
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the lock phase was already used by this run',
    });
    expect(run.asked).toHaveLength(1); // the second run never asked for a lock of its own
    expect(await run.phase.cleanup?.(DEADLINE)).toBeUndefined();
    expect(run.gave).toEqual([{ handle: HANDLE, deadline: DEADLINE }]); // the first acquisition's
  });

  it('copies its locations, so a caller cannot move them after the fact', async () => {
    const locations = { controlDir: DIR, owner: { ...OWNER } };
    const seen: LockOwner[] = [];
    const phase = lockPhase(locations, {
      acquire: (async (_dir: string, owner: LockOwner) => (seen.push(owner), ACQUIRED)) as never,
    });
    Object.assign(locations.owner, { runId: 'moved', pid: 1 });
    locations.controlDir = '/elsewhere';
    await ran(phase);
    expect(seen).toEqual([OWNER]);
  });

  it('carries its evidence and its cleanup diagnostics into the run summary', async () => {
    const written: Record<string, string> = {};
    const run = driven({
      release: { kind: 'not_ours', diagnostics: [{ step: 'close_lock', errno: 'EBADF' }] },
    });
    const result = await runResearch(
      {
        runId: 'run-1',
        runsRoot: '/runs',
        researchConfig: '/research',
        operatorClaudeDir: '/operator',
        scratch: '/scratch',
        controlDir: DIR,
        budgetMs: 60_000,
        cleanupReserveMs: 10_000,
      },
      [run.phase],
      {
        mkdirExclusive: async () => undefined,
        writeSummary: async (path, text) => void (written[path] = text),
      },
    );
    expect(result.phases.map((p) => [p.name, p.status])).toEqual([['lock', 'completed']]);
    expect(result.phases[0]).toMatchObject({
      evidence: { controlDir: DIR, runId: 'run-1', diagnostics: [] },
    });
    // the phase's own words, named by the phase, exactly as the runner collects them
    expect(result.cleanupDiagnostics).toEqual([
      "lock: the lock in place was not this run's (not_ours); it was left as found; diagnostics: close_lock EBADF",
    ]);
    expect(result.summary).toEqual({ written: true, path: '/runs/run-1/run.json' });
    expect(JSON.parse(written['/runs/run-1/run.json'] ?? '')).toMatchObject({
      cleanupDiagnostics: result.cleanupDiagnostics,
    });
  });
});
