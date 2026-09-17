import { describe, expect, it } from 'vitest';

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  acquireLockBounded,
  type AcquireOptions,
  LOCK_HELPER,
  LOCK_OUTPUT_BYTES,
  type LockOwner,
  prepareAcquire,
  type RandomSource,
} from '../src/lock.js';

const DIR = '/cache/research/control';
const OWNER: LockOwner = { runId: 'run-1', pid: 4_242, startedAt: '2026-09-17T08:30:00Z' };
/** Known values, so the assertions can look for these exact secrets and not any 32-hex text. */
const TOKEN = 'a'.repeat(32);
const NONCE = 'b'.repeat(32);
const fixed = (...values: string[]): { random: RandomSource; asked: number[] } => {
  const asked: number[] = [];
  let next = 0;
  return {
    asked,
    random: (bytes) => {
      asked.push(bytes);
      return Buffer.from(values[next++] ?? '', 'hex');
    },
  };
};
const prepared = (random: RandomSource, dir = DIR, owner = OWNER) => {
  const result = prepareAcquire(dir, owner, random);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.request;
};

describe('preparing a request to take the lock', () => {
  it('builds an argv that names only the helper, the directory and the mode', () => {
    const request = prepared(fixed(TOKEN, NONCE).random);
    expect(request.argv).toEqual([LOCK_HELPER, '--dir', DIR, '--mode', 'acquire']);
    expect(Object.isFrozen(request) && Object.isFrozen(request.argv)).toBe(true);
  });

  it('keeps the secrets out of everything a caller can reach', () => {
    const request = prepared(fixed(TOKEN, NONCE).random);
    const reachable = JSON.stringify(request) + JSON.stringify(Object.entries(request));
    for (const secret of [TOKEN, NONCE]) expect(reachable).not.toContain(secret);
    expect(Object.keys(request)).toEqual(['argv']); // the record is reachable only from the module
  });

  it('asks its source for sixteen bytes, twice', () => {
    const source = fixed(TOKEN, NONCE);
    prepared(source.random);
    expect(source.asked).toEqual([16, 16]);
  });

  it('copies each value before asking for the next', () => {
    // one buffer, overwritten on the second call: without a copy both secrets would be the same
    const shared = Buffer.alloc(16, 0xaa);
    const reused: RandomSource = () => {
      const handed = shared;
      shared.fill(shared[0] === 0xaa ? 0xbb : 0xaa);
      return handed;
    };
    expect(prepareAcquire(DIR, OWNER, reused).ok).toBe(true);
    // proven in L2a-1b, where the record reaches stdin: the two values must differ there
  });

  it.each([
    [
      'a source that throws',
      () => {
        throw new Error('no entropy');
      },
    ],
    ['a source returning too few bytes', () => Buffer.alloc(15)],
    ['a source returning something else', () => 'not bytes' as unknown as Uint8Array],
  ] as [string, RandomSource][])('refuses %s', (_label, random) => {
    expect(prepareAcquire(DIR, OWNER, random)).toEqual({ ok: false, reason: 'random_failed' });
  });

  it.each([
    ['a relative directory', 'control', OWNER],
    ['a directory with NUL', '/con\0trol', OWNER],
    ['a runId with a separator', DIR, { ...OWNER, runId: 'a/b' }],
    ['an empty runId', DIR, { ...OWNER, runId: '' }],
    ['a numeric runId', DIR, { ...OWNER, runId: 123 as unknown as string }],
    ['a boolean runId', DIR, { ...OWNER, runId: true as unknown as string }],
    ['a missing runId', DIR, { ...OWNER, runId: undefined as unknown as string }],
    ['a fractional pid', DIR, { ...OWNER, pid: 1.5 }],
    ['a boolean pid', DIR, { ...OWNER, pid: true as unknown as number }],
    ['a pid of zero', DIR, { ...OWNER, pid: 0 }],
    ['an impossible timestamp', DIR, { ...OWNER, startedAt: '2026-02-30T00:00:00Z' }],
    ['a timestamp without Z', DIR, { ...OWNER, startedAt: '2026-09-17T08:30:00' }],
  ])('refuses %s without drawing a secret', (_label, dir, owner) => {
    const source = fixed(TOKEN, NONCE);
    expect(prepareAcquire(dir, owner, source.random)).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(source.asked).toEqual([]);
  });

  it('snapshots the owner before calling the source, which is the caller’s own code', () => {
    const owner = { ...OWNER };
    const mutating: RandomSource = (bytes) => (
      Object.assign(owner, { runId: 'changed', pid: -1 }),
      Buffer.alloc(bytes, 0xcc)
    );
    expect(prepareAcquire(DIR, owner, mutating).ok).toBe(true); // the snapshot was already taken
  });
});

