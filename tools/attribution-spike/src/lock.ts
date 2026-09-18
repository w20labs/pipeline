import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { type ChildOutcome, runChild } from './child.js';
import { helperTermination } from './helper-termination.js';

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
interface PreparedRecord {
  readonly input: string;
  readonly token: string;
  readonly nonce: string;
  /** The owner as it was when prepared: the handle is built from this, never from the caller's object. */
  readonly owner: LockOwner;
}
const RECORDS = new WeakMap<AcquireRequest, PreparedRecord>();

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
    token,
    nonce,
    owner: snapshot,
  });
  return Object.freeze({ ok: true, request });
};

/** Whose lock, and where. Nothing else: the token lives only in this module's private state. */
export interface LockHandle {
  readonly controlDir: string;
  readonly runId: string;
}

/** What the helper may report, once its run is known to have been clean. */
export type AcquireReason =
  | 'arguments'
  | 'capability'
  | 'directory_missing'
  | 'directory_unusable'
  | 'temp_exists'
  | 'temp_create_failed'
  | 'ownership_unknown'
  | 'write_failed'
  | 'fsync_failed'
  | 'close_failed'
  | 'link_failed';

export interface LockDiagnostic {
  readonly step: string;
  readonly errno: string | null;
}

export type AcquireOutcome =
  /** This run published the lock. */
  | {
      readonly kind: 'acquired';
      readonly handle: LockHandle;
      readonly diagnostics: readonly LockDiagnostic[];
    }
  /** Something else held it. The handle is for cleaning up this run's own leftover file. */
  | {
      readonly kind: 'held';
      readonly handle: LockHandle;
      readonly diagnostics: readonly LockDiagnostic[];
    }
  | {
      readonly kind: 'refused';
      readonly handle: LockHandle;
      readonly reason: AcquireReason;
      readonly errno: string | null;
      readonly diagnostics: readonly LockDiagnostic[];
    }
  /** Nothing about publication is established: the helper's run or its output could not be trusted. */
  | { readonly kind: 'unknown'; readonly handle: LockHandle; readonly problems: readonly string[] }
  /** Refused before anything was spawned. */
  | { readonly kind: 'not_attempted'; readonly reason: 'invalid_request' | 'random_failed' };

export interface AcquireOptions {
  readonly deadline: number;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
  readonly random?: RandomSource;
}

/** Whether the helper is known to have ended, never to have run, or neither. Only this module sees it. */
type Termination = 'ended' | 'never_ran' | 'unresolved';
/** Where a handle stands with release: fresh until one is attempted, then spent or unresolved. */
type ReleaseState = 'fresh' | 'in_flight' | 'spent' | 'unresolved';
interface Owned {
  /** The record as prepared: release sends these fields back, never anything a caller passes later. */
  readonly record: string;
  readonly termination: Termination;
  release: ReleaseState;
}
const OWNED = new WeakMap<LockHandle, Owned>();

const REASONS = new Set<string>([
  'arguments',
  'capability',
  'directory_missing',
  'directory_unusable',
  'temp_exists',
  'temp_create_failed',
  'ownership_unknown',
  'write_failed',
  'fsync_failed',
  'close_failed',
  'link_failed',
]);
const STEPS = new Set<string>([
  'close_temp',
  'unlink_temp',
  'temp_replaced',
  'temp_may_remain',
  'close_directory',
  'close_lock',
]);
const KEYS: Record<string, string> = {
  acquired: 'diagnostics,kind',
  held: 'diagnostics,kind',
  refused: 'diagnostics,errno,kind,reason',
};
const ERRNO = /^E[A-Z0-9]+$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const keysOf = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');
const validErrno = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && ERRNO.test(value));

const diagnosticsOf = (
  value: unknown,
  steps: ReadonlySet<string>,
): readonly LockDiagnostic[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const copies: LockDiagnostic[] = [];
  for (const entry of value as unknown[]) {
    const fields = record(entry);
    if (fields === undefined || keysOf(fields) !== 'errno,step') return undefined;
    const { step, errno } = fields;
    if (typeof step !== 'string' || !steps.has(step) || !validErrno(errno)) return undefined;
    copies.push(Object.freeze({ step, errno }));
  }
  return Object.freeze(copies);
};

