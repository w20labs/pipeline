import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../src/snapshot.js';
import { diffSnapshots, zoneOf } from '../src/snapshot-diff.js';
import type { SnapshotEntry } from '../src/snapshot-stream.js';

const file = (path: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry =>
  Object.freeze({ path, kind: 'file', size: 3n, mtimeNs: 10n, dev: 1n, ino: 7n, ...over });
const snap = (entries: SnapshotEntry[], complete = true): Snapshot =>
  Object.freeze({
    complete,
    entries: Object.freeze(entries),
    helperDiagnostics: Object.freeze([]),
    problems: Object.freeze(complete ? [] : ['the stream has no done']),
  });

describe('snapshot differences', () => {
  it.each([true, false])(
    'finds no rows between identical snapshots, and says whether both were complete (%s)',
    (complete) => {
      const entries = [file('settings.json'), file('projects/s/a.jsonl')];
      // an empty diff of incomplete snapshots must not read as a complete, quiet observation
      expect(diffSnapshots(snap(entries, complete), snap(entries, complete))).toEqual({
        bothSnapshotsComplete: complete,
        rows: [],
      });
    },
  );

  it('establishes creations and deletions, in both zones, when both snapshots are complete', () => {
    const before = snap([file('old.json'), file('projects/s/gone.jsonl'), file('kept')]);
    const after = snap([file('kept'), file('new.json'), file('projects/s/U.jsonl')]);
    expect(diffSnapshots(before, after)).toEqual({
      bothSnapshotsComplete: true,
      rows: [
        { path: 'new.json', zone: 'configuration', type: 'created' },
        { path: 'old.json', zone: 'configuration', type: 'deleted' },
        { path: 'projects/s/U.jsonl', zone: 'transcript', type: 'created' },
        { path: 'projects/s/gone.jsonl', zone: 'transcript', type: 'deleted' },
      ],
    });
  });

  it.each([
    ['kind', { kind: 'symlink' }, 'file', 'symlink'],
    ['size', { size: 4n }, 3n, 4n],
    ['mtimeNs', { mtimeNs: 2n ** 60n + 1n }, 10n, 2n ** 60n + 1n], // beyond 2^53, kept exact
    ['dev', { dev: 2n }, 1n, 2n],
    ['ino', { ino: 8n }, 7n, 8n],
  ] as const)('records a changed %s as exactly one row', (field, over, was, now) => {
    const d = diffSnapshots(snap([file('f')]), snap([file('f', over)]));
    expect(d.rows).toEqual([
      { path: 'f', zone: 'configuration', type: 'changed', field, before: was, after: now },
    ]);
  });

  it('records a replacement differing in every field as one row per field, in field order', () => {
    const d = diffSnapshots(
      snap([file('projects/x')]),
      snap([file('projects/x', { kind: 'dir', size: 96n, mtimeNs: 11n, dev: 2n, ino: 9n })]),
    );
    expect(d.rows.map((r) => (r.type === 'changed' ? [r.field, r.before, r.after] : r))).toEqual([
      ['kind', 'file', 'dir'],
      ['size', 3n, 96n],
      ['mtimeNs', 10n, 11n],
      ['dev', 1n, 2n],
      ['ino', 7n, 9n],
    ]);
    expect(d.rows.every((r) => r.path === 'projects/x' && r.zone === 'transcript')).toBe(true);
  });

  it.each([
    ['the before snapshot', false, true],
    ['the after snapshot', true, false],
    ['both snapshots', false, false],
  ])('never establishes a creation or deletion when %s is incomplete', (_label, b, a) => {
    const before = snap([file('only-before'), file('both')], b);
    const after = snap([file('both', { size: 5n }), file('projects/only-after')], a);
    expect(diffSnapshots(before, after)).toEqual({
      bothSnapshotsComplete: false,
      rows: [
        // seen on both sides, so the change stands; each one-sided entry may just have gone unseen
        {
          path: 'both',
          zone: 'configuration',
          type: 'changed',
          field: 'size',
          before: 3n,
          after: 5n,
        },
        { path: 'only-before', zone: 'configuration', type: 'unconfirmed', seenIn: 'before' },
        { path: 'projects/only-after', zone: 'transcript', type: 'unconfirmed', seenIn: 'after' },
      ],
    });
  });

  it.each([
    ['projects', 'transcript'],
    ['projects/s/U.jsonl', 'transcript'],
    ['projects-old/a', 'configuration'],
    ['project', 'configuration'],
    ['projectsX/a', 'configuration'],
    ['a/projects/b', 'configuration'],
    ['settings.json', 'configuration'],
  ])('puts %s in the %s zone', (path, zone) => {
    expect(zoneOf(path)).toBe(zone);
  });

  it('orders rows by code unit whatever the input order, and freezes the result', () => {
    const paths = ['b', 'B', 'a/b', 'a', 'é', 'a-b'];
    const d = diffSnapshots(snap([]), snap(paths.map((p) => file(p))));
    expect(d.rows.map((r) => r.path)).toEqual(['B', 'a', 'a-b', 'a/b', 'b', 'é']);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.rows)).toBe(true);
    expect(d.rows.every((r) => Object.isFrozen(r))).toBe(true);
  });

  it.each([
    ['before', [file('f'), file('f', { size: 9n })], [file('f')]],
    ['after', [file('f')], [file('f'), file('f', { size: 9n })]],
  ])('refuses a %s snapshot that records a path twice', (side, b, a) => {
    expect(() => diffSnapshots(snap(b), snap(a))).toThrow(
      new Error(`the ${side} snapshot records f twice`),
    );
  });

  it('leaves its inputs as they were, even when they are not frozen', () => {
    const loose = (entries: SnapshotEntry[]): Snapshot => ({
      complete: true,
      entries: entries.map((e) => ({ ...e })),
      helperDiagnostics: [],
      problems: [],
    });
    const before = loose([file('b'), file('a')]);
    const after = loose([file('b', { size: 1n }), file('c')]);
    const copies = [structuredClone(before), structuredClone(after)];
    diffSnapshots(before, after);
    expect([before, after]).toEqual(copies);
    expect(before.entries.map((e) => e.path)).toEqual(['b', 'a']); // not sorted in place
  });
});
