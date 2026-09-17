import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_HELPER,
  ENVELOPE_BYTES,
  MAX_CAP,
  maxOutputBytesFor,
  readControlFile,
} from '../src/control-file.js';

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const b64 = (text: string) => Buffer.from(text).toString('base64');
const READ = line({ kind: 'read', base64: b64('abc'), diagnostics: [] });

interface Script {
  stdout?: string;
  stderr?: string;
  exit?: number | null;
  signal?: string | null;
  /** Throw from spawn itself. */
  throws?: Error;
  /** Emit this error before `spawn`, after any scripted output. */
  errorBeforeSpawn?: Error;
  /** 'close' (default): exit, then close. 'exit-only': exit with the streams held open. 'never': no end of its own. */
  end?: 'close' | 'exit-only' | 'never';
  /** What the helper does when a signal arrives; a signal not listed here is ignored. */
  onSignal?: Partial<Record<'SIGTERM' | 'SIGKILL', Ending & { readonly stdout?: string }>>;
}
interface Ending {
  readonly exit: number | null;
  readonly signal: string | null;
  readonly close: boolean;
}

/** A helper that answers as scripted, records its argv and the signals it receives, and runs `during` once spawned. */
const fakeHelper = (script: Script, during?: () => void) => {
  const argv: string[][] = [];
  const signals: string[] = [];
  const children: (EventEmitter & { stdout: EventEmitter })[] = [];
  const end = (child: EventEmitter, { exit, signal, close }: Ending) => {
    child.emit('exit', exit, signal);
    if (close) child.emit('close', exit, signal);
  };
  const stub = ((_cmd: string, args: string[]) => {
    argv.push(args);
    if (script.throws !== undefined) throw script.throws;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      unref: () => undefined,
      kill: (signal: 'SIGTERM' | 'SIGKILL') => {
        signals.push(signal);
        const response = script.onSignal?.[signal];
        if (response !== undefined)
          queueMicrotask(() => {
            if (response.stdout !== undefined)
              child.stdout.emit('data', Buffer.from(response.stdout));
            end(child, response);
          });
        return true;
      },
    });
    children.push(child);
    during?.();
    queueMicrotask(() => {
      if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout));
      if (script.errorBeforeSpawn !== undefined)
        return void child.emit('error', script.errorBeforeSpawn);
      child.emit('spawn');
      if (script.end === 'never') return;
      // an explicit null is kept: only an absent exit code defaults to 0
      const exit = script.exit === undefined ? 0 : script.exit;
      end(child, { exit, signal: script.signal ?? null, close: script.end !== 'exit-only' });
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawn: stub, argv, signals, children };
};
const read = (script: Script, over: object = {}, name = 'bootstrap.json') => {
  const h = fakeHelper(script);
  const options = { deadline: Date.now() + 10_000, cap: 64, spawn: h.spawn, ...over };
  return { h, result: readControlFile('/control', name, options) };
};