/** The helper's line, or a problem. Fixed wording only: nothing it wrote is repeated. */
const parsedAs = (
  stdout: string,
  kinds: Record<string, string>,
  reasons: ReadonlySet<string>,
  steps: ReadonlySet<string>,
):
  | {
      readonly kind: string;
      readonly fields: Record<string, unknown>;
      readonly diagnostics: readonly LockDiagnostic[];
    }
  | string => {
  if (!stdout.endsWith('\n') || stdout.indexOf('\n') !== stdout.length - 1)
    return 'the output is not exactly one line';
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return 'the output is not JSON';
  }
  const fields = record(value);
  if (fields === undefined) return 'the output is not an object';
  const { kind } = fields;
  if (typeof kind !== 'string' || !Object.hasOwn(kinds, kind)) return 'kind is unknown';
  if (keysOf(fields) !== kinds[kind]) return `the ${kind} result has the wrong fields`;
  const diagnostics = diagnosticsOf(fields['diagnostics'], steps);
  if (diagnostics === undefined) return 'diagnostics are malformed';
  if (kind === 'refused') {
    // a string, not something that merely stringifies to one: ["capability"] must not pass
    const reason = fields['reason'];
    if (typeof reason !== 'string' || !reasons.has(reason)) return 'reason is unknown';
    if (!validErrno(fields['errno'])) return 'errno is malformed';
  }
  return { kind, fields, diagnostics };
};

/**
 * One token per termination problem, from fixed wording only. Nothing the helper or the system
 * wrote is repeated: the one prefix whose remainder is dropped is "did not run", whose detail is
 * whatever text the operating system produced.
 */
const FIXED: Record<string, string> = {
  'the helper ended exited': 'ended early',
  'the helper ended unterminated': 'ended early',
  'the helper was signalled to stop': 'signalled to stop',
  'the helper exceeded maxOutputBytes': 'exceeded its output bound',
  'the helper input delivery was not confirmed': 'input delivery unconfirmed',
  'the helper wrote to stderr': 'wrote to stderr',
};
const KILLED = /^the helper was killed by (SIG[A-Z0-9]+)$/;
const EXITED = /^the helper exited (-?\d+|null)$/;

const category = (problem: string): string => {
  if (problem.startsWith('the helper did not run: ')) return 'did not run';
  if (Object.hasOwn(FIXED, problem)) return FIXED[problem] as string;
  const killed = KILLED.exec(problem);
  if (killed !== null) return `killed by ${String(killed[1])}`;
  const exited = EXITED.exec(problem);
  if (exited !== null) return `exited ${String(exited[1])}`;
  return 'unrecognized';
};

const classify = (outcome: ChildOutcome): Termination =>
  outcome.kind === 'not_started' || outcome.kind === 'spawn_failed'
    ? 'never_ran'
    : outcome.kind === 'unterminated'
      ? 'unresolved'
      : 'ended';

/**
 * Take the lock, bounded. Every parsed outcome is gated on a clean run: an unclean one is `unknown`
 * whatever the helper printed, because what it published cannot be trusted either way.
 */
export const acquireLockBounded = async (
  controlDir: string,
  owner: LockOwner,
  options: AcquireOptions,
): Promise<AcquireOutcome> => {
  // copied before the random source runs: it is the caller's code and could change this object
  const { deadline, python, spawn, now, random } = options;
  const prepared = prepareAcquire(controlDir, owner, random ?? randomBytes);
  if (!prepared.ok) return Object.freeze({ kind: 'not_attempted', reason: prepared.reason });
  const state = RECORDS.get(prepared.request) as PreparedRecord;

  const outcome = await runChild(python ?? 'python3', prepared.request.argv, {
    deadline,
    termGraceMs: LOCK_TERM_GRACE_MS,
    killGraceMs: LOCK_KILL_GRACE_MS,
    spawn: spawn ?? nodeSpawn,
    now: now ?? Date.now,
    maxOutputBytes: LOCK_OUTPUT_BYTES,
    input: state.input,
  });
  // built from the snapshot the record was built from, never from the caller's object
  const handle: LockHandle = Object.freeze({ controlDir, runId: state.owner.runId });
  OWNED.set(handle, { record: state.input, termination: classify(outcome), release: 'fresh' });

  const termination = helperTermination(outcome);
  const line = parsedAs(termination.stdout, KEYS, REASONS, STEPS);
  // sanitized first: a spawn error's detail is the system's text, and may carry anything
  const problems = [
    ...termination.problems.map(category),
    ...(typeof line === 'string' ? [line] : []),
  ];
  if (problems.length > 0)
    return Object.freeze({ kind: 'unknown', handle, problems: Object.freeze(problems) });
  const { kind, fields, diagnostics } = line as Exclude<typeof line, string>;
  if (kind === 'refused')
    return Object.freeze({
      kind,
      handle,
      reason: fields['reason'] as AcquireReason,
      errno: fields['errno'] as string | null,
      diagnostics,
    });
  return Object.freeze({ kind: kind as 'acquired' | 'held', handle, diagnostics });
};

export type ReleaseReason =
  | 'arguments'
  | 'capability'
  | 'directory_missing'
  | 'directory_unusable'
  | 'lock_unusable'
  | 'not_regular'
  | 'fstat_failed'
  | 'read_failed'
  | 'too_large'
  | 'stat_failed'
  | 'unlink_failed';

