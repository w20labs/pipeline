import { expectedTranscript, type LaunchBinding } from './session.js';
import type { Snapshot } from './snapshot.js';
import { type DifferenceRow, diffSnapshots } from './snapshot-diff.js';
import type { SnapshotEntry } from './snapshot-stream.js';

/**
 * Which differences across a run are consistent with its own expected activity.
 *
 * **Explained is not caused.** An explained row is consistent with the bound launch creating its
 * transcript; it is not proof that this run did it. **Uncontested is not exclusive.** It says no
 * transcript-zone difference was left unexplained; it establishes neither exclusive use nor
 * ownership, which `sessionBoundTranscript` decides separately.
 */

export type Explanation =
  | 'expected transcript created'
  | 'expected ancestor created'
  | 'expected ancestor size or mtime changed';

export type ClassifiedRow =
  | { readonly row: DifferenceRow; readonly status: 'explained'; readonly explanation: Explanation }
  /** Transcript zone, with no cause assigned. */
  | { readonly row: DifferenceRow; readonly status: 'unexplained' }
  /** Configuration zone: recorded without a cause, and never contests the run. */
  | { readonly row: DifferenceRow; readonly status: 'recorded' };

export type Classification =
  | { readonly ok: false; readonly why: string }
  | {
      readonly ok: true;
      /** `inconclusive` unless both snapshots were complete; then `contested` if any row is unexplained. */
      readonly verdict: 'inconclusive' | 'contested' | 'uncontested';
      readonly expectedTranscript: string;
      readonly rows: readonly ClassifiedRow[];
    };

const index = (snapshot: Snapshot) => new Map(snapshot.entries.map((e) => [e.path, e]));

/** Same place, still a directory: only then can its size or mtime change be the expected activity. */
const sameDirectory = (was: SnapshotEntry | undefined, now: SnapshotEntry | undefined): boolean =>
  was?.kind === 'dir' && now?.kind === 'dir' && was.dev === now.dev && was.ino === now.ino;

export const classifyChanges = (
  before: Snapshot,
  after: Snapshot,
  binding: LaunchBinding,
): Classification => {
  const expected = expectedTranscript(binding); // refuses exactly what P1 refuses
  if (!expected.ok) return Object.freeze({ ok: false, why: expected.why });
  const transcript = expected.components.join('/');
  const ancestors = [
    expected.components.slice(0, 1).join('/'),
    expected.components.slice(0, 2).join('/'),
  ];

  const diff = diffSnapshots(before, after); // refuses duplicate paths before they are indexed
  const was = index(before);
  const now = index(after);
  const explain = (row: DifferenceRow): Explanation | undefined => {
    const isAncestor = ancestors.includes(row.path);
    if (row.type === 'created') {
      const kind = now.get(row.path)?.kind;
      if (row.path === transcript && kind === 'file') return 'expected transcript created';
      if (isAncestor && kind === 'dir') return 'expected ancestor created';
    }
    if (
      row.type === 'changed' &&
      isAncestor &&
      (row.field === 'size' || row.field === 'mtimeNs') &&
      sameDirectory(was.get(row.path), now.get(row.path))
    )
      return 'expected ancestor size or mtime changed';
    return undefined;
  };

  const rows = diff.rows.map((row): ClassifiedRow => {
    if (row.zone === 'configuration') return Object.freeze({ row, status: 'recorded' });
    const explanation = explain(row);
    return Object.freeze(
      explanation === undefined
        ? { row, status: 'unexplained' }
        : { row, status: 'explained', explanation },
    );
  });
  const verdict = !diff.bothSnapshotsComplete
    ? 'inconclusive'
    : rows.some((r) => r.status === 'unexplained')
      ? 'contested'
      : 'uncontested';
  return Object.freeze({
    ok: true,
    verdict,
    expectedTranscript: transcript,
    rows: Object.freeze(rows),
  });
};

/**
 * `quiet` means only: no change detected between two complete snapshots. How far apart they were
 * taken is the runner's decision, and a rewrite that keeps every recorded field is invisible.
 */
export type Quiescence =
  | { readonly quiet: true }
  | { readonly quiet: false; readonly why: string; readonly rows: readonly DifferenceRow[] };

export const quiescence = (first: Snapshot, second: Snapshot): Quiescence => {
  const { rows } = diffSnapshots(first, second);
  const incomplete = [first.complete ? [] : ['first'], second.complete ? [] : ['second']].flat();
  if (incomplete.length === 0 && rows.length === 0) return Object.freeze({ quiet: true });
  const why =
    incomplete.length === 2
      ? 'both snapshots are incomplete'
      : incomplete.length === 1
        ? `the ${String(incomplete[0])} snapshot is incomplete`
        : 'the snapshots differ';
  return Object.freeze({ quiet: false, why, rows });
};
