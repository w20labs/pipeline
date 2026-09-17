import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runChild } from './child.js';
import { parseSnapshotStream, type SnapshotEntry } from './snapshot-stream.js';

/**
 * Snapshot a directory tree through `snapshot-tree.py`, and decide whether the snapshot is complete.
 *
 * Two independent verdicts must both hold: the helper terminated successfully — closed, exit 0, no
 * signal, never signalled by us, no output overflow, nothing on stderr — and its stream is
 * protocol-complete. A helper that caught SIGTERM and exited 0 was still asked to stop, so what it
 * wrote is not a finished walk. Whatever stdout was captured is validated either way, so entries that
 * streamed before a failure are kept in an incomplete snapshot.
 *
 * **Trusted root:** protection begins at the root descriptor the helper opens.
 */

/** Located beside this module: `src/` in tests, `dist/` once built. */
export const SNAPSHOT_HELPER = fileURLToPath(new URL('./snapshot-tree.py', import.meta.url));

export interface Snapshot {
  readonly complete: boolean;
  readonly entries: readonly SnapshotEntry[];
  readonly helperDiagnostics: readonly string[];
  /** Termination problems first, then problems found in the stream. */
  readonly problems: readonly string[];
}

export interface SnapshotOptions {
  readonly deadline: number;
  readonly cap: number;
  readonly maxOutputBytes: number;
  readonly maxLineBytes: number;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const refused = (problem: string): Snapshot =>
  Object.freeze({
    complete: false,
    entries: Object.freeze([]),
    helperDiagnostics: Object.freeze([]),
    problems: Object.freeze([problem]),
  });

export const takeSnapshot = async (root: string, options: SnapshotOptions): Promise<Snapshot> => {
  // Read the caller's options once: the stream is checked after the helper finishes, and a caller
  // that changes the object meanwhile must not move the limits the helper was dispatched with.
  const { deadline, cap, maxOutputBytes, maxLineBytes, python, spawn, now } = options;
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0'))
    return refused('the root must be an absolute path without NUL');
  if (!positive(cap) || !positive(maxOutputBytes) || !positive(maxLineBytes))
    return refused('cap, maxOutputBytes and maxLineBytes must be positive safe integers');
  if (!Number.isFinite(deadline)) return refused('the deadline must be finite');

  const outcome = await runChild(
    python ?? 'python3',
    [SNAPSHOT_HELPER, '--root', root, '--cap', String(cap)],
    {
      deadline,
      termGraceMs: 200,
      killGraceMs: 200,
      spawn: spawn ?? nodeSpawn,
      now: now ?? Date.now,
      maxOutputBytes,
    },
  );

  const termination: string[] = [];
  let stdout = '';
  if (outcome.kind === 'not_started' || outcome.kind === 'spawn_failed') {
    termination.push(`the helper did not run: ${outcome.detail}`);
  } else {
    const { evidence } = outcome;
    stdout = evidence.stdout;
    if (outcome.kind !== 'closed') termination.push(`the helper ended ${outcome.kind}`);
    else {
      if (outcome.signal !== null) termination.push(`the helper was killed by ${outcome.signal}`);
      if (outcome.exitCode !== 0) termination.push(`the helper exited ${String(outcome.exitCode)}`);
    }
    if (evidence.signalled.length > 0) termination.push('the helper was signalled to stop');
    if (evidence.outputExceeded === true) termination.push('the helper exceeded maxOutputBytes');
    if (evidence.stderr !== '') termination.push('the helper wrote to stderr');
  }

  const parsed = parseSnapshotStream(stdout, { cap, maxLineBytes });
  return Object.freeze({
    complete: termination.length === 0 && parsed.protocolComplete,
    entries: parsed.entries,
    helperDiagnostics: parsed.helperDiagnostics,
    problems: Object.freeze([...termination, ...parsed.problems]),
  });
};