describe('reading a control file through the helper', () => {
  it.each([
    [
      'a relative directory',
      'control',
      'f',
      {},
      'the control directory must be an absolute path without NUL',
    ],
    [
      'a directory with NUL',
      '/con\0trol',
      'f',
      {},
      'the control directory must be an absolute path without NUL',
    ],
    ['an empty name', '/control', '', {}, 'the name must be a single path component'],
    ['the name .', '/control', '.', {}, 'the name must be a single path component'],
    ['the name ..', '/control', '..', {}, 'the name must be a single path component'],
    ['a name with /', '/control', 'a/b', {}, 'the name must be a single path component'],
    ['a name with \\', '/control', 'a\\b', {}, 'the name must be a single path component'],
    ['a zero cap', '/control', 'f', { cap: 0 }, 'the cap must be a safe integer from 1 to MAX_CAP'],
    [
      'a fractional cap',
      '/control',
      'f',
      { cap: 1.5 },
      'the cap must be a safe integer from 1 to MAX_CAP',
    ],
    [
      'a cap over MAX_CAP',
      '/control',
      'f',
      { cap: MAX_CAP + 1 },
      'the cap must be a safe integer from 1 to MAX_CAP',
    ],
    [
      'an infinite deadline',
      '/control',
      'f',
      { deadline: Infinity },
      'the deadline must be finite',
    ],
  ])('refuses %s without spawning', async (_label, dir, name, over, problem) => {
    const h = fakeHelper({ stdout: READ });
    const options = { deadline: Date.now() + 10_000, cap: 64, spawn: h.spawn, ...over };
    expect(await readControlFile(dir, name, options)).toEqual({
      kind: 'unusable',
      problems: [problem],
    });
    expect(h.argv).toEqual([]);
  });

  it.each([
    ['a read', READ, { kind: 'read', bytes: Buffer.from('abc') }],
    ['a missing file', line({ kind: 'missing', diagnostics: [] }), { kind: 'missing' }],
    [
      'a refusal with a close diagnostic',
      line({
        kind: 'refused',
        reason: 'close_failed',
        errno: null,
        diagnostics: [{ step: 'close_file', errno: 'EBADF' }],
      }),
      {
        kind: 'refused',
        reason: 'close_failed',
        errno: null,
        diagnostics: [{ step: 'close_file', errno: 'EBADF' }],
      },
    ],
  ])(
    'returns %s from a clean termination, invoking the helper exactly',
    async (_label, stdout, expected) => {
      const { h, result } = read({ stdout });
      expect(await result).toEqual(expected);
      expect(h.argv).toEqual([
        [CONTROL_HELPER, '--dir', '/control', '--name', 'bootstrap.json', '--cap', '64'],
      ]);
    },
  );

  it.each([
    ['lowered', 1, READ, { kind: 'read', bytes: Buffer.from('abc') }],
    // raised: five bytes at the dispatched cap of 4 must still be refused
    [
      'raised',
      MAX_CAP,
      line({ kind: 'read', base64: b64('abcde'), diagnostics: [] }),
      { kind: 'unusable', problems: ['the bytes exceed the cap'] },
    ],
  ])(
    'keeps the cap it dispatched when the caller’s cap is %s during the query',
    async (_label, changed, stdout, expected) => {
      const options = {
        deadline: Date.now() + 10_000,
        cap: stdout === READ ? 64 : 4,
        spawn: undefined as unknown as typeof spawn,
      };
      const h = fakeHelper({ stdout }, () => (options.cap = changed));
      options.spawn = h.spawn;
      expect(await readControlFile('/control', 'f', options)).toEqual(expected);
      expect(options.cap).toBe(changed); // the change really landed while the helper ran
      expect(h.argv[0]?.at(-1)).toBe(stdout === READ ? '64' : '4');
    },
  );

  it('bounds output to the largest line the helper can write, and no more', async () => {
    const errno = 'ENOTRECOVERABLE'; // among the longest errno names
    const worst = `{"kind": "refused", "reason": "directory_unusable", "errno": "${errno}", "diagnostics": [{"step": "close_directory", "errno": "${errno}"}, {"step": "close_directory", "errno": "${errno}"}]}\n`;
    expect(worst.length).toBeLessThan(ENVELOPE_BYTES);
    const full = `{"kind": "read", "base64": "${Buffer.alloc(MAX_CAP, 'x').toString('base64')}", "diagnostics": []}\n`;
    expect(full.length).toBeLessThanOrEqual(maxOutputBytesFor(MAX_CAP));
    expect(await read({ stdout: full }, { cap: MAX_CAP }).result).toMatchObject({ kind: 'read' });

    // from the specification, not the function under test: base64 of 64 bytes is 88, plus the envelope
    const over = 'x'.repeat(88 + ENVELOPE_BYTES + 1);
    expect(await read({ stdout: over }).result).toEqual({
      kind: 'unusable',
      problems: [
        'the helper ended exited',
        'the helper exceeded maxOutputBytes',
        'the output is not exactly one line',
      ],
    });
  });

  it.each([
    ['exit 1 after a valid read', { stdout: READ, exit: 1 }, ['the helper exited 1']],
    [
      'a signal after a valid read',
      { stdout: READ, exit: null, signal: 'SIGSEGV' },
      ['the helper was killed by SIGSEGV', 'the helper exited null'], // no exit code when killed
    ],
    [
      'stderr beside a valid read',
      { stdout: READ, stderr: 'warning\n' },
      ['the helper wrote to stderr'],
    ],
    [
      'exit 1 with output that is not JSON',
      { stdout: 'garbage\n', exit: 1 },
      ['the helper exited 1', 'the output is not JSON'],
    ],
    [
      'a synchronous spawn failure',
      { throws: new Error('spawn python3 ENOENT') },
      ['the helper did not run: spawn python3 ENOENT', 'the output is not exactly one line'],
    ],
    // output captured before the failure is discarded: the valid read never reaches the parser
    [
      'an asynchronous spawn failure after output',
      { stdout: READ, errorBeforeSpawn: new Error('EACCES') },
      ['the helper did not run: EACCES', 'the output is not exactly one line'],
    ],
  ] as [string, Script, string[]][])(
    'returns no bytes after %s, termination problems first',
    async (_label, script, problems) => {
      const r = await read(script).result;
      expect(r).toEqual({ kind: 'unusable', problems });
      expect(Object.isFrozen(r) && r.kind === 'unusable' && Object.isFrozen(r.problems)).toBe(true);
    },
  );

  it('refuses without spawning once the deadline has passed', async () => {
    const { h, result } = read({ stdout: READ }, { deadline: Date.now() - 1 });
    expect(await result).toEqual({
      kind: 'unusable',
      problems: [
        'the helper did not run: the deadline had already passed; nothing was spawned',
        'the output is not exactly one line',
      ],
    });
    expect(h.argv).toEqual([]);
  });

  it('orders every termination problem: ended, signalled, overflowed, stderr', async () => {
    const script = {
      stderr: 'warn\n',
      stdout: 'x'.repeat(maxOutputBytesFor(64) + 1),
      end: 'never' as const,
      onSignal: { SIGTERM: { exit: 0, signal: null, close: true } },
    };
    expect(await read(script).result).toEqual({
      kind: 'unusable',
      problems: [
        'the helper ended exited',
        'the helper was signalled to stop',
        'the helper exceeded maxOutputBytes',
        'the helper wrote to stderr',
        'the output is not exactly one line',
      ],
    });
  });
});

