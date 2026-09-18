import { afterEach, describe, expect, it, vi } from 'vitest';

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  acquireLockBounded,
  type AcquireOptions,
  type AcquireOutcome,
  LOCK_HELPER,
  LOCK_OUTPUT_BYTES,
  type LockHandle,
  type LockOwner,
  prepareAcquire,
  releaseLockBounded,
  type ReleaseOptions,
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
    /** 'close' (default): exit then close. 'exit-only': exit, streams held open. 'never': no end. */
    end?: 'close' | 'exit-only' | 'never';
  }
  /** A helper that answers as scripted and records its argv and the record it was given. */
  const fakeHelper = (script: Script) => {
    const argv: string[][] = [];
    const written: string[] = [];
    const signals: string[] = [];
    const children: (EventEmitter & { stdout: EventEmitter })[] = [];
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
        kill: (signal: string) => (signals.push(signal), true),
      });
      children.push(child);
      queueMicrotask(() => {
        child.emit('spawn');
        if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr));
        if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout));
        if (script.end === 'never') return;
        const exit = script.exit === undefined ? 0 : script.exit;
        child.emit('exit', exit, script.signal ?? null);
        if (script.end !== 'exit-only') child.emit('close', exit, script.signal ?? null);
      });
      return child;
    }) as unknown as typeof spawn;
    return { spawn: stub, argv, written, signals, children };
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
    ['no output at all', '', 'the output is not exactly one line'],
    [
      'a line without its newline',
      JSON.stringify({ kind: 'held', diagnostics: [] }),
      'the output is not exactly one line',
    ],
    ['text that is not JSON', 'not json\n', 'the output is not JSON'],
    ['null', 'null\n', 'the output is not an object'],
    ['an array', '[]\n', 'the output is not an object'],
    ['a number', '7\n', 'the output is not an object'],
    ['a string', '"held"\n', 'the output is not an object'],
    [
      'a kind inherited from Object',
      line({ kind: 'toString', diagnostics: [] }),
      'kind is unknown',
    ],
    ['a non-string kind', line({ kind: 7, diagnostics: [] }), 'kind is unknown'],
    [
      'held with an extra field',
      line({ kind: 'held', diagnostics: [], errno: null }),
      'the held result has the wrong fields',
    ],
    [
      'refused without its errno',
      line({ kind: 'refused', reason: 'capability', diagnostics: [] }),
      'the refused result has the wrong fields',
    ],
    [
      'an unknown reason',
      line({ kind: 'refused', reason: 'confused', errno: null, diagnostics: [] }),
      'reason is unknown',
    ],
    [
      'a null reason',
      line({ kind: 'refused', reason: null, errno: null, diagnostics: [] }),
      'reason is unknown',
    ],
    [
      'a lowercase errno',
      line({ kind: 'refused', reason: 'link_failed', errno: 'exdev', diagnostics: [] }),
      'errno is malformed',
    ],
    [
      'an errno with trailing text',
      line({ kind: 'refused', reason: 'link_failed', errno: 'EXDEV now', diagnostics: [] }),
      'errno is malformed',
    ],
    [
      'a numeric errno',
      line({ kind: 'refused', reason: 'link_failed', errno: 18, diagnostics: [] }),
      'errno is malformed',
    ],
    [
      'diagnostics that are not an array',
      line({ kind: 'held', diagnostics: {} }),
      'diagnostics are malformed',
    ],
    ['a null diagnostic', line({ kind: 'held', diagnostics: [null] }), 'diagnostics are malformed'],
    [
      'a diagnostic with an extra key',
      line({ kind: 'held', diagnostics: [{ step: 'close_lock', errno: null, why: 'x' }] }),
      'diagnostics are malformed',
    ],
    [
      'a diagnostic step inherited from Object',
      line({ kind: 'held', diagnostics: [{ step: 'toString', errno: null }] }),
      'diagnostics are malformed',
    ],
    [
      'a diagnostic with a lowercase errno',
      line({ kind: 'held', diagnostics: [{ step: 'close_lock', errno: 'ebadf' }] }),
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

  it('accepts an acquisition that also reports a cleanup problem', async () => {
    // the control for the table above: a valid line with diagnostics is published, not refused
    const stdout = line({ kind: 'acquired', diagnostics: [{ step: 'unlink_temp', errno: 'EIO' }] });
    const { outcome } = await take({ stdout });
    expect(outcome).toEqual({
      kind: 'acquired',
      handle: { controlDir: DIR, runId: 'run-1' },
      diagnostics: [{ step: 'unlink_temp', errno: 'EIO' }],
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

  it.each([
    ['exits 1', { stdout: ACQUIRED, exit: 1 }, ['exited 1']],
    [
      'is killed',
      { stdout: ACQUIRED, exit: null, signal: 'SIGSEGV' },
      ['killed by SIGSEGV', 'exited null'],
    ],
    [
      'is killed and complains',
      { stdout: ACQUIRED, exit: null, signal: 'SIGSEGV', stderr: 'oh no\n' },
      ['killed by SIGSEGV', 'exited null', 'wrote to stderr'],
    ],
    // a name that merely starts like a signal, and an exit code that merely starts like a number
    [
      'names an odd signal',
      { stdout: ACQUIRED, exit: null, signal: 'SIGTERM extra' },
      ['unrecognized', 'exited null'],
    ],
    [
      'reports a lowercase signal',
      { stdout: ACQUIRED, exit: null, signal: 'sigsegv' },
      ['unrecognized', 'exited null'],
    ],
    ['exits with a fraction', { stdout: ACQUIRED, exit: 1.5 }, ['unrecognized']],
  ] as [string, Script, string[]][])(
    'sanitizes what it reports when the helper %s',
    async (_label, script, categories) => {
      const { outcome } = await take(script);
      expect(outcome).toEqual({
        kind: 'unknown',
        handle: { controlDir: DIR, runId: 'run-1' },
        problems: categories,
      });
    },
  );

  it('spawns nothing once the deadline has passed, and never ran either way', async () => {
    // the same category as a spawn failure: both mean the helper never ran, which L2b must not clean up after
    const { outcome, helper } = await take({ stdout: ACQUIRED }, { deadline: Date.now() - 1 });
    expect(outcome).toEqual({
      kind: 'unknown',
      handle: { controlDir: DIR, runId: 'run-1' },
      problems: ['did not run', 'the output is not exactly one line'],
    });
    expect(helper.argv).toEqual([]);
  });

  describe('on controlled time', () => {
    afterEach(() => vi.useRealTimers());
    const T0 = 1_000_000;
    const D = T0 + 10_000;
    const clocked = async (script: Script) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(T0);
      const helper = fakeHelper(script);
      let outcome: AcquireOutcome | undefined;
      void acquireLockBounded(DIR, OWNER, {
        deadline: D,
        spawn: helper.spawn,
        now: Date.now,
        random: fixed(TOKEN, NONCE).random,
      }).then((r) => (outcome = r));
      return { helper, settled: () => outcome };
    };

    it('gives up on a helper that never ends, having asked it to stop', async () => {
      const run = await clocked({ stdout: ACQUIRED, end: 'never' });
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(run.settled()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      // this is the run whose private eligibility is unresolved: L2b must refuse to clean up after it
      expect(run.settled()).toEqual({
        kind: 'unknown',
        handle: { controlDir: DIR, runId: 'run-1' },
        problems: ['ended early', 'signalled to stop'],
      });
      expect(run.helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('gives up on a helper that exited without closing its streams', async () => {
      const run = await clocked({ stdout: ACQUIRED, end: 'exit-only' });
      await vi.advanceTimersByTimeAsync(10_000);
      // the same category as above, but it was seen to end: L2b may clean up after this one
      expect(run.settled()).toEqual({
        kind: 'unknown',
        handle: { controlDir: DIR, runId: 'run-1' },
        problems: ['ended early'],
      });
      expect(run.helper.signals).toEqual([]);
    });

    it('is unchanged by anything the helper does after it settles', async () => {
      const run = await clocked({ stdout: ACQUIRED, end: 'never' });
      await vi.advanceTimersByTimeAsync(10_000);
      const settled = structuredClone(run.settled());
      const child = run.helper.children[0];
      child?.stdout.emit('data', Buffer.from(ACQUIRED));
      child?.emit('exit', 0, null);
      child?.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run.settled()).toEqual(settled);
      expect(Object.isFrozen(run.settled())).toBe(true);
    });
  });

  it('keeps its secrets, and the helper’s words, out of every outcome', async () => {
    const outcomes: AcquireOutcome[] = [];
    const SENTINEL = 'SENTINEL-OUTPUT';
    for (const script of [
      { stdout: ACQUIRED },
      { stdout: line({ kind: 'held', diagnostics: [] }) },
      { stdout: line({ kind: 'refused', reason: 'capability', errno: null, diagnostics: [] }) },
      { stdout: `${SENTINEL}\n` },
      { stdout: ACQUIRED, stderr: `${SENTINEL}\n` },
    ] as Script[])
      outcomes.push((await take(script)).outcome);
    outcomes.push(
      await acquireLockBounded(
        DIR,
        { ...OWNER, pid: 0 },
        {
          deadline: Date.now() + 10_000,
          spawn: fakeHelper({ stdout: ACQUIRED }).spawn,
          random: fixed(TOKEN, NONCE).random,
        },
      ),
    );
    expect(outcomes.map((o) => o.kind)).toEqual([
      'acquired',
      'held',
      'refused',
      'unknown',
      'unknown',
      'not_attempted',
    ]);
    expect(outcomes.at(-1)).toEqual({ kind: 'not_attempted', reason: 'invalid_request' }); // no handle
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      for (const secret of [TOKEN, NONCE, SENTINEL]) expect(serialized).not.toContain(secret);
    }
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

  describe('and giving it back', () => {
    const RELEASED = line({ kind: 'released', diagnostics: [] });
    /** An acquisition through a fake helper, ending as scripted, and the handle it produced. */
    const acquired = async (
      script: Script = { stdout: ACQUIRED },
      over: Partial<AcquireOptions> = {},
    ) => {
      const { outcome } = await take(script, over);
      const handle = 'handle' in outcome ? outcome.handle : undefined;
      if (handle === undefined) throw new Error(`no handle: ${outcome.kind}`);
      return handle;
    };
    const release = async (
      handle: LockHandle,
      script: Script = { stdout: RELEASED },
      over: Partial<ReleaseOptions> = {},
    ) => {
      const helper = fakeHelper(script);
      const outcome = await releaseLockBounded(handle, {
        deadline: Date.now() + 10_000,
        spawn: helper.spawn,
        ...over,
      });
      return { outcome, helper };
    };

    it('asks the helper to release, sending back the record it was given', async () => {
      const handle = await acquired();
      const { outcome, helper } = await release(handle);
      expect(helper.argv).toEqual([[LOCK_HELPER, '--dir', DIR, '--mode', 'release']]);
      expect(JSON.parse(helper.written[0] ?? '')).toEqual({ ...OWNER, token: TOKEN, nonce: NONCE });
      expect(outcome).toEqual({ kind: 'released', diagnostics: [] });
    });

    it('releases each acquisition with its own secrets', async () => {
      const first = await acquired();
      const second = await (async () => {
        const helper = fakeHelper({ stdout: ACQUIRED });
        const outcome = await acquireLockBounded(
          DIR,
          { ...OWNER, runId: 'run-2' },
          {
            deadline: Date.now() + 10_000,
            spawn: helper.spawn,
            random: fixed('c'.repeat(32), 'd'.repeat(32)).random,
          },
        );
        if (outcome.kind !== 'acquired') throw new Error(outcome.kind);
        return outcome.handle;
      })();
      const one = await release(first);
      const two = await release(second);
      expect(JSON.parse(one.helper.written[0] ?? '')).toMatchObject({
        runId: 'run-1',
        token: TOKEN,
        nonce: NONCE,
      });
      expect(JSON.parse(two.helper.written[0] ?? '')).toMatchObject({
        runId: 'run-2',
        token: 'c'.repeat(32),
        nonce: 'd'.repeat(32),
      });
      expect(two.helper.written[0]).not.toContain(TOKEN); // never the other acquisition's secrets
    });

    it('releases after an acquisition whose helper exited without closing', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(1_000_000);
      const helper = fakeHelper({ stdout: ACQUIRED, end: 'exit-only' });
      let acquisition: AcquireOutcome | undefined;
      void acquireLockBounded(DIR, OWNER, {
        deadline: 1_010_000,
        spawn: helper.spawn,
        now: Date.now,
        random: fixed(TOKEN, NONCE).random,
      }).then((r) => (acquisition = r));
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      if (acquisition?.kind !== 'unknown') throw new Error(String(acquisition?.kind));
      // it was seen to end, so the lock it may have published can be cleaned up
      const { outcome, helper: releaseHelper } = await release(acquisition.handle);
      expect(outcome).toEqual({ kind: 'released', diagnostics: [] });
      expect(releaseHelper.argv).toHaveLength(1);
    });

    it('keeps a cleanup diagnostic from a release that succeeded', async () => {
      const handle = await acquired();
      // the helper's own release path reports this when its leftover was no longer the file it read
      const replaced = { step: 'temp_replaced', errno: null };
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'released', diagnostics: [replaced] }),
      });
      expect(outcome).toEqual({ kind: 'released', diagnostics: [replaced] });
      // a diagnostic is not a problem: the lock is gone, and the one attempt is spent
      expect((await release(handle)).outcome).toEqual({
        kind: 'not_attempted',
        reason: 'already_attempted',
      });
    });

    it('will not release after an acquisition whose helper never ran', async () => {
      const throwing = (() => {
        throw new Error('spawn python3 ENOENT');
      }) as unknown as typeof spawn;
      const outcome = await acquireLockBounded(DIR, OWNER, {
        deadline: Date.now() + 10_000,
        spawn: throwing,
        random: fixed(TOKEN, NONCE).random,
      });
      if (outcome.kind !== 'unknown') throw new Error(outcome.kind);
      const { outcome: released, helper } = await release(outcome.handle);
      expect(released).toEqual({ kind: 'not_attempted', reason: 'never_ran' });
      expect(helper.argv).toEqual([]); // nothing was published, so there is nothing to release
    });

    it('will not release after an acquisition that never terminated', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(1_000_000);
      const helper = fakeHelper({ stdout: ACQUIRED, end: 'never' });
      let acquisition: AcquireOutcome | undefined;
      void acquireLockBounded(DIR, OWNER, {
        deadline: 1_010_000,
        spawn: helper.spawn,
        now: Date.now,
        random: fixed(TOKEN, NONCE).random,
      }).then((r) => (acquisition = r));
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      if (acquisition?.kind !== 'unknown') throw new Error(String(acquisition?.kind));
      // its own report, kept apart from a spent budget: the helper and the lock are both unresolved
      const { outcome, helper: releaseHelper } = await release(
        acquisition.handle,
        { stdout: RELEASED },
        { deadline: Date.now() - 1 },
      );
      expect(outcome).toEqual({ kind: 'not_attempted', reason: 'unresolved', mayRemain: true });
      expect(releaseHelper.argv).toEqual([]);
    });

    it.each([
      ['a copy of a genuine handle', (h: LockHandle) => ({ ...h })],
      ['a hand-built handle', () => ({ controlDir: DIR, runId: 'run-1' })],
      ['an unrelated object', () => ({ controlDir: '/elsewhere', runId: 'run-9' })],
    ])('refuses %s, spawning nothing', async (_label, make) => {
      const handle = await acquired();
      const { outcome, helper } = await release(make(handle) as LockHandle);
      expect(outcome).toEqual({ kind: 'not_attempted', reason: 'unknown_handle' });
      expect(helper.argv).toEqual([]);
    });

    it('allows one attempt: a second says so, and an unconfirmed one leaves it unresolved', async () => {
      const handle = await acquired();
      expect((await release(handle)).outcome.kind).toBe('released');
      const again = await release(handle);
      expect(again.outcome).toEqual({ kind: 'not_attempted', reason: 'already_attempted' });
      expect(again.helper.argv).toEqual([]);

      const second = await acquired();
      const unclean = await release(second, { stdout: RELEASED, exit: 1 });
      expect(unclean.outcome).toEqual({ kind: 'unknown', problems: ['exited 1'], mayRemain: true });
      const retry = await release(second);
      expect(retry.outcome).toEqual({
        kind: 'not_attempted',
        reason: 'unresolved',
        mayRemain: true,
      });
      expect(retry.helper.argv).toEqual([]); // never retried on its own
    });

    it('lets only one release be in flight at a time', async () => {
      const handle = await acquired();
      const helper = fakeHelper({ stdout: RELEASED });
      const options = { deadline: Date.now() + 10_000, spawn: helper.spawn };
      const [first, second] = await Promise.all([
        releaseLockBounded(handle, options),
        releaseLockBounded(handle, options),
      ]);
      expect([first.kind, second.kind]).toEqual(['released', 'not_attempted']);
      expect(second).toEqual({ kind: 'not_attempted', reason: 'in_flight' });
      expect(helper.argv).toHaveLength(1);
    });

    it('spawns nothing with no time left, and stays usable afterwards', async () => {
      const handle = await acquired();
      const spent = await release(handle, { stdout: RELEASED }, { deadline: Date.now() });
      expect(spent.outcome).toEqual({
        kind: 'not_attempted',
        reason: 'budget_spent',
        mayRemain: true,
      });
      expect(spent.helper.argv).toEqual([]);
      // nothing was tried, so the one attempt is still there
      expect((await release(handle)).outcome).toEqual({ kind: 'released', diagnostics: [] });
    });

    it.each([
      ['two lines', RELEASED.repeat(2), ['the output is not exactly one line']],
      ['an unknown kind', line({ kind: 'freed', diagnostics: [] }), ['kind is unknown']],
      ['an acquisition kind', line({ kind: 'acquired', diagnostics: [] }), ['kind is unknown']],
    ])('reports unknown for %s, saying the lock may remain', async (_label, stdout, problems) => {
      const handle = await acquired();
      const { outcome } = await release(handle, { stdout });
      expect(outcome).toEqual({ kind: 'unknown', problems, mayRemain: true });
    });

    it('never repeats what a failed release said', async () => {
      const handle = await acquired();
      const throwing = (() => {
        throw new Error(`spawn SENTINEL-PATH ${TOKEN} ENOENT`);
      }) as unknown as typeof spawn;
      const outcome = await releaseLockBounded(handle, {
        deadline: Date.now() + 10_000,
        spawn: throwing,
      });
      expect(outcome).toEqual({
        kind: 'unknown',
        problems: ['did not run', 'the output is not exactly one line'],
        mayRemain: true,
      });
      const serialized = JSON.stringify(outcome);
      for (const secret of [TOKEN, NONCE, 'SENTINEL-PATH'])
        expect(serialized).not.toContain(secret);
    });
  });
});
