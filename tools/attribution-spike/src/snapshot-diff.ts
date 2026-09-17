import type { Snapshot } from './snapshot.js';
import type { EntryKind, SnapshotEntry } from './snapshot-stream.js';

/**
 * Differences between two snapshots of the research configuration directory, by zone.
 *
 * Metadata only, and no cause is assigned: explaining a difference is the report's job. An empty
 * list of rows is not "no change": it says nothing unless both snapshots were complete, and even
 * then a rewrite that keeps every recorded field is invisible.
 */

/** `transcript` is `projects` and everything under it, matched on whole segments. */
export type Zone = 'transcript' | 'configuration';

export const zoneOf = (path: string): Zone =>
  path.split('/')[0] === 'projects' ? 'transcript' : 'configuration';

/** Compared in this order, which is also the order of a path's `changed` rows. */
export const FIELDS = ['kind', 'size', 'mtimeNs', 'dev', 'ino'] as const;
export type Field = (typeof FIELDS)[number];

export type DifferenceRow = { readonly path: string; readonly zone: Zone } & (
  | { readonly type: 'created' | 'deleted' }
  /** On one side only while a snapshot was incomplete: it may simply have gone unobserved. */
  | { readonly type: 'unconfirmed'; readonly seenIn: 'before' | 'after' }
  /** Observed on both sides, so established even if a snapshot was otherwise incomplete. */
  | {
      readonly type: 'changed';
      readonly field: Field;
      readonly before: bigint | EntryKind;
      readonly after: bigint | EntryKind;
    }
);

export interface SnapshotDiff {
  /** Whether both inputs were complete; each row's type says what that row established. */
  readonly bothSnapshotsComplete: boolean;
  readonly rows: readonly DifferenceRow[];
}

const byPath = (snapshot: Snapshot, side: string): Map<string, SnapshotEntry> => {
  const map = new Map<string, SnapshotEntry>();
  for (const entry of snapshot.entries) {
    if (map.has(entry.path)) throw new Error(`the ${side} snapshot records ${entry.path} twice`);
    map.set(entry.path, entry);
  }
  return map;
};

export const diffSnapshots = (before: Snapshot, after: Snapshot): SnapshotDiff => {
  const was = byPath(before, 'before');
  const now = byPath(after, 'after');
  const bothSnapshotsComplete = before.complete && after.complete;
  const rows: DifferenceRow[] = [];
  const paths = [...new Set([...was.keys(), ...now.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const path of paths) {
    const zone = zoneOf(path);
    const old = was.get(path);
    const neu = now.get(path);
    if (old === undefined || neu === undefined) {
      const seenIn = old === undefined ? 'after' : 'before';
      rows.push(
        bothSnapshotsComplete
          ? { path, zone, type: seenIn === 'after' ? 'created' : 'deleted' }
          : { path, zone, type: 'unconfirmed', seenIn },
      );
      continue;
    }
    for (const field of FIELDS)
      if (old[field] !== neu[field])
        rows.push({ path, zone, type: 'changed', field, before: old[field], after: neu[field] });
  }
  return Object.freeze({
    bothSnapshotsComplete,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
};