describe('reading a control file on controlled time', () => {
  afterEach(() => vi.useRealTimers());
  const T0 = 1_000_000;
  const D = T0 + 10_000;
  // runChild's schedule: SIGTERM once only both grace periods remain, SIGKILL once only the kill grace does
  const SIGTERM_AT = D - 400;
  const SIGKILL_AT = D - 200;
  const killed = { exit: null, signal: 'SIGKILL' };

  it.each([
    {
      // exit proves the helper ended, but its output is incomplete without close; exit already seen, so no signal
      label: 'exits 0 after a valid read but never closes its streams',
      script: { stdout: READ, end: 'exit-only' },
      settlesAt: D,
      signals: [],
      problems: ['the helper ended exited'],
    },
    {
      // closed with exit 0, yet it only finished because it was told to stop
      label: 'answers SIGTERM with a valid read, exit 0 and close',
      script: {
        end: 'never',
        onSignal: { SIGTERM: { stdout: READ, exit: 0, signal: null, close: true } },
      },
      settlesAt: SIGTERM_AT,
      signals: ['SIGTERM'],
      problems: ['the helper was signalled to stop'],
    },
    {
      // no exit event ever arrives: sending SIGKILL and reaching the deadline are not an exit
      label: 'ignores SIGTERM and SIGKILL',
      script: { end: 'never' },
      settlesAt: D,
      signals: ['SIGTERM', 'SIGKILL'],
      problems: [
        'the helper ended unterminated',
        'the helper was signalled to stop',
        'the output is not exactly one line',
      ],
    },
    {
      // the exit event proves exit; with close as well, the outcome is closed and carries the signal
      label: 'exits and closes on SIGKILL',
      script: { end: 'never', onSignal: { SIGKILL: { ...killed, close: true } } },
      settlesAt: SIGKILL_AT,
      signals: ['SIGTERM', 'SIGKILL'],
      problems: [
        'the helper was killed by SIGKILL',
        'the helper exited null',
        'the helper was signalled to stop',
        'the output is not exactly one line',
      ],
    },
    {
      // the exit event proves exit, but without close the outcome is exited, reported only at the deadline
      label: 'exits on SIGKILL but never closes its streams',
      script: { end: 'never', onSignal: { SIGKILL: { ...killed, close: false } } },
      settlesAt: D,
      signals: ['SIGTERM', 'SIGKILL'],
      problems: [
        'the helper ended exited',
        'the helper was signalled to stop',
        'the output is not exactly one line',
      ],
    },
  ] as {
    label: string;
    script: Script;
    settlesAt: number;
    signals: string[];
    problems: string[];
  }[])(
    'returns no bytes when the helper $label, and late output changes nothing',
    async ({ script, settlesAt, signals, problems }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(T0);
      const h = fakeHelper(script);
      let result: Awaited<ReturnType<typeof readControlFile>> | undefined;
      void readControlFile('/control', 'f', {
        deadline: D,
        cap: 64,
        spawn: h.spawn,
        now: Date.now,
      }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(settlesAt - T0 - 1);
      expect(result).toBeUndefined(); // not a millisecond early
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({ kind: 'unusable', problems });
      expect(h.signals).toEqual(signals);

      const settled = structuredClone(result);
      const child = h.children[0];
      child?.stdout.emit('data', Buffer.from(READ));
      child?.emit('exit', 0, null);
      child?.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result).toEqual(settled);
      expect(
        Object.isFrozen(result) && result?.kind === 'unusable' && Object.isFrozen(result.problems),
      ).toBe(true);
    },
  );
});
