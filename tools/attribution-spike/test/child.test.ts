import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChildOutcome, runChild } from '../src/child.js';

const T0 = 1_000_000;
const TERM = 1_000;
const KILL = 500;

/** A child whose every event the test emits, and which records the signals it is sent. */
/** A pipe end that records being destroyed, as the helper's release must do. */
class StubStream extends EventEmitter {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class StubChild extends EventEmitter {
  readonly stdout = new StubStream();
  readonly stderr = new StubStream();
  readonly kills: string[] = [];
  unrefs = 0;
  unref(): void {
    this.unrefs += 1;
  }
  /** What a signal does: nothing by default, which is what a hung process looks like. */
  onSignal: (signal: string) => void = () => undefined;
  kill(signal: string): boolean {
    this.kills.push(signal);
    this.onSignal(signal);
    return true;
  }
  /** A child that ran and closed, in the order node reports it: exit, then close. */
  finish(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const harness = (behaviour: { throws?: Error } = {}) => {
  let child: StubChild | undefined;
  let spawns = 0;
  const spawnStub = (() => {
    spawns += 1;
    if (behaviour.throws !== undefined) throw behaviour.throws;
    child = new StubChild();
    return child;
  }) as unknown as typeof spawn;
  const run = (deadline: number, maxOutputBytes?: number) =>
    runChild('herdr', ['agent', 'read'], {
      deadline,
      termGraceMs: TERM,
      killGraceMs: KILL,
      spawn: spawnStub,
      now: () => Date.now(),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });
  return { run, child: () => child as StubChild, spawns: () => spawns };
};

/** Collects the outcome without awaiting, so a test can see it still pending. */
const track = (work: Promise<ChildOutcome>) => {
  const state: { outcome?: ChildOutcome } = {};
  void work.then((outcome) => (state.outcome = outcome));
  return state;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('observing a child to its end', () => {
  it('sees a close emitted immediately after spawn returns, before anything was awaited', async () => {
    // emitted after runChild returned control; an event fired inside the stub is one nobody could see
    const h = harness();
    const work = h.run(T0 + 10_000);
    h.child().finish(0);
    const outcome = await work;
    expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0, signal: null });
  });

  it('records when the child closed, not when the result was looked at', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    vi.setSystemTime(T0 + 50);
    h.child().finish(0);
    vi.setSystemTime(T0 + 900); // the loop was busy elsewhere before anyone awaited the result
    expect(await work).toMatchObject({ kind: 'closed', closedAt: T0 + 50 });
  });

  it('keeps stdout, stderr and a non-zero exit exactly as they arrived', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    h.child().stdout.emit('data', Buffer.from('first '));
    h.child().stderr.emit('data', Buffer.from('warning\n'));
    h.child().stdout.emit('data', Buffer.from('second\n'));
    h.child().finish(3);
    expect(await work).toEqual({
      kind: 'closed',
      closedAt: T0,
      exitedAt: T0,
      exitCode: 3,
      signal: null,
      evidence: { stdout: 'first second\n', stderr: 'warning\n', signalled: [] },
    });
  });

  it('keeps a terminating signal rather than inventing an exit code', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    h.child().finish(null, 'SIGSEGV');
    expect(await work).toMatchObject({ kind: 'closed', exitCode: null, signal: 'SIGSEGV' });
  });
});

