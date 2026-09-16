import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/**
 * Running one CLI child to a confirmed end, inside a single absolute deadline.
 *
 * `within()` only stops *waiting*. This is the other half: a child that outlives its budget is asked
 * to stop, then made to, and the run waits to see it actually went — a signal sent is not a process
 * gone. One deadline covers every phase: SIGTERM's and SIGKILL's graces are carved out of it up
 * front, so nothing here runs past the deadline it was given.
 *
 * **Exit and close are different facts.** `exit` says the tracked process ended; `close` says its
 * output streams did. A descendant can inherit stdout and hold it open long after its parent exits,
 * so a missing `close` is evidence of incomplete capture, not of a live child — and signalling a pid
 * that has already exited risks hitting a process that reused it.
 */

export interface Signalled {
  readonly signal: 'SIGTERM' | 'SIGKILL';
  readonly at: number;
  /** Whether `kill()` reported delivering it. Delivery is still not an exit. */
  readonly delivered: boolean;
}

/** Everything a child left behind, never classified. */
export interface Evidence {
  readonly stdout: string;
  readonly stderr: string;
  readonly signalled: readonly Signalled[];
}

interface Ended {
  readonly at: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type ChildOutcome =
  /** The deadline had already passed. Nothing was spawned. */
  | { readonly kind: 'not_started'; readonly detail: string }
  /** It never ran: a synchronous throw from `spawn`, or an asynchronous error before it started. */
  | { readonly kind: 'spawn_failed'; readonly detail: string; readonly evidence: Evidence }
  /** It ended and its streams closed, so the output is complete. */
  | {
      readonly kind: 'closed';
      readonly closedAt: number;
      /** When `exit` arrived, if it did; a descendant holding a stream puts this well before close. */
      readonly exitedAt?: number;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly evidence: Evidence;
    }
  /**
   * The tracked process exited, but its streams were still open at the deadline — something it left
   * behind is holding them. Termination is confirmed; the output is not complete.
   */
  | {
      readonly kind: 'exited';
      readonly exitedAt: number;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly outputComplete: false;
      readonly evidence: Evidence;
    }
  /** No exit was observed by the deadline, after everything was tried. Never assumed gone. */
  | { readonly kind: 'unterminated'; readonly at: number; readonly evidence: Evidence };

export interface ChildOptions {
  /** Absolute epoch milliseconds. Covers waiting, both escalations, and the final wait. */
  readonly deadline: number;
  /** How long SIGTERM is given before SIGKILL. */
  readonly termGraceMs: number;
  /** How long SIGKILL is given before the child is reported unterminated. */
  readonly killGraceMs: number;
  readonly spawn: typeof nodeSpawn;
  readonly now: () => number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export const runChild = async (
  command: string,
  args: readonly string[],
  options: ChildOptions,
): Promise<ChildOutcome> => {
  const { deadline, now } = options;
  if (deadline - now() <= 0)
    return { kind: 'not_started', detail: 'the deadline had already passed; nothing was spawned' };

  // One streaming decoder per stream: a multi-byte character split across two chunks is only whole
  // once both halves have been seen, and the two streams interleave independently.
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const text = { stdout: '', stderr: '' };
  const signalled: Signalled[] = [];
  const evidence = (): Evidence => ({ ...text, signalled: [...signalled] });

  let child: ChildProcess;
  try {
    child = options.spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (cause) {
    // Returned, not thrown, so no caller's cleanup is ever bypassed by a synchronous spawn failure.
    return { kind: 'spawn_failed', detail: (cause as Error).message, evidence: evidence() };
  }

  // Everything below is attached before anything is awaited, and every fact is recorded inside its
  // own callback — so a child that ends in the very next tick is seen, at the instant it ended.
  let started = false;
  let failure: string | undefined;
  let exited: Ended | undefined;
  let closed: Ended | undefined;
  const waiters = new Set<() => void>();
  const wake = (): void => [...waiters].forEach((check) => check());

  const capture = {
    stdout: (chunk: Buffer) => (text.stdout += decoders.stdout.write(chunk)),
    stderr: (chunk: Buffer) => (text.stderr += decoders.stderr.write(chunk)),
  };
  for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', capture[stream]);

  /**
   * Give up capture: detach and destroy the pipe ends this helper owns.
   *
   * An open pipe keeps the caller's event loop alive, so without this a descendant holding stdout
   * would hold the *caller* hostage long after the outcome was returned. What was captured stays in
   * the outcome as it stood; destroying a stream is not a close, and none is recorded for it.
   */
  const release = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.off('data', capture[stream]);
      child[stream]?.destroy();
    }
    child.removeListener('close', onClose);
    child.unref();
  };
  child.once('spawn', () => (started = true));
  child.once('error', (error: Error) => {
    if (started) return;
    failure = error.message;
    wake();
  });
  child.once('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
    exited = { at: now(), exitCode, signal };
    wake();
  });
  function onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    text.stdout += decoders.stdout.end();
    text.stderr += decoders.stderr.end();
    closed = { at: now(), exitCode, signal };
    wake();
  }
  child.once('close', onClose);

  /**
   * Wait until `done` holds or `at` arrives. A phase whose time is already spent answers at once and
   * installs nothing: a zero-delay timer is clamped to a millisecond, and each one would carry the
   * next phase past the deadline.
   */
  const waitUntil = (at: number, done: () => boolean): Promise<boolean> =>
    new Promise((resolve) => {
      if (done()) return resolve(true);
      if (at - now() <= 0) return resolve(false);
      const check = (): void => {
        if (!done()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        resolve(done());
      }, at - now());
      waiters.add(check);
    });

  const gone = (): boolean => failure !== undefined || exited !== undefined || closed !== undefined;

  /** The process has ended. Keep waiting for its output to be complete, but never past the deadline. */
  const settle = async (): Promise<ChildOutcome> => {
    if (failure !== undefined)
      return { kind: 'spawn_failed', detail: failure, evidence: evidence() };
    await waitUntil(deadline, () => closed !== undefined);
    if (closed !== undefined)
      return {
        kind: 'closed',
        closedAt: closed.at,
        ...(exited === undefined ? {} : { exitedAt: exited.at }),
        exitCode: closed.exitCode,
        signal: closed.signal,
        evidence: evidence(),
      };
    const ended = exited as Ended;
    const partial = evidence();
    release();
    return {
      kind: 'exited',
      exitedAt: ended.at,
      exitCode: ended.exitCode,
      signal: ended.signal,
      outputComplete: false,
      evidence: partial,
    };
  };

  const send = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    const deliver = (): boolean => {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    };
    signalled.push({ signal, at: now(), delivered: deliver() });
  };

  // Each phase rechecks the child's state after its wait resumes, immediately before signalling: a
  // wait that answered "not yet" can be stale by the time the await returns, and a signal to a child
  // that has already ended would reach whatever reused its pid.
  await waitUntil(deadline - options.termGraceMs - options.killGraceMs, gone);
  if (gone()) return settle();
  send('SIGTERM');
  await waitUntil(deadline - options.killGraceMs, gone);
  if (gone()) return settle();
  send('SIGKILL');
  await waitUntil(deadline, gone);
  if (gone()) return settle();
  const partial = evidence();
  release();
  return { kind: 'unterminated', at: now(), evidence: partial };
};