describe('taking the lock through the helper', () => {
  interface Script {
    stdout?: string;
    stderr?: string;
    exit?: number | null;
    signal?: string | null;
    /** Accept no stdin, so delivery cannot be confirmed. */
    refuseInput?: boolean;
  }
  /** A helper that answers as scripted and records its argv and the record it was given. */
  const fakeHelper = (script: Script) => {
    const argv: string[][] = [];
    const written: string[] = [];
    const stub = ((_command: string, args: string[]) => {
      argv.push(args);
      const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
      const stdin = Object.assign(new EventEmitter(), {
        end: (chunk: Buffer) => {
          written.push(chunk.toString());
          if (script.refuseInput !== true) queueMicrotask(() => stdin.emit('finish'));
          return stdin;
        },
        destroy: () => undefined,
      });
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: stream(),
        stderr: stream(),
        unref: () => undefined,
        kill: () => true,
      });
      queueMicrotask(() => {
        child.emit('spawn');
        if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr));
        if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout));
        const exit = script.exit === undefined ? 0 : script.exit;
        child.emit('exit', exit, script.signal ?? null);
        child.emit('close', exit, script.signal ?? null);
      });
      return child;
    }) as unknown as typeof spawn;
    return { spawn: stub, argv, written };
  };
  const line = (result: unknown) => `${JSON.stringify(result)}\n`;
  const ACQUIRED = line({ kind: 'acquired', diagnostics: [] });
  const take = async (
    script: Script,
    over: Partial<AcquireOptions> = {},
    owner: LockOwner = OWNER,
  ) => {
    const helper = fakeHelper(script);
    const outcome = await acquireLockBounded(DIR, owner, {
      deadline: Date.now() + 10_000,
      spawn: helper.spawn,
      random: fixed(TOKEN, NONCE).random,
      ...over,
    });
    return { outcome, helper };
  };

  it('invokes the helper with a token-free argv and the record on stdin', async () => {
    const { outcome, helper } = await take({ stdout: ACQUIRED });
    expect(helper.argv).toEqual([[LOCK_HELPER, '--dir', DIR, '--mode', 'acquire']]);
    expect(JSON.parse(helper.written[0] ?? '')).toEqual({ ...OWNER, token: TOKEN, nonce: NONCE });
    expect(outcome.kind).toBe('acquired');
    for (const secret of [TOKEN, NONCE]) expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('sends two different secrets even when its source hands back one buffer', async () => {
    const shared = Buffer.alloc(16, 0xaa);
    const reused: RandomSource = () => (shared.fill(shared[0] === 0xaa ? 0xbb : 0xaa), shared);
    const { helper } = await take({ stdout: ACQUIRED }, { random: reused });
    const sent = JSON.parse(helper.written[0] ?? '') as { token: string; nonce: string };
    expect(sent.token).not.toBe(sent.nonce); // each copied before the next was drawn
  });

  it('uses the owner it snapshotted, even if the source changes the caller’s object', async () => {
    const owner = { ...OWNER };
    const mutating: RandomSource = (bytes) => (
      Object.assign(owner, { runId: 'changed' }),
      Buffer.alloc(bytes, 0xcc)
    );
    const { outcome, helper } = await take({ stdout: ACQUIRED }, { random: mutating }, owner);
    expect((JSON.parse(helper.written[0] ?? '') as { runId: string }).runId).toBe('run-1');
    expect(outcome.kind === 'acquired' && outcome.handle).toEqual({
      controlDir: DIR,
      runId: 'run-1',
    });
  });

  it('hands back a frozen handle of exactly where and whose', async () => {
    const { outcome } = await take({ stdout: ACQUIRED });
    if (outcome.kind !== 'acquired') throw new Error(outcome.kind);
    expect(outcome.handle).toEqual({ controlDir: DIR, runId: 'run-1' });
    expect(Object.keys(outcome.handle)).toEqual(['controlDir', 'runId']);
    expect(Object.isFrozen(outcome.handle) && Object.isFrozen(outcome)).toBe(true);
  });

  it.each([
    [
      'held',
      line({ kind: 'held', diagnostics: [{ step: 'unlink_temp', errno: 'EIO' }] }),
      {
        kind: 'held',
        diagnostics: [{ step: 'unlink_temp', errno: 'EIO' }],
      },
    ],
    [
      'a refusal with an errno',
      line({ kind: 'refused', reason: 'link_failed', errno: 'EXDEV', diagnostics: [] }),
      {
        kind: 'refused',
        reason: 'link_failed',
        errno: 'EXDEV',
        diagnostics: [],
      },
    ],
    [
      'a refusal that left a temporary file',
      line({
        kind: 'refused',
        reason: 'ownership_unknown',
        errno: 'EIO',
        diagnostics: [{ step: 'temp_may_remain', errno: null }],
      }),
      {
        kind: 'refused',
        reason: 'ownership_unknown',
        errno: 'EIO',
        diagnostics: [{ step: 'temp_may_remain', errno: null }],
      },
    ],
  ])(
    'passes through %s, keeping its diagnostics and a handle to clean up with',
    async (_label, stdout, expected) => {
      const { outcome } = await take({ stdout });
      expect(outcome).toEqual({ ...expected, handle: { controlDir: DIR, runId: 'run-1' } });
    },
  );

  it.each([
    ['exits 1', { stdout: ACQUIRED, exit: 1 }, 'exited 1'],
    ['is killed', { stdout: ACQUIRED, exit: null, signal: 'SIGSEGV' }, 'killed by SIGSEGV'],
    ['writes to stderr', { stdout: ACQUIRED, stderr: 'warning\n' }, 'wrote to stderr'],
    [
      'overflows its output',
      { stdout: 'x'.repeat(LOCK_OUTPUT_BYTES + 1) },
      'exceeded its output bound',
    ],
    [
      'never takes its input',
      { stdout: ACQUIRED, refuseInput: true },
      'input delivery unconfirmed',
    ],
  ] as [string, Script, string][])(
    'reports unknown when the helper %s, whatever it printed',
    async (_label, script, problem) => {
      const { outcome } = await take(script);
      expect(outcome.kind).toBe('unknown');
      expect(outcome.kind === 'unknown' && outcome.problems).toContain(problem);
      expect(outcome.kind === 'unknown' && outcome.handle).toEqual({
        controlDir: DIR,
        runId: 'run-1',
      });
    },
  );

  it('reports unknown for a held or refused line from an unclean run', async () => {
    for (const stdout of [
      line({ kind: 'held', diagnostics: [] }),
      line({ kind: 'refused', reason: 'capability', errno: null, diagnostics: [] }),
    ]) {
      const { outcome } = await take({ stdout, exit: 1 });
      expect(outcome.kind).toBe('unknown');
    }
  });

  it.each([
    ['two lines', ACQUIRED.repeat(2), 'the output is not exactly one line'],
    ['an unknown kind', line({ kind: 'maybe', diagnostics: [] }), 'kind is unknown'],
    ['the wrong fields', line({ kind: 'acquired' }), 'the acquired result has the wrong fields'],
    [
      'malformed diagnostics',
      line({ kind: 'held', diagnostics: [{ step: 'nope', errno: null }] }),
      'diagnostics are malformed',
    ],
  ])('reports unknown for %s', async (_label, stdout, problem) => {
    const { outcome } = await take({ stdout });
    expect(outcome).toEqual({
      kind: 'unknown',
      handle: { controlDir: DIR, runId: 'run-1' },
      problems: [problem],
    });
  });

  it('never repeats what a spawn failure said, token or not', async () => {
    const helper = fakeHelper({ stdout: ACQUIRED });
    const throwing = ((): never => {
      throw new Error(`spawn SENTINEL-PATH ${TOKEN} ENOENT`); // the system's text, with a secret in it
    }) as unknown as typeof spawn;
    const outcome = await acquireLockBounded(DIR, OWNER, {
      deadline: Date.now() + 10_000,
      spawn: throwing,
      random: fixed(TOKEN, NONCE).random,
    });
    expect(outcome).toEqual({
      kind: 'unknown',
      handle: { controlDir: DIR, runId: 'run-1' },
      problems: ['did not run', 'the output is not exactly one line'],
    });
    const serialized = JSON.stringify(outcome);
    for (const secret of [TOKEN, NONCE, 'SENTINEL-PATH']) expect(serialized).not.toContain(secret);
    expect(helper.argv).toEqual([]);
  });

  it.each([
    [
      'an array-valued reason',
      line({ kind: 'refused', reason: ['capability'], errno: null, diagnostics: [] }),
    ],
    ['a numeric reason', line({ kind: 'refused', reason: 7, errno: null, diagnostics: [] })],
  ])('reports unknown for %s, which only looks like one', async (_label, stdout) => {
    const { outcome } = await take({ stdout });
    expect(outcome).toEqual({
      kind: 'unknown',
      handle: { controlDir: DIR, runId: 'run-1' },
      problems: ['reason is unknown'],
    });
  });

  it('spawns nothing when the request is refused', async () => {
    const helper = fakeHelper({ stdout: ACQUIRED });
    const outcome = await acquireLockBounded(
      DIR,
      { ...OWNER, pid: 0 },
      {
        deadline: Date.now() + 10_000,
        spawn: helper.spawn,
        random: fixed(TOKEN, NONCE).random,
      },
    );
    expect(outcome).toEqual({ kind: 'not_attempted', reason: 'invalid_request' });
    expect(helper.argv).toEqual([]);
  });
});