describe('ending a child that will not end on its own', () => {
  // one deadline, carved up in advance: waiting ends at D - 1500, SIGTERM's grace at D - 500, and
  // SIGKILL's final wait at D itself
  const D = T0 + 10_000;

  it('asks it to stop at the last moment that leaves room to escalate, and waits for it to go', async () => {
    const h = harness();
    const state = track(h.run(D));
    await vi.advanceTimersByTimeAsync(10_000 - TERM - KILL - 1);
    expect(h.child().kills).toEqual([]); // not a millisecond early

    // it takes the signal, but does not close for another 100ms
    h.child().onSignal = () => setTimeout(() => h.child().finish(null, 'SIGTERM'), 100);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.child().kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(99);
    expect(state.outcome).toBeUndefined(); // a signal sent is not a process gone

    await vi.advanceTimersByTimeAsync(1);
    expect(state.outcome).toMatchObject({
      kind: 'closed',
      closedAt: D - KILL - TERM + 100,
      signal: 'SIGTERM',
      evidence: { signalled: [{ signal: 'SIGTERM', at: D - TERM - KILL, delivered: true }] },
    });
  });

  it('escalates to SIGKILL once the SIGTERM grace is spent, and waits for that exit too', async () => {
    const h = harness();
    const state = track(h.run(D));
    h.child().onSignal = (signal) => {
      if (signal === 'SIGKILL') setTimeout(() => h.child().finish(null, 'SIGKILL'), 50);
    };
    await vi.advanceTimersByTimeAsync(10_000 - KILL - 1);
    expect(h.child().kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(state.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(50);
    expect(state.outcome).toMatchObject({
      kind: 'closed',
      signal: 'SIGKILL',
      closedAt: D - KILL + 50,
      evidence: {
        signalled: [
          { signal: 'SIGTERM', at: D - TERM - KILL },
          { signal: 'SIGKILL', at: D - KILL },
        ],
      },
    });
  });

  it('reports a child that survives everything as unterminated, exactly at the deadline', async () => {
    const h = harness();
    const state = track(h.run(D));
    h.child().stdout.emit('data', 'partial output');
    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(state.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.outcome).toEqual({
      kind: 'unterminated',
      at: D,
      evidence: {
        stdout: 'partial output',
        stderr: '',
        signalled: [
          { signal: 'SIGTERM', at: D - TERM - KILL, delivered: true },
          { signal: 'SIGKILL', at: D - KILL, delivered: true },
        ],
      },
    });
  });

  it('never runs past the deadline when the budget is shorter than the escalation reserve', async () => {
    // no fresh allowance per phase: the phases compress into what is left, and the deadline holds
    const h = harness();
    const shortDeadline = T0 + 300;
    const state = track(h.run(shortDeadline));
    await vi.advanceTimersByTimeAsync(299);
    expect(state.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.outcome).toMatchObject({ kind: 'unterminated', at: shortDeadline });
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('records a signal kill() could not deliver, and still does not call the child gone', async () => {
    const h = harness();
    const state = track(h.run(D));
    h.child().kill = (signal: string) => {
      h.child().kills.push(signal);
      throw new Error('ESRCH');
    };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.outcome).toMatchObject({
      kind: 'unterminated',
      evidence: {
        signalled: [
          { signal: 'SIGTERM', delivered: false },
          { signal: 'SIGKILL', delivered: false },
        ],
      },
    });
  });
});

describe('a child that never started', () => {
  it('spawns nothing once the deadline has passed', async () => {
    const h = harness();
    expect(await h.run(T0 - 1)).toMatchObject({ kind: 'not_started' });
    expect(h.spawns()).toBe(0);
  });

  it('turns a synchronous spawn throw into an outcome, so no caller cleanup is bypassed', async () => {
    const h = harness({ throws: new Error('spawn EINVAL') });
    const reached: string[] = [];
    try {
      expect(await h.run(T0 + 10_000)).toMatchObject({
        kind: 'spawn_failed',
        detail: 'spawn EINVAL',
      });
    } finally {
      reached.push('cleanup');
    }
    expect(reached).toEqual(['cleanup']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns an asynchronous ENOENT into an outcome, sends no signal, and leaves no timer', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    const reached: string[] = [];
    try {
      h.child().emit('error', Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' }));
      expect(await work).toMatchObject({ kind: 'spawn_failed', detail: 'spawn herdr ENOENT' });
    } finally {
      reached.push('cleanup');
    }
    expect(reached).toEqual(['cleanup']);
    expect(h.child().kills).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mistake an error after the child started for a failure to start', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    h.child().emit('spawn');
    h.child().emit('error', new Error('a later pipe error'));
    h.child().finish(1);
    expect(await work).toMatchObject({ kind: 'closed', exitCode: 1 });
  });
});

describe('output that arrives in pieces', () => {
  it('keeps a multi-byte character whole when it is split across chunks, on both streams', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    const emoji = Buffer.from('😀'); // four bytes
    const accent = Buffer.from('é'); // two bytes
    h.child().stdout.emit('data', Buffer.concat([Buffer.from('A'), emoji.subarray(0, 2)]));
    h.child().stderr.emit('data', accent.subarray(0, 1)); // the streams interleave independently
    h.child().stdout.emit('data', Buffer.concat([emoji.subarray(2), Buffer.from('B')]));
    h.child().stderr.emit('data', accent.subarray(1));
    h.child().finish(0);
    expect(await work).toMatchObject({ evidence: { stdout: 'A😀B', stderr: 'é' } });
  });

  it('reports a character left unfinished when the stream closed, rather than dropping its bytes', async () => {
    const h = harness();
    const work = h.run(T0 + 10_000);
    h.child().stdout.emit(
      'data',
      Buffer.concat([Buffer.from('A'), Buffer.from('😀').subarray(0, 2)]),
    );
    h.child().finish(0);
    expect(await work).toMatchObject({ evidence: { stdout: 'A\uFFFD' } });
  });
});

describe('a child that exits while something else holds its output open', () => {
  const D = T0 + 10_000;

  it('confirms the exit, sends no signal, and reports the capture incomplete', async () => {
    // a descendant inherited stdout: the tracked process is gone, and a missing close says nothing
    // about it being alive — signalling that pid now could hit a process that reused it
    const h = harness();
    const state = track(h.run(D));
    h.child().stdout.emit('data', Buffer.from('before exit\n'));
    await vi.advanceTimersByTimeAsync(100);
    h.child().emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(10_000 - 100 - 1);
    expect(state.outcome).toBeUndefined(); // still waiting for the output to be complete
    await vi.advanceTimersByTimeAsync(1);
    expect(state.outcome).toEqual({
      kind: 'exited',
      exitedAt: T0 + 100,
      exitCode: 0,
      signal: null,
      outputComplete: false,
      evidence: { stdout: 'before exit\n', stderr: '', signalled: [] },
    });
    expect(h.child().kills).toEqual([]);
  });

  it('releases a child that never ended, so the caller is not held open by it', async () => {
    const h = harness();
    const state = track(h.run(D));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.outcome).toMatchObject({ kind: 'unterminated' });
    expect(h.child().stdout.destroyed && h.child().stderr.destroyed).toBe(true);
    expect(h.child().unrefs).toBe(1);
  });

  it('releases its pipe ends when it gives up on capture, keeping what it had', async () => {
    const h = harness();
    const state = track(h.run(D));
    h.child().stdout.emit('data', Buffer.from('partial'));
    h.child().emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(10_000);
    const child = h.child();
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount('data') + child.stderr.listenerCount('data')).toBe(0);
    expect(child.unrefs).toBe(1);
    expect(child.listenerCount('close')).toBe(0);

    // a close arriving afterwards — which destroying the streams can itself provoke — changes nothing
    const returned = structuredClone(state.outcome);
    child.stdout.emit('data', Buffer.from(' and more'));
    child.emit('close', 0, null);
    expect(state.outcome).toEqual(returned);
    expect(state.outcome).toMatchObject({
      kind: 'exited',
      outputComplete: false,
      evidence: { stdout: 'partial' },
    });
  });

  it('keeps its capture while the output is still expected, and releases nothing', async () => {
    const h = harness();
    const work = h.run(D);
    h.child().finish(0);
    await work;
    expect(h.child().stdout.destroyed).toBe(false); // a normal close owns nothing further to release
    expect(h.child().unrefs).toBe(0);
  });

  it('reports complete output once the streams do close, with both instants', async () => {
    const h = harness();
    const state = track(h.run(D));
    await vi.advanceTimersByTimeAsync(100);
    h.child().emit('exit', 0, null);
    h.child().stdout.emit('data', Buffer.from('written after exit\n'));
    await vi.advanceTimersByTimeAsync(400);
    h.child().emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toMatchObject({
      kind: 'closed',
      exitedAt: T0 + 100,
      closedAt: T0 + 500,
      evidence: { stdout: 'written after exit\n' },
    });
  });

  it('stops escalating once the process exits after SIGTERM, even with its output still held', async () => {
    const h = harness();
    const state = track(h.run(D));
    h.child().onSignal = () => h.child().emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.child().kills).toEqual(['SIGTERM']); // no SIGKILL for a pid that is already gone
    expect(state.outcome).toMatchObject({
      kind: 'exited',
      signal: 'SIGTERM',
      exitedAt: D - TERM - KILL,
    });
  });
});

describe('a budget with no room left for its phases', () => {
  it('sends nothing to a child that ended immediately, even with every phase already spent', async () => {
    // the wait answered "not yet" before the child's end was delivered; the state is rechecked after
    // the await resumes, so the stale answer cannot license a signal
    const h = harness();
    const work = h.run(T0 + 1);
    h.child().finish(0);
    expect(await work).toMatchObject({ kind: 'closed', exitCode: 0 });
    expect(h.child().kills).toEqual([]);
  });

  it('sends no SIGKILL to a child that ended in response to SIGTERM before the next phase ran', async () => {
    // it ends in a microtask after SIGTERM: after the kill wait has already answered "not yet", but
    // before the await resumes. Only a recheck at that point sees it.
    const h = harness();
    const work = h.run(T0 + 1);
    h.child().onSignal = () => queueMicrotask(() => h.child().finish(null, 'SIGTERM'));
    expect(await work).toMatchObject({ kind: 'closed', signal: 'SIGTERM' });
    expect(h.child().kills).toEqual(['SIGTERM']);
  });

  it('sends both signals without waiting and settles at the deadline, not after it', async () => {
    // each spent phase answers at once: a zero-delay timer is clamped to 1ms, and chaining them would
    // send SIGTERM at the deadline, SIGKILL after it, and settle later still
    const h = harness();
    const state = track(h.run(T0 + 1));
    expect(h.child().kills).toEqual([]); // nothing is sent before control returns
    await vi.advanceTimersByTimeAsync(0);
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(1); // only the final wait is scheduled
    await vi.advanceTimersByTimeAsync(1);
    expect(state.outcome).toMatchObject({
      kind: 'unterminated',
      at: T0 + 1,
      evidence: {
        signalled: [
          { signal: 'SIGTERM', at: T0 },
          { signal: 'SIGKILL', at: T0 },
        ],
      },
    });
  });
});

describe('bounding captured output', () => {
  const D = T0 + 10_000;
  const out = (h: ReturnType<typeof harness>, stream: 'stdout' | 'stderr', text: string | Buffer) =>
    h.child()[stream].emit('data', Buffer.from(text));

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'refuses a limit of %s without spawning',
    async (limit) => {
      const h = harness();
      expect(await h.run(D, limit)).toEqual({
        kind: 'not_started',
        detail: 'maxOutputBytes must be a non-negative safe integer',
      });
      expect(h.spawns()).toBe(0);
    },
  );

  it('allows output of exactly the limit, as complete', async () => {
    const h = harness();
    const work = h.run(D, 5);
    out(h, 'stdout', 'abcde');
    h.child().finish(0);
    const result = await work;
    expect(result).toMatchObject({ kind: 'closed', evidence: { stdout: 'abcde' } });
    expect(result).not.toHaveProperty('evidence.outputExceeded');
  });

  it('with a zero budget, empty output still completes', async () => {
    const h = harness();
    const work = h.run(D, 0);
    h.child().finish(0);
    expect(await work).toMatchObject({ kind: 'closed', exitCode: 0 });
  });

  it('with a zero budget, the first byte overflows and nothing is kept', async () => {
    const h = harness();
    const state = track(h.run(D, 0));
    h.child().onSignal = () => h.child().finish(null, 'SIGTERM');
    out(h, 'stdout', 'x');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toMatchObject({
      kind: 'exited',
      outputComplete: false,
      evidence: { stdout: '', outputExceeded: true },
    });
  });

  it('keeps only the budget of an oversized chunk, and sends SIGTERM at once', async () => {
    const h = harness();
    const state = track(h.run(D, 5));
    out(h, 'stdout', 'abcdefgh');
    await vi.advanceTimersByTimeAsync(0);
    // at the overflow, not at the deadline less both graces
    expect(h.child().kills).toEqual(['SIGTERM']);
    expect(state.outcome).toBeUndefined(); // a delivered signal is not an exit
    out(h, 'stdout', 'more'); // nothing past the budget is kept, on either stream
    out(h, 'stderr', 'more');
    h.child().finish(null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toMatchObject({
      kind: 'exited',
      exitedAt: T0,
      signal: 'SIGTERM',
      outputComplete: false,
      evidence: { stdout: 'abcde', outputExceeded: true },
    });
  });

  it.each([
    ['stdout first', 'stdout', 'stderr', { stdout: 'abc', stderr: 'xy' }],
    ['stderr first', 'stderr', 'stdout', { stderr: 'abc', stdout: 'xy' }],
  ] as const)('counts both streams against one budget, %s', async (_label, first, second, kept) => {
    const h = harness();
    const work = h.run(D, 5);
    h.child().onSignal = () => h.child().finish(null, 'SIGTERM');
    out(h, first, 'abc');
    out(h, second, 'xyz');
    expect(await work).toMatchObject({ evidence: { ...kept, outputExceeded: true } });
  });

  it('never splits a multibyte character into a replacement character at the limit', async () => {
    const h = harness();
    const work = h.run(D, 3);
    h.child().onSignal = () => h.child().finish(null, 'SIGTERM');
    out(h, 'stdout', Buffer.concat([Buffer.from('a'), Buffer.from('😀')])); // 1 + 4 bytes
    const result = await work;
    expect(result).toMatchObject({ evidence: { stdout: 'a', outputExceeded: true } });
    expect((result as { evidence: { stdout: string } }).evidence.stdout).not.toContain('\uFFFD');
  });

  it('sends no signal when the child exits in the same moment it overflows, and stays incomplete', async () => {
    const h = harness();
    const work = h.run(D, 5);
    out(h, 'stdout', 'abcdefgh');
    h.child().finish(0); // exit and a normal close, before anything could be signalled
    const result = await work;
    expect(h.child().kills).toEqual([]);
    expect(result).toMatchObject({
      kind: 'exited',
      exitCode: 0,
      outputComplete: false,
      evidence: { stdout: 'abcde', outputExceeded: true },
    });
  });

  it('stops waiting for close when a descendant overflows the pipe after the child has exited', async () => {
    const h = harness();
    const state = track(h.run(D, 5));
    h.child().emit('exit', 0, null); // the tracked process is gone; something still holds its stdout
    await vi.advanceTimersByTimeAsync(100); // the wait for close is now under way
    expect(state.outcome).toBeUndefined();
    out(h, 'stdout', 'abcdefgh'); // the descendant overflows, and nothing ever closes
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toMatchObject({
      kind: 'exited',
      exitedAt: T0,
      exitCode: 0,
      outputComplete: false,
      evidence: { stdout: 'abcde', outputExceeded: true },
    });
    expect(h.child().kills).toEqual([]); // an exited pid is never signalled
    expect(h.child().stdout.destroyed && h.child().stderr.destroyed).toBe(true); // capture released
  });

  it('escalates to SIGKILL one term grace after an early overflow, and never reports an exit it did not see', async () => {
    const h = harness();
    const state = track(h.run(D, 5));
    await vi.advanceTimersByTimeAsync(2_000);
    out(h, 'stdout', 'abcdefgh'); // overflow at T0+2000, long before the timed SIGTERM at D-1500
    await vi.advanceTimersByTimeAsync(0);
    expect(h.child().kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(TERM - 1);
    expect(h.child().kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL']); // at T0+3000, not at D-500
    await vi.advanceTimersByTimeAsync(D - (T0 + 3_000));
    // it never exited: the overflow alone is not an end
    expect(state.outcome).toMatchObject({
      kind: 'unterminated',
      at: D,
      evidence: { outputExceeded: true },
    });
  });

  it('never sends SIGKILL later than the reserved kill window, however late the overflow', async () => {
    const h = harness();
    const state = track(h.run(D, 5));
    await vi.advanceTimersByTimeAsync(10_000 - KILL - 200); // inside SIGTERM's grace already
    out(h, 'stdout', 'abcdefgh');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.child().kills).toEqual(['SIGTERM', 'SIGKILL']); // at D-500, the window's edge
    await vi.advanceTimersByTimeAsync(KILL);
    expect(state.outcome).toMatchObject({ kind: 'unterminated', at: D });
  });
});
