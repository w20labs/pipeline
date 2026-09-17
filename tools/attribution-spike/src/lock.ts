import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Taking and releasing the research run lock through `lock-file.py`.
 *
 * **The token never leaves this module.** It is drawn here, sent to the helper on stdin — never in
 * argv, where every user could read it — and kept in a module-private map. What a caller receives
 * carries only where the lock is and whose run it is; nothing token-bearing is returned, logged or
 * serialized anywhere.
 *
 * This part prepares a request: it validates and snapshots its inputs and builds the invocation.
 * Nothing is spawned here.
 */

/** Located beside this module: `src/` in tests, `dist/` once built. */
export const LOCK_HELPER = fileURLToPath(new URL('./lock-file.py', import.meta.url));
/** One line, an envelope and a few diagnostics: far more than the helper can write. */
export const LOCK_OUTPUT_BYTES = 4_096;
export const LOCK_TERM_GRACE_MS = 200;
export const LOCK_KILL_GRACE_MS = 200;
const SECRET_BYTES = 16;

/** Sixteen random bytes per call. Production passes `randomBytes`; tests pass their own. */
export type RandomSource = (bytes: number) => Uint8Array;

export interface LockOwner {
  readonly runId: string;
  readonly pid: number;
  readonly startedAt: string;
}

/** What a caller may see of a prepared request: the argv, which carries nothing secret. */
export interface AcquireRequest {
  readonly argv: readonly string[];
}

export type Prepared =
  | { readonly ok: true; readonly request: AcquireRequest }
  | { readonly ok: false; readonly reason: 'invalid_request' | 'random_failed' };

/** The record for stdin, kept out of the public value: only this module can reach it. */
const RECORDS = new WeakMap<AcquireRequest, { readonly input: string; readonly nonce: string }>();

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const realStamp = (value: string): boolean => {
  if (!STAMP.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z'));
};

const validOwner = (owner: LockOwner): boolean =>
  // the pattern alone would coerce a number, a boolean or undefined into a string first
  typeof owner.runId === 'string' &&
  RUN_ID.test(owner.runId) &&
  Number.isSafeInteger(owner.pid) &&
  typeof owner.pid === 'number' &&
  owner.pid > 0 &&
  typeof owner.startedAt === 'string' &&
  realStamp(owner.startedAt);

/** Sixteen bytes as hex, copied at once: the source may hand back a buffer it reuses. */
const secret = (random: RandomSource): string | undefined => {
  const value: unknown = random(SECRET_BYTES);
  if (!(value instanceof Uint8Array) || value.byteLength !== SECRET_BYTES) return undefined;
  return Buffer.from(value.subarray(0, SECRET_BYTES)).toString('hex');
};

/**
 * Validate, snapshot and build one acquire invocation — or refuse. The owner's fields are copied
 * before the random source is called, because that source is the caller's code and could change
 * them. Nothing is spawned, and the record it built is reachable only from inside this module.
 */
export const prepareAcquire = (
  controlDir: string,
  owner: LockOwner,
  random: RandomSource = randomBytes,
): Prepared => {
  if (typeof controlDir !== 'string' || !controlDir.startsWith('/') || controlDir.includes('\0'))
    return Object.freeze({ ok: false, reason: 'invalid_request' });
  const snapshot: LockOwner = Object.freeze({
    runId: owner.runId,
    pid: owner.pid,
    startedAt: owner.startedAt,
  });
  if (!validOwner(snapshot)) return Object.freeze({ ok: false, reason: 'invalid_request' });

  let token: string | undefined;
  let nonce: string | undefined;
  try {
    token = secret(random); // copied here, before the source is asked again
    nonce = token === undefined ? undefined : secret(random);
  } catch {
    return Object.freeze({ ok: false, reason: 'random_failed' }); // the source is caller code
  }
  if (token === undefined || nonce === undefined)
    return Object.freeze({ ok: false, reason: 'random_failed' });

  const request: AcquireRequest = Object.freeze({
    argv: Object.freeze([LOCK_HELPER, '--dir', controlDir, '--mode', 'acquire']),
  });
  RECORDS.set(request, {
    input: JSON.stringify({ ...snapshot, token, nonce }),
    nonce,
  });
  return Object.freeze({ ok: true, request });
};
