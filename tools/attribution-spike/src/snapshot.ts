import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runChild } from './child.js';
import { helperTermination } from './helper-termination.js';
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

  const { problems: termination, stdout } = helperTermination(outcome);

  const parsed = parseSnapshotStream(stdout, { cap, maxLineBytes });
  return Object.freeze({
    complete: termination.length === 0 && parsed.protocolComplete,
    entries: parsed.entries,
    helperDiagnostics: parsed.helperDiagnostics,
    problems: Object.freeze([...termination, ...parsed.problems]),
  });
};
