import { describe, expect, it } from 'vitest';

import { LOCK_HELPER, type LockOwner, prepareAcquire, type RandomSource } from '../src/lock.js';

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
