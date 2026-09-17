import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

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
  /** Never exit on its own; exit 0 once asked to stop. */
  exitOnSigterm?: boolean;
}

/** A helper that answers as scripted, records its argv, and runs `during` once spawned. */
const fakeHelper = (script: Script, during?: () => void) => {
  const argv: string[][] = [];
  const stub = ((_cmd: string, args: string[]) => {
    argv.push(args);
    if (script.throws !== undefined) throw script.throws;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      unref: () => undefined,
      kill: () => {
        if (script.exitOnSigterm === true)
          queueMicrotask(() => (child.emit('exit', 0, null), child.emit('close', 0, null)));
        return true;
      },
    });
    during?.();
    queueMicrotask(() => {
      if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout));
      if (script.errorBeforeSpawn !== undefined)
        return void child.emit('error', script.errorBeforeSpawn);
      child.emit('spawn');
      if (script.exitOnSigterm === true) return;
      child.emit('exit', script.exit ?? 0, script.signal ?? null);
      child.emit('close', script.exit ?? 0, script.signal ?? null);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawn: stub, argv };
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
      ['the helper was killed by SIGSEGV'],
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
      exitOnSigterm: true,
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