export type ReleaseOutcome =
  /** What the helper established about the lock, from a run known to have been clean. */
  | {
      readonly kind: 'released' | 'missing' | 'not_ours' | 'unrecognized' | 'replaced';
      readonly diagnostics: readonly LockDiagnostic[];
    }
  | {
      readonly kind: 'refused';
      readonly reason: ReleaseReason;
      readonly errno: string | null;
      readonly diagnostics: readonly LockDiagnostic[];
    }
  /** Whether the lock is gone is not established. It may remain. */
  | { readonly kind: 'unknown'; readonly problems: readonly string[]; readonly mayRemain: true }
  /** Nothing was spawned. `unresolved` keeps the acquisition's own, distinct report. */
  | {
      readonly kind: 'not_attempted';
      readonly reason:
        | 'unknown_handle'
        | 'never_ran'
        | 'unresolved'
        | 'in_flight'
        | 'already_attempted'
        | 'budget_spent';
      readonly mayRemain?: true;
    };

export interface ReleaseOptions {
  readonly deadline: number;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

const RELEASE_REASONS = new Set<string>([
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
]);
const RELEASE_KINDS: Record<string, string> = {
  released: 'diagnostics,kind',
  missing: 'diagnostics,kind',
  not_ours: 'diagnostics,kind',
  unrecognized: 'diagnostics,kind',
  replaced: 'diagnostics,kind',
  refused: 'diagnostics,errno,kind,reason',
};
const RELEASE_STEPS = new Set<string>([
  'close_lock',
  'close_directory',
  'temp_unusable',
  'temp_fstat_failed',
  'temp_read_failed',
  'temp_too_large',
  'temp_partial',
  'temp_unrecognized',
  'temp_stat_failed',
  'temp_replaced', // the leftover was no longer the file that was read, so it was left alone

  'temp_unlink_failed',
  'temp_close_failed',
]);

const notAttempted = (
  reason: Extract<ReleaseOutcome, { kind: 'not_attempted' }>['reason'],
  mayRemain = false,
): ReleaseOutcome =>
  Object.freeze({
    kind: 'not_attempted',
    reason,
    ...(mayRemain ? { mayRemain: true as const } : {}),
  });

/**
 * Release the lock this handle stands for — if this module issued the handle, if the acquisition
 * ended, and if it has not been attempted already.
 *
 * Order matters: the handle, then eligibility, then the attempt state, then the budget. An
 * acquisition whose helper never terminated keeps its own report even when the budget is also gone.
 * Nothing is ever retried automatically: an unconfirmed release says the lock may remain and leaves
 * the rest to the operator.
 */
export const releaseLockBounded = async (
  handle: LockHandle,
  options: ReleaseOptions,
): Promise<ReleaseOutcome> => {
  const { deadline, python, spawn, now } = options;
  const owned = OWNED.get(handle); // a copied or fabricated handle is in no map: fail closed
  if (owned === undefined) return notAttempted('unknown_handle');
  if (owned.termination === 'never_ran') return notAttempted('never_ran');
  if (owned.termination === 'unresolved') return notAttempted('unresolved', true);
  if (owned.release === 'in_flight') return notAttempted('in_flight');
  if (owned.release === 'spent') return notAttempted('already_attempted');
  if (owned.release === 'unresolved') return notAttempted('unresolved', true);
  // nothing tried, so the handle stays usable: a later call with time left may still release it
  if ((now ?? Date.now)() >= deadline) return notAttempted('budget_spent', true);

  owned.release = 'in_flight'; // marked before awaiting, so a second call cannot overlap this one
  const outcome = await runChild(
    python ?? 'python3',
    [LOCK_HELPER, '--dir', handle.controlDir, '--mode', 'release'],
    {
      deadline,
      termGraceMs: LOCK_TERM_GRACE_MS,
      killGraceMs: LOCK_KILL_GRACE_MS,
      spawn: spawn ?? nodeSpawn,
      now: now ?? Date.now,
      maxOutputBytes: LOCK_OUTPUT_BYTES,
      input: owned.record,
    },
  );
  const termination = helperTermination(outcome);
  const line = parsedAs(termination.stdout, RELEASE_KINDS, RELEASE_REASONS, RELEASE_STEPS);
  const problems = [
    ...termination.problems.map(category),
    ...(typeof line === 'string' ? [line] : []),
  ];
  if (problems.length > 0) {
    owned.release = 'unresolved'; // whether the lock is gone is not established
    return Object.freeze({ kind: 'unknown', problems: Object.freeze(problems), mayRemain: true });
  }
  owned.release = 'spent';
  const { kind, fields, diagnostics } = line as Exclude<typeof line, string>;
  if (kind === 'refused')
    return Object.freeze({
      kind,
      reason: fields['reason'] as ReleaseReason,
      errno: fields['errno'] as string | null,
      diagnostics,
    });
  return Object.freeze({
    kind: kind as 'released' | 'missing' | 'not_ours' | 'unrecognized' | 'replaced',
    diagnostics,
  });
};
