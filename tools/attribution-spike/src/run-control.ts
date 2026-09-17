import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/** A research run's controls: one run at a time, a record before launch, one allowed prompt. */

export interface LockFs {
  /** Create `path` exclusively, returning its descriptor; fails if anything is already there. */
  open(path: string): number;
  /** Write up to `length` bytes of `buffer` from `offset`, returning how many were written. */
  write(fd: number, buffer: Buffer, offset: number, length: number): number;
  close(fd: number): void;
  read(path: string): string;
  unlink(path: string): void;
}

export const nodeLockFs: LockFs = {
  open: (path) => openSync(path, 'wx'),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  close: (fd) => closeSync(fd),
  read: (path) => readFileSync(path, 'utf8'),
  unlink: (path) => unlinkSync(path),
};

export interface HeldLock {
  readonly path: string;
  readonly token: string;
}

export type Acquired =
  | { readonly ok: true; readonly lock: HeldLock }
  | {
      readonly ok: false;
      readonly why: string;
      readonly cleanupDiagnostics?: readonly string[];
      /** A partial lock this invocation created and could not confirm removing. */
      readonly strandedLock?: string;
    };

/**
 * Take the run lock, or refuse. A refused attempt changes nothing: whatever holds the lock keeps it.
 *
 * Ownership is handed back only for a lock whose whole record was written and closed. If anything
 * fails after the exclusive create succeeded, the file is this invocation's own, and it is removed;
 * when removal cannot be confirmed its path is reported as `strandedLock` instead of claimed.
 *
 * **Cooperative, not enforced.** Checking a lock and unlinking it are not atomic. The rule every
 * participant follows is that a lock another run holds is never replaced or removed. Release
 * refuses when it can see a replacement; it cannot protect against one landing between its check
 * and its unlink, and does not claim to.
 */
export const acquireLock = (
  path: string,
  owner: { readonly runId: string; readonly pid: number; readonly startedAt: number },
  fs: LockFs = nodeLockFs,
): Acquired => {
  const token = randomUUID();
  const record = Buffer.from(JSON.stringify({ ...owner, token }));
  let fd: number;
  try {
    fd = fs.open(path);
  } catch (cause) {
    // Nothing was created, so nothing is removed.
    const code = (cause as NodeJS.ErrnoException).code;
    return {
      ok: false,
      why:
        code === 'EEXIST'
          ? 'another run holds the lock'
          : `the lock could not be taken: ${String(cause)}`,
    };
  }

  let failure: string | undefined;
  try {
    for (let offset = 0; offset < record.length;) {
      const written = fs.write(fd, record, offset, record.length - offset);
      if (!(written > 0)) throw new Error('the write made no progress');
      offset += written;
    }
  } catch (cause) {
    failure = `the lock could not be written: ${String(cause)}`;
  }
  const cleanupDiagnostics: string[] = [];
  try {
    fs.close(fd); // attempted whether or not the write succeeded
  } catch (cause) {
    const closing = `the lock could not be closed: ${String(cause)}`;
    if (failure === undefined) failure = closing;
    else cleanupDiagnostics.push(closing);
  }
  if (failure === undefined) return { ok: true, lock: { path, token } };

  try {
    fs.unlink(path);
  } catch (cause) {
    cleanupDiagnostics.push(`the partial lock could not be removed: ${String(cause)}`);
    return { ok: false, why: failure, cleanupDiagnostics, strandedLock: path };
  }
  return { ok: false, why: failure, cleanupDiagnostics };
};

/** Release a lock this invocation took. Returns a diagnostic when it did not, never throws. */
export const releaseLock = (lock: HeldLock, fs: LockFs = nodeLockFs): string | undefined => {
  let held: unknown;
  try {
    held = JSON.parse(fs.read(lock.path));
  } catch (cause) {
    return `the lock could not be checked before release: ${String(cause)}`;
  }
  const token = (held as { token?: unknown } | null)?.token;
  if (token !== lock.token) return 'the lock was replaced; it was left as found';
  try {
    fs.unlink(lock.path);
  } catch (cause) {
    return `the lock could not be released: ${String(cause)}`;
  }
  return undefined;
};

