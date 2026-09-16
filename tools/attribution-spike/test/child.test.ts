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
  const run = (deadline: number) =>
    runChild('herdr', ['agent', 'read'], {
      deadline,
      termGraceMs: TERM,
      killGraceMs: KILL,
      spawn: spawnStub,
      now: () => Date.now(),
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
