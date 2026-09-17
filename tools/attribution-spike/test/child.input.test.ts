import { type ChildProcess, spawn as nodeSpawn, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ChildOptions, MAX_INPUT_BYTES, runChild } from '../src/child.js';

const T0 = 1_000_000;
const TERM = 1_000;
const KILL = 500;
const SENTINEL = 'SENTINEL-INPUT';

/** A writable stdin whose every step the test drives. */
class StubStdin extends EventEmitter {
  readonly ends: Buffer[] = [];
  destroyed = false;
  errorListenersAtEnd = 0;
  throwOnEnd?: Error;
  end(chunk: Buffer): this {
    this.errorListenersAtEnd = this.listenerCount('error');
    if (this.throwOnEnd !== undefined) throw this.throwOnEnd;
    this.ends.push(chunk);
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}
class StubStream extends EventEmitter {
  destroy(): this {
    return this;
  }
}
class StubChild extends EventEmitter {
  readonly stdout = new StubStream();
  readonly stderr = new StubStream();
  readonly kills: string[] = [];
  stdin: StubStdin | null;
  constructor(stdin: StubStdin | null) {
    super();
    this.stdin = stdin;
  }
  unref(): void {
    return undefined;
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

const harness = (stdin: StubStdin | null = new StubStdin()) => {
  const options: unknown[] = [];
  let child: StubChild | undefined;
  const spawnStub = ((_c: string, _a: string[], o: unknown) => {
    options.push(o);
    child = new StubChild(stdin);
    return child;
  }) as unknown as typeof spawn;
  const run = (over: Partial<ChildOptions> = {}) =>
    runChild('helper', ['x'], {
      deadline: Date.now() + 10_000,
      termGraceMs: TERM,
      killGraceMs: KILL,
      spawn: spawnStub,
      now: () => Date.now(),
      ...over,
    });
  return { run, options, child: () => child, spawns: () => options.length };
};
const finish = (c: StubChild | undefined) => (c?.emit('exit', 0, null), c?.emit('close', 0, null));

describe('delivering input to a child', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['a number', 7, 'input must be a string or bytes'],
    ['an object', {}, 'input must be a string or bytes'],
    [
      'bytes over the cap',
      new Uint8Array(MAX_INPUT_BYTES + 1),
      'input must be at most MAX_INPUT_BYTES bytes',
    ],
    // fewer characters than the cap, but more bytes: the check counts bytes
    [
      'a multibyte string over the cap',
      '€'.repeat(MAX_INPUT_BYTES / 3 + 1),
      'input must be at most MAX_INPUT_BYTES bytes',
    ],
  ])('refuses %s without spawning', async (_label, input, detail) => {
    const h = harness();
    expect(await h.run({ input: input as string })).toEqual({ kind: 'not_started', detail });
    expect(h.spawns()).toBe(0);
  });

  it('accepts a multibyte string of exactly the cap, and never copies what it refuses', async () => {
    const copies = vi.spyOn(Buffer, 'from');
    const h = harness();
    const wide = Math.floor(MAX_INPUT_BYTES / 3);
    const atCap = '€'.repeat(wide) + 'a'.repeat(MAX_INPUT_BYTES - wide * 3); // exactly the cap, in bytes
    const pending = h.run({ input: atCap });
    const stdin = h.child()?.stdin;
    stdin?.emit('finish');
    finish(h.child());
    expect((await pending).kind).toBe('closed');
    expect(stdin?.ends[0]?.length).toBe(MAX_INPUT_BYTES);
    copies.mockClear();
    await h.run({ input: new Uint8Array(MAX_INPUT_BYTES + 1) });
    expect(copies).not.toHaveBeenCalled();
    copies.mockRestore();
  });

  it('copies the caller’s bytes before they can change', async () => {
    const input = Uint8Array.from([1, 2, 3]);
    const h = harness();
    const pending = h.run({ input });
    input[0] = 9; // the caller mutates after the call
    h.child()?.stdin?.emit('finish');
    finish(h.child());
    await pending;
    expect([...(h.child()?.stdin?.ends[0] ?? [])]).toEqual([1, 2, 3]);
  });

  it.each([
    ['input given', 'x', ['pipe', 'pipe', 'pipe'], 1],
    ['empty input', '', ['pipe', 'pipe', 'pipe'], 1],
    ['no input', undefined, ['ignore', 'pipe', 'pipe'], 0],
  ])('configures stdin for %s', async (_label, input, stdio, ends) => {
    const h = harness();
    const pending = h.run(input === undefined ? {} : { input });
    h.child()?.stdin?.emit('finish');
    finish(h.child());
    const outcome = await pending;
    expect(h.options[0]).toMatchObject({ stdio });
    expect(h.child()?.stdin?.ends).toHaveLength(ends); // untouched when no input was given
    expect(outcome).toMatchObject({ kind: 'closed' });
    expect(JSON.stringify(outcome)).not.toContain('inputUnconfirmed');
  });