export type Guarded<T> =
  | { readonly ok: true; readonly value: T; readonly cleanupDiagnostics: readonly string[] }
  | {
      readonly ok: false;
      readonly failure: string;
      readonly cleanupDiagnostics: readonly string[];
    };

/** Run `work`, then every cleanup. A cleanup failure never replaces or hides the run's failure. */
export const withCleanup = async <T>(
  work: () => Promise<T>,
  cleanups: readonly (() => string | undefined | Promise<string | undefined>)[],
): Promise<Guarded<T>> => {
  let outcome: { ok: true; value: T } | { ok: false; failure: string };
  try {
    outcome = { ok: true, value: await work() };
  } catch (cause) {
    outcome = { ok: false, failure: cause instanceof Error ? cause.message : String(cause) };
  }
  const cleanupDiagnostics: string[] = [];
  for (const cleanup of cleanups) {
    try {
      const diagnostic = await cleanup();
      if (diagnostic !== undefined) cleanupDiagnostics.push(diagnostic);
    } catch (cause) {
      cleanupDiagnostics.push(`cleanup threw: ${String(cause)}`);
    }
  }
  return { ...outcome, cleanupDiagnostics };
};

/**
 * Persist the launch record, then dispatch exactly what was recorded. The arguments are copied
 * before anything is awaited, and a record that could not be written means no launch at all.
 */
export const recordThenDispatch = async <T>(
  argv: readonly string[],
  persist: (argv: readonly string[]) => Promise<void>,
  dispatch: (argv: readonly string[]) => Promise<T>,
): Promise<{ ok: true; argv: readonly string[]; dispatched: T } | { ok: false; why: string }> => {
  const snapshot = Object.freeze([...argv]);
  try {
    await persist(snapshot);
  } catch (cause) {
    return {
      ok: false,
      why: `the launch record could not be written; nothing was launched: ${String(cause)}`,
    };
  }
  return { ok: true, argv: snapshot, dispatched: await dispatch(snapshot) };
};

export interface GateTarget {
  readonly runId: string;
  readonly pane: string;
  readonly sessionId: string;
}
/** An operator saw this run's pane and session ready. It says nothing about runtime readiness. */
export interface Confirmation extends GateTarget {
  readonly confirmedAt: number;
}
/** Permission to send one prompt in this run. Separate from confirmation, and used once. */
export interface Authorization {
  readonly runId: string;
}

export type GateResult =
  | { readonly kind: 'refused'; readonly why: string }
  | { readonly kind: 'submitted'; readonly outcome: unknown }
  /** Attempted and failed. The authorization stays used: what reached the agent is unknown. */
  | { readonly kind: 'submission_failed'; readonly why: string };

/**
 * Lets exactly one prompt through, with both records matching this launch. The authorization is
 * consumed synchronously *before* submitting, so concurrent attempts cannot both pass, and a failed
 * or uncertain submission does not give it back: a resend needs a new authorization.
 */
export const promptGate = (given: GateTarget) => {
  // copied now: the caller's object may change later, and this gate belongs to the launch it had
  const target: GateTarget = Object.freeze({
    runId: given.runId,
    pane: given.pane,
    sessionId: given.sessionId,
  });
  let used = false;
  return async (
    confirmation: Confirmation | undefined,
    authorization: Authorization | undefined,
    submit: () => Promise<unknown>,
  ): Promise<GateResult> => {
    if (confirmation === undefined) return { kind: 'refused', why: 'no operator confirmation' };
    if (authorization === undefined) return { kind: 'refused', why: 'no authorization to prompt' };
    for (const field of ['runId', 'pane', 'sessionId'] as const)
      if (confirmation[field] !== target[field])
        return { kind: 'refused', why: `the confirmation is for another ${field}` };
    if (authorization.runId !== target.runId)
      return { kind: 'refused', why: 'the authorization is for another run' };
    if (used) return { kind: 'refused', why: 'this run’s authorization has already been used' };
    used = true;
    try {
      return { kind: 'submitted', outcome: await submit() };
    } catch (cause) {
      return { kind: 'submission_failed', why: String(cause) };
    }
  };
};
