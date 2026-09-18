import { afterEach, describe, expect, it, vi } from 'vitest';

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  acquireLockBounded,
  type AcquireOptions,
  type AcquireOutcome,
  LOCK_HELPER,
  LOCK_KILL_GRACE_MS,
  LOCK_OUTPUT_BYTES,
  LOCK_TERM_GRACE_MS,
  type LockDiagnostic,
  type LockHandle,
  type LockOwner,
  prepareAcquire,
  releaseLockBounded,
  type ReleaseOptions,
  type ReleaseOutcome,
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

    /**
     * Every reason and step the helper's release path may send. Listed here rather than imported,
     * so the allowlists are pinned by this test and not by whatever the module happens to hold.
     */
    const RELEASE_REASONS = [
      'arguments',
      'capability',
      'directory_missing',
      'directory_unusable',
      'lock_unusable',
      'not_regular',
      'fstat_failed',
      'read_failed',
      'too_large',
      'stat_failed',
      'unlink_failed',
    ] as const;
    const RELEASE_STEPS = [
      'close_lock',
      'close_directory',
      'temp_unusable',
      'temp_fstat_failed',
      'temp_read_failed',
      'temp_too_large',
      'temp_partial',
      'temp_unrecognized',
      'temp_stat_failed',
      'temp_replaced',
      'temp_unlink_failed',
      'temp_close_failed',
    ] as const;

    it.each([
      ['missing', 'temp_partial', null],
      ['not_ours', 'temp_unrecognized', null],
      ['unrecognized', 'temp_close_failed', 'EBADF'],
      ['replaced', 'temp_replaced', null],
      ['released', 'temp_unlink_failed', 'EIO'],
    ] as [string, string, string | null][])(
      'passes %s through with the diagnostic it carried',
      async (kind, step, errno) => {
        const handle = await acquired();
        const diagnostics = [{ step, errno }];
        const { outcome } = await release(handle, { stdout: line({ kind, diagnostics }) });
        expect(outcome).toEqual({ kind, diagnostics });
      },
    );

    it.each([
      ['an errno', 'unlink_failed', 'EPERM', []],
      ['no errno', 'not_regular', null, []],
      [
        'a close failure beside it',
        'lock_unusable',
        'EIO',
        [{ step: 'close_directory', errno: 'EBADF' }],
      ],
    ] as [string, string, string | null, { step: string; errno: string | null }[]][])(
      'passes a refusal with %s through unchanged',
      async (_label, reason, errno, diagnostics) => {
        const handle = await acquired();
        const { outcome } = await release(handle, {
          stdout: line({ kind: 'refused', reason, errno, diagnostics }),
        });
        expect(outcome).toEqual({ kind: 'refused', reason, errno, diagnostics });
      },
    );

    it.each(RELEASE_REASONS)('accepts %s as a reason', async (reason) => {
      const handle = await acquired();
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'refused', reason, errno: null, diagnostics: [] }),
      });
      // an allowlist missing this reason would report unknown instead
      expect(outcome).toEqual({ kind: 'refused', reason, errno: null, diagnostics: [] });
    });

    it.each(RELEASE_STEPS)('accepts %s as a diagnostic step', async (step) => {
      const handle = await acquired();
      const diagnostics = [{ step, errno: 'EIO' }];
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'released', diagnostics }),
      });
      expect(outcome).toEqual({ kind: 'released', diagnostics });
    });

    it('keeps several diagnostics in the order the helper reported them', async () => {
      const handle = await acquired();
      const diagnostics = [
        { step: 'temp_stat_failed', errno: 'EIO' },
        { step: 'close_lock', errno: null },
        { step: 'temp_stat_failed', errno: 'EPERM' },
        { step: 'close_directory', errno: 'EBADF' },
      ];
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'not_ours', diagnostics }),
      });
      if (outcome.kind !== 'not_ours') throw new Error(outcome.kind);
      // order, repeats and each errno: the same sequence, not a set of steps
      expect(outcome.diagnostics).toEqual(diagnostics);
      expect(outcome.diagnostics.map((d) => `${d.step}:${String(d.errno)}`)).toEqual(
        diagnostics.map((d) => `${d.step}:${String(d.errno)}`),
      );
    });

    it('hands back an outcome nothing can change afterwards', async () => {
      const handle = await acquired();
      const diagnostics = [
        { step: 'temp_replaced', errno: null },
        { step: 'close_lock', errno: 'EBADF' },
      ];
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'released', diagnostics }),
      });
      if (outcome.kind !== 'released') throw new Error(outcome.kind);
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(Object.isFrozen(outcome.diagnostics)).toBe(true);
      for (const entry of outcome.diagnostics) expect(Object.isFrozen(entry)).toBe(true);
      const mutable = outcome.diagnostics as LockDiagnostic[];
      expect(() => mutable.push({ step: 'close_lock', errno: null })).toThrow(TypeError);
      expect(() => ((mutable[0] as { step: string }).step = 'temp_partial')).toThrow(TypeError);
      expect(outcome.diagnostics).toEqual(diagnostics); // every attempt refused, nothing moved
    });

    const refusal = (over: Record<string, unknown>) =>
      line({ kind: 'refused', reason: 'unlink_failed', errno: null, diagnostics: [], ...over });
    const carrying = (diagnostics: unknown) => line({ kind: 'released', diagnostics });

    it.each([
      ['no output at all', '', 'the output is not exactly one line'],
      [
        'a line without its newline',
        JSON.stringify({ kind: 'released', diagnostics: [] }),
        'the output is not exactly one line',
      ],
      ['text that is not JSON', 'not json\n', 'the output is not JSON'],
      ['null', 'null\n', 'the output is not an object'],
      ['an array', '[]\n', 'the output is not an object'],
      ['a number', '7\n', 'the output is not an object'],
      ['a string', '"released"\n', 'the output is not an object'],
      [
        'a kind inherited from Object',
        line({ kind: 'toString', diagnostics: [] }),
        'kind is unknown',
      ],
      ['a non-string kind', line({ kind: 7, diagnostics: [] }), 'kind is unknown'],
      [
        'released with an extra field',
        line({ kind: 'released', diagnostics: [], errno: null }),
        'the released result has the wrong fields',
      ],
      [
        'missing carrying a reason',
        line({ kind: 'missing', reason: 'not_regular', diagnostics: [] }),
        'the missing result has the wrong fields',
      ],
      [
        'replaced without its diagnostics',
        line({ kind: 'replaced' }),
        'the replaced result has the wrong fields',
      ],
      [
        'refused without its errno',
        line({ kind: 'refused', reason: 'not_regular', diagnostics: [] }),
        'the refused result has the wrong fields',
      ],
      ['an unknown reason', refusal({ reason: 'confused' }), 'reason is unknown'],
      ['a null reason', refusal({ reason: null }), 'reason is unknown'],
      // the acquire side's own reason and step: the release tables are not that set
      [
        'a reason only acquisition can give',
        refusal({ reason: 'link_failed' }),
        'reason is unknown',
      ],
      [
        'a step only acquisition can report',
        carrying([{ step: 'unlink_temp', errno: null }]),
        'diagnostics are malformed',
      ],
      ['a lowercase errno', refusal({ reason: 'stat_failed', errno: 'eio' }), 'errno is malformed'],
      [
        'an errno with trailing text',
        refusal({ reason: 'stat_failed', errno: 'EIO now' }),
        'errno is malformed',
      ],
      ['a numeric errno', refusal({ reason: 'stat_failed', errno: 5 }), 'errno is malformed'],
      ['diagnostics that are not an array', carrying({}), 'diagnostics are malformed'],
      ['a null diagnostic', carrying([null]), 'diagnostics are malformed'],
      [
        'a diagnostic with an extra key',
        carrying([{ step: 'close_lock', errno: null, why: 'x' }]),
        'diagnostics are malformed',
      ],
      [
        'a diagnostic missing its errno',
        carrying([{ step: 'close_lock' }]),
        'diagnostics are malformed',
      ],
      [
        'a diagnostic step inherited from Object',
        carrying([{ step: 'toString', errno: null }]),
        'diagnostics are malformed',
      ],
      ['an unknown step', carrying([{ step: 'nope', errno: null }]), 'diagnostics are malformed'],
      ['a non-string step', carrying([{ step: 7, errno: null }]), 'diagnostics are malformed'],
      [
        'a diagnostic with a lowercase errno',
        carrying([{ step: 'close_lock', errno: 'ebadf' }]),
        'diagnostics are malformed',
      ],
      [
        'a diagnostic with a numeric errno',
        carrying([{ step: 'close_lock', errno: 5 }]),
        'diagnostics are malformed',
      ],
      [
        'a second diagnostic that is malformed',
        carrying([
          { step: 'close_lock', errno: null },
          { step: 'nope', errno: null },
        ]),
        'diagnostics are malformed',
      ],
    ])('reports unknown for %s, saying the lock may remain', async (_label, stdout, problem) => {
      const handle = await acquired();
      const { outcome } = await release(handle, { stdout });
      expect(outcome).toEqual({ kind: 'unknown', problems: [problem], mayRemain: true });
    });

    it.each([
      ['an array-valued reason', refusal({ reason: ['unlink_failed'] })],
      ['a numeric reason', refusal({ reason: 7 })],
    ])('reports unknown for %s, which only looks like one', async (_label, stdout) => {
      const handle = await acquired();
      const { outcome } = await release(handle, { stdout });
      expect(outcome).toEqual({
        kind: 'unknown',
        problems: ['reason is unknown'],
        mayRemain: true,
      });
    });

    describe('on controlled time', () => {
      // restored even when an assertion throws, so a failure here cannot stop the clock for the rest
      afterEach(() => vi.useRealTimers());
      const T0 = 2_000_000;
      const D = T0 + 10_000;
      /**
       * A clean acquisition on real time, then the clock taken over for the release itself. The
       * release is started, not awaited: the caller advances time and reads what has settled.
       */
      const clocked = async (script: Script) => {
        const handle = await acquired();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(T0);
        const helper = fakeHelper(script);
        let outcome: ReleaseOutcome | undefined;
        void releaseLockBounded(handle, {
          deadline: D,
          spawn: helper.spawn,
          now: Date.now,
        }).then((r) => (outcome = r));
        return { handle, helper, settled: () => outcome };
      };
      /** What a later call reports, on real time, and whether it spawned anything. */
      const again = async (handle: LockHandle) => {
        vi.useRealTimers();
        return release(handle);
      };

      it('gives up on a release that never ends, having asked it to stop', async () => {
        const run = await clocked({ stdout: RELEASED, end: 'never' });
        await vi.advanceTimersByTimeAsync(10_000 - 1);
        expect(run.settled()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(run.settled()).toEqual({
          kind: 'unknown',
          problems: ['ended early', 'signalled to stop'],
          mayRemain: true,
        });
        expect(run.helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
      });

      it('carves the lock’s own grace windows out of the release budget', async () => {
        const run = await clocked({ stdout: RELEASED, end: 'never' });
        const waiting = 10_000 - LOCK_TERM_GRACE_MS - LOCK_KILL_GRACE_MS;
        await vi.advanceTimersByTimeAsync(waiting - 1);
        expect(run.helper.signals).toEqual([]); // both graces come out of the one budget
        await vi.advanceTimersByTimeAsync(1);
        expect(run.helper.signals).toEqual(['SIGTERM']);
        await vi.advanceTimersByTimeAsync(LOCK_TERM_GRACE_MS - 1);
        expect(run.helper.signals).toEqual(['SIGTERM']);
        await vi.advanceTimersByTimeAsync(1);
        expect(run.helper.signals).toEqual(['SIGTERM', 'SIGKILL']);
      });

      it('will not try again after a release that never ended', async () => {
        const run = await clocked({ stdout: RELEASED, end: 'never' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.settled()?.kind).toBe('unknown');
        const retry = await again(run.handle);
        expect(retry.outcome).toEqual({
          kind: 'not_attempted',
          reason: 'unresolved',
          mayRemain: true,
        });
        expect(retry.helper.argv).toEqual([]); // whether the lock is gone is still not established
      });

      it('gives up on a release that exited without closing its streams', async () => {
        const run = await clocked({ stdout: RELEASED, end: 'exit-only' });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.settled()).toEqual({
          kind: 'unknown',
          problems: ['ended early'],
          mayRemain: true,
        });
        expect(run.helper.signals).toEqual([]); // it had already exited: nothing to stop
        const retry = await again(run.handle);
        expect(retry.outcome).toEqual({
          kind: 'not_attempted',
          reason: 'unresolved',
          mayRemain: true,
        });
        expect(retry.helper.argv).toEqual([]);
      });

      it('is unchanged by anything the helper does after it settles', async () => {
        const run = await clocked({ stdout: RELEASED, end: 'never' });
        await vi.advanceTimersByTimeAsync(10_000);
        const settled = structuredClone(run.settled());
        const child = run.helper.children[0];
        child?.stdout.emit('data', Buffer.from(RELEASED));
        child?.emit('exit', 0, null);
        child?.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(run.settled()).toEqual(settled);
        expect(Object.isFrozen(run.settled())).toBe(true);
        // the private state, which a frozen outcome says nothing about, is still unresolved
        const retry = await again(run.handle);
        expect(retry.outcome).toEqual({
          kind: 'not_attempted',
          reason: 'unresolved',
          mayRemain: true,
        });
        expect(retry.helper.argv).toEqual([]);
      });

      it('settles a clean release at once, and spends the one attempt', async () => {
        const run = await clocked({ stdout: RELEASED });
        await vi.advanceTimersByTimeAsync(0); // no part of it waits for the deadline
        expect(run.settled()).toEqual({ kind: 'released', diagnostics: [] });
        const retry = await again(run.handle);
        expect(retry.outcome).toEqual({ kind: 'not_attempted', reason: 'already_attempted' });
        expect(retry.helper.argv).toEqual([]);
      });
    });

    it.each([
      ['exits 1', { stdout: RELEASED, exit: 1 }, ['exited 1']],
      [
        'is killed',
        { stdout: RELEASED, exit: null, signal: 'SIGSEGV' },
        ['killed by SIGSEGV', 'exited null'],
      ],
      [
        'is killed and complains',
        { stdout: RELEASED, exit: null, signal: 'SIGSEGV', stderr: 'oh no\n' },
        ['killed by SIGSEGV', 'exited null', 'wrote to stderr'],
      ],
      // a name that merely starts like a signal, and an exit code that merely starts like a number
      [
        'names an odd signal',
        { stdout: RELEASED, exit: null, signal: 'SIGTERM extra' },
        ['unrecognized', 'exited null'],
      ],
      [
        'reports a lowercase signal',
        { stdout: RELEASED, exit: null, signal: 'sigsegv' },
        ['unrecognized', 'exited null'],
      ],
      ['exits with a fraction', { stdout: RELEASED, exit: 1.5 }, ['unrecognized']],
      [
        // cut short at the bound, so the run ended early and what it printed cannot be read
        'overflows its output',
        { stdout: 'x'.repeat(LOCK_OUTPUT_BYTES + 1) },
        ['ended early', 'exceeded its output bound', 'the output is not exactly one line'],
      ],
      [
        'never takes its input',
        { stdout: RELEASED, refuseInput: true },
        ['input delivery unconfirmed'],
      ],
    ] as [string, Script, string[]][])(
      'sanitizes what it reports when a release %s',
      async (_label, script, categories) => {
        const handle = await acquired();
        const { outcome } = await release(handle, script);
        expect(outcome).toEqual({ kind: 'unknown', problems: categories, mayRemain: true });
      },
    );

    it('reports unknown for a valid released line from an unclean run', async () => {
      const handle = await acquired();
      // the line says the lock is gone; the run does not support that, so nothing is established
      const { outcome } = await release(handle, { stdout: RELEASED, exit: 1 });
      expect(outcome).toEqual({ kind: 'unknown', problems: ['exited 1'], mayRemain: true });
      const retry = await release(handle);
      expect(retry.outcome).toEqual({
        kind: 'not_attempted',
        reason: 'unresolved',
        mayRemain: true,
      });
      expect(retry.helper.argv).toEqual([]);
    });

    it('reports how the run ended before what it printed', async () => {
      const handle = await acquired();
      const { outcome } = await release(handle, {
        stdout: line({ kind: 'freed', diagnostics: [] }),
        exit: 1,
      });
      expect(outcome).toEqual({
        kind: 'unknown',
        problems: ['exited 1', 'kind is unknown'],
        mayRemain: true,
      });
    });

    it('keeps its secrets, and the helper’s words, out of every release outcome', async () => {
      const SENTINEL = 'SENTINEL-OUTPUT';
      const outcomes: ReleaseOutcome[] = [];
      // a fresh acquisition per case: one handle allows one attempt
      for (const script of [
        { stdout: RELEASED },
        { stdout: line({ kind: 'missing', diagnostics: [] }) },
        {
          stdout: line({ kind: 'not_ours', diagnostics: [{ step: 'close_lock', errno: 'EBADF' }] }),
        },
        { stdout: line({ kind: 'unrecognized', diagnostics: [] }) },
        { stdout: line({ kind: 'replaced', diagnostics: [] }) },
        { stdout: line({ kind: 'refused', reason: 'stat_failed', errno: 'EIO', diagnostics: [] }) },
        { stdout: `${SENTINEL}\n` },
        { stdout: RELEASED, stderr: `${SENTINEL}\n` },
        { stdout: line({ kind: TOKEN, diagnostics: [] }) }, // the helper echoing the token back
      ] as Script[])
        outcomes.push((await release(await acquired(), script)).outcome);

      const spent = await acquired();
      outcomes.push((await release(spent, { stdout: RELEASED }, { deadline: Date.now() })).outcome);
      outcomes.push((await release({ ...spent })).outcome);
      const unclean = await acquired();
      // an unconfirmed release, then the distinct refusal it leaves behind
      outcomes.push((await release(unclean, { stdout: RELEASED, exit: 1 })).outcome);
      outcomes.push((await release(unclean)).outcome);
      const done = await acquired();
      outcomes.push((await release(done)).outcome);
      outcomes.push((await release(done)).outcome);

      expect(outcomes.map((o) => (o.kind === 'not_attempted' ? o.reason : o.kind))).toEqual([
        'released',
        'missing',
        'not_ours',
        'unrecognized',
        'replaced',
        'refused',
        'unknown',
        'unknown',
        'unknown',
        'budget_spent',
        'unknown_handle',
        'unknown',
        'unresolved',
        'released',
        'already_attempted',
      ]);
      for (const outcome of outcomes) {
        const serialized = JSON.stringify(outcome) + JSON.stringify(Object.entries(outcome));
        for (const secret of [TOKEN, NONCE, SENTINEL]) expect(serialized).not.toContain(secret);
      }
    });

    it('keeps the record the helper was given out of the handle', async () => {
      const handle = await acquired();
      expect(Object.keys(handle)).toEqual(['controlDir', 'runId']);
      expect(Object.isFrozen(handle)).toBe(true);
      const reachable = JSON.stringify(handle) + JSON.stringify(Object.entries(handle));
      for (const secret of [TOKEN, NONCE]) expect(reachable).not.toContain(secret);
      // and a refusal naming the handle reports where and whose, never what it holds
      const { outcome } = await release({ ...handle });
      expect(outcome).toEqual({ kind: 'not_attempted', reason: 'unknown_handle' });
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