  it('attaches its error handlers before writing, and writes exactly once', async () => {
    const h = harness();
    const pending = h.run({ input: SENTINEL });
    const stdin = h.child()?.stdin;
    expect(stdin?.errorListenersAtEnd).toBe(2); // the sink and the delivery tracker
    expect(stdin?.ends).toEqual([Buffer.from(SENTINEL)]);
    stdin?.emit('finish');
    finish(h.child());
    expect(await pending).toMatchObject({ kind: 'closed', evidence: { stdout: '' } });
  });

  it.each([
    ['end throws', true],
    ['an error arrives, then finish anyway', false],
  ])('never confirms delivery when %s', async (_label, thrown) => {
    const stdin = new StubStdin();
    if (thrown) stdin.throwOnEnd = new Error(SENTINEL);
    const h = harness(stdin);
    const pending = h.run({ input: 'x' });
    if (!thrown) {
      stdin.emit('error', new Error(SENTINEL));
      stdin.emit('finish'); // sticky: a later finish cannot undo the failure
    }
    finish(h.child());
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'closed', evidence: { inputUnconfirmed: true } });
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL');
  });

  it('fails safely when the child has no stdin stream', async () => {
    const h = harness(null);
    const pending = h.run({ input: 'x' });
    finish(h.child());
    expect(await pending).toMatchObject({ kind: 'closed', evidence: { inputUnconfirmed: true } });
  });

  it('stays bounded when the child never reads and never exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    const h = harness();
    const pending = h.run({ input: 'x', deadline: T0 + 10_000 });
    await vi.advanceTimersByTimeAsync(10_000); // finish never fires; the child never ends
    expect(await pending).toMatchObject({
      kind: 'unterminated',
      at: T0 + 10_000,
      evidence: { inputUnconfirmed: true },
    });
    expect(h.child()?.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('releases stdin at settlement, leaving only the error sink', async () => {
    const h = harness();
    const pending = h.run({ input: 'x' });
    const stdin = h.child()?.stdin;
    stdin?.emit('finish');
    finish(h.child());
    const outcome = await pending;
    expect([
      stdin?.destroyed,
      stdin?.listenerCount('error'),
      stdin?.listenerCount('finish'),
    ]).toEqual([true, 1, 0]);
    stdin?.emit('error', new Error(SENTINEL)); // handled by the sink: no throw, nothing changes
    expect(outcome).toMatchObject({ kind: 'closed' });
    expect(JSON.stringify(outcome)).not.toContain('inputUnconfirmed');
  });

  describe('with real children', () => {
    interface Tracked {
      readonly child: ChildProcess;
      exit?: { code: number | null; signal: NodeJS.Signals | null };
      close?: true;
    }
    const tracked: Tracked[] = [];
    const running: ReturnType<typeof runChild>[] = [];
    /** Node's spawn, with the child and its ending recorded before anything is awaited. */
    const trackingSpawn = ((command: string, args: string[], options: object) => {
      const child = nodeSpawn(command, args, options);
      const t: Tracked = { child };
      tracked.push(t);
      child.once('exit', (code, signal) => (t.exit = { code, signal }));
      child.once('close', () => (t.close = true));
      return child;
    }) as unknown as typeof spawn;

    afterEach(async () => {
      const [children, results] = [tracked.splice(0), running.splice(0)];
      await Promise.allSettled(results); // bounded by each run's own deadline
      const unconfirmed: string[] = [];
      for (const t of children) {
        // a settled run proves nothing about the child: `unterminated` leaves it alive
        if (t.exit !== undefined) continue;
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
      if (unconfirmed.length > 0) throw new Error(unconfirmed.join('; '));
    }, 30_000);

    const real = (script: string, input: string, ms: number) => {
      const pending = runChild('python3', ['-c', script], {
        deadline: Date.now() + ms,
        termGraceMs: 200,
        killGraceMs: 200,
        spawn: trackingSpawn,
        now: Date.now,
        input,
      });
      running.push(pending);
      return pending;
    };

    it('delivers input a real child reads, exactly', async () => {
      const outcome = await real(
        'import sys; data = sys.stdin.buffer.read(); print(len(data))',
        SENTINEL.repeat(100),
        10_000,
      );
      expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
      expect(tracked[0]?.exit).toEqual({ code: 0, signal: null });
      expect((outcome as { evidence: { stdout: string } }).evidence.stdout.trim()).toBe(
        String(SENTINEL.length * 100),
      );
      expect(JSON.stringify(outcome)).not.toContain('SENTINEL');
    });

    it('stays bounded, and confirms the exit, when a real child never reads its input', async () => {
      const outcome = await real('import time; time.sleep(30)', SENTINEL, 1_500);
      expect(outcome).toMatchObject({ kind: 'closed', signal: 'SIGTERM' });
      // the child's own exit event, recorded independently of the outcome
      expect(tracked[0]?.exit).toEqual({ code: null, signal: 'SIGTERM' });
      expect(tracked[0]?.close).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain('SENTINEL');
    });
  });
});
