import { describe, expect, it } from 'vitest';

import { classifyChanges, quiescence } from '../src/isolation.js';
import { type LaunchBinding, sessionBoundTranscript } from '../src/session.js';
import type { Snapshot } from '../src/snapshot.js';
import type { SnapshotEntry } from '../src/snapshot-stream.js';

const U = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
const SLUG = 'projects/-work-app';
const T = `${SLUG}/${U}.jsonl`;
const binding = (over: Partial<LaunchBinding> = {}): LaunchBinding => ({
  sessionId: U,
  configRoot: '/cfg',
  scratch: '/work/app',
  argv: ['claude', '--session-id', U],
  ...over,
});
const at = (path: string, kind: SnapshotEntry['kind'], over: Partial<SnapshotEntry> = {}) =>
  Object.freeze({ path, kind, size: 64n, mtimeNs: 10n, dev: 1n, ino: 100n, ...over });
const snap = (entries: SnapshotEntry[], complete = true): Snapshot =>
  Object.freeze({ complete, entries, helperDiagnostics: [], problems: complete ? [] : ['x'] });
const BASE = [at('projects', 'dir', { ino: 1n }), at(SLUG, 'dir', { ino: 2n })];
/** The ancestors as a real transcript creation leaves them: same directories, grown and touched. */
const GROWN = [
  at('projects', 'dir', { ino: 1n }),
  at(SLUG, 'dir', { ino: 2n, size: 96n, mtimeNs: 11n }),
];

/** [path, status, explanation?] for each row, in the diff's order. */
const summary = (before: Snapshot, after: Snapshot, b = binding()) => {
  const c = classifyChanges(before, after, b);
  if (!c.ok) throw new Error(c.why);
  return {
    verdict: c.verdict,
    rows: c.rows.map((r) => [
      r.row.path,
      r.row.type === 'changed' ? r.row.field : r.row.type,
      r.status,
      ...(r.status === 'explained' ? [r.explanation] : []),
    ]),
  };
};

describe('classifying changes across a run', () => {
  it('explains the transcript and both ancestors being created', () => {
    const after = snap([...BASE, at(T, 'file')]);
    expect(summary(snap([]), after)).toEqual({
      verdict: 'uncontested',
      rows: [
        ['projects', 'created', 'explained', 'expected ancestor created'],
        [SLUG, 'created', 'explained', 'expected ancestor created'],
        [T, 'created', 'explained', 'expected transcript created'],
      ],
    });
    const c = classifyChanges(snap([]), after, binding());
    expect(c).toMatchObject({ ok: true, expectedTranscript: T });
    expect(
      Object.isFrozen(c) && c.ok && Object.isFrozen(c.rows) && Object.isFrozen(c.rows[0]),
    ).toBe(true);
  });

  it('explains size and mtime changes of ancestors that stayed the same directories', () => {
    expect(summary(snap(BASE), snap([...GROWN, at(T, 'file')]))).toEqual({
      verdict: 'uncontested',
      rows: [
        [SLUG, 'size', 'explained', 'expected ancestor size or mtime changed'],
        [SLUG, 'mtimeNs', 'explained', 'expected ancestor size or mtime changed'],
        [T, 'created', 'explained', 'expected transcript created'],
      ],
    });
  });

  const GROWS = { size: 96n, mtimeNs: 11n };
  it.each([
    ['projects', {}, { ino: 9n }, ['ino']],
    [SLUG, {}, { dev: 9n }, ['dev']],
    [SLUG, {}, { kind: 'symlink' }, ['kind']],
    // replaced, and the replacement also differs in size and mtime: none of it is explained
    [SLUG, {}, { ino: 9n, ...GROWS }, ['size', 'mtimeNs', 'ino']],
    [SLUG, {}, { dev: 9n, ...GROWS }, ['size', 'mtimeNs', 'dev']],
    [SLUG, {}, { kind: 'symlink', ...GROWS }, ['kind', 'size', 'mtimeNs']],
    [SLUG, { kind: 'symlink' }, { kind: 'dir', ...GROWS }, ['kind', 'size', 'mtimeNs']],
  ] as const)(
    'explains nothing about ancestor %s changing from %o to %o',
    (path, was, now, fields) => {
      const replace = (over: Partial<SnapshotEntry>) =>
        BASE.map((e) => (e.path === path ? at(path, 'dir', { ...e, ...over }) : e));
      expect(summary(snap(replace(was)), snap(replace(now)))).toEqual({
        verdict: 'contested',
        rows: fields.map((field) => [path, field, 'unexplained']),
      });
    },
  );

  it.each([
    ['an ancestor created as a file', [at('projects', 'file'), at(SLUG, 'dir')], 'projects'],
    ['an ancestor created as a symlink', [at('projects', 'dir'), at(SLUG, 'symlink')], SLUG],
    ['the transcript created as a directory', [...BASE, at(T, 'dir')], T],
    ['the transcript created as a symlink', [...BASE, at(T, 'symlink')], T],
  ])('explains nothing about %s', (_label, after, path) => {
    const s = summary(snap([]), snap(after));
    expect(s.verdict).toBe('contested');
    expect(s.rows.filter((r) => r[2] === 'unexplained')).toEqual([
      [path, 'created', 'unexplained'],
    ]);
  });

  it.each([
    ['another project’s directory touched', 'projects/-other', 'mtimeNs'],
    ['a directory below the expected one touched', `${SLUG}/sub`, 'mtimeNs'],
    ['a pre-existing transcript grown', `${SLUG}/other.jsonl`, 'size'],
    ['a pre-existing file at the expected path grown', T, 'size'],
  ])('leaves %s unexplained', (_label, path, field) => {
    const was = at(path, path.endsWith('.jsonl') ? 'file' : 'dir', { ino: 50n });
    const now = { ...was, [field]: 99n };
    expect(summary(snap([...BASE, was]), snap([...BASE, now]))).toEqual({
      verdict: 'contested',
      rows: [[path, field, 'unexplained']],
    });
  });

  it.each([
    ['another transcript beside it', `${SLUG}/0e6a1b2c-0000-4000-8000-000000000000.jsonl`],
    ['the expected transcript under another slug', `projects/-work-other/${U}.jsonl`],
    ['a sub-agent transcript under it', `${SLUG}/${U}/subagents/agent-1.jsonl`],
  ])('contests %s while still explaining the transcript', (_label, path) => {
    const s = summary(snap(GROWN), snap([...GROWN, at(T, 'file'), at(path, 'file')]));
    expect(s.verdict).toBe('contested');
    expect(s.rows).toContainEqual([T, 'created', 'explained', 'expected transcript created']);
    expect(s.rows).toContainEqual([path, 'created', 'unexplained']);
  });

  it('records configuration-zone changes without a cause, and they contest nothing', () => {
    const before = snap([...BASE, at('settings.json', 'file'), at('projects-old', 'dir')]);
    const after = snap([
      ...BASE,
      at('settings.json', 'file', { size: 1n }),
      at('cache', 'dir'),
      at(T, 'file'),
    ]);
    expect(summary(before, after)).toEqual({
      verdict: 'uncontested',
      rows: [
        ['cache', 'created', 'recorded'],
        ['projects-old', 'deleted', 'recorded'],
        [T, 'created', 'explained', 'expected transcript created'],
        ['settings.json', 'size', 'recorded'],
      ],
    });
  });

  it.each([
    ['before', false, true],
    ['after', true, false],
  ])('is inconclusive when the %s snapshot is incomplete, even with no rows', (_side, b, a) => {
    expect(summary(snap(BASE, b), snap(BASE, a))).toEqual({ verdict: 'inconclusive', rows: [] });
    // an unconfirmed transcript is not an observed creation, so it is never explained
    expect(summary(snap(BASE, b), snap([...BASE, at(T, 'file')], a)).rows).toEqual([
      [T, 'unconfirmed', 'unexplained'],
    ]);
  });

  it.each([
    ['a session id that is not a UUID', { sessionId: 'U' }],
    ['a relative working directory', { scratch: 'work/app' }],
    ['a relative configuration root', { configRoot: 'cfg' }],
    [
      'a launch bound to another session id',
      { argv: ['claude', '--session-id', `${U.slice(0, -1)}e`] },
    ],
    ['a launch with the flag twice', { argv: ['claude', '--session-id', U, '--session-id', U] }],
  ])('refuses %s exactly as ownership does', async (_label, over) => {
    const b = binding(over);
    const unread = () => Promise.reject(new Error('a refused binding must not be read'));
    const ownership = await sessionBoundTranscript(b, new Set(), unread);
    expect(ownership.owned).toBe(false);
    expect(classifyChanges(snap([]), snap([at(T, 'file')]), b)).toEqual({
      ok: false,
      why: (ownership as { why: string }).why,
    });
  });
});

describe('quiescence before launch', () => {
  const settings = at('settings.json', 'file');
  it('is quiet only when two complete snapshots show no change', () => {
    expect(quiescence(snap([settings]), snap([settings]))).toEqual({ quiet: true });
  });

  it.each([
    ['the snapshots differ', [settings], [], true, true],
    ['the first snapshot is incomplete', [settings], [settings], false, true],
    ['the second snapshot is incomplete', [settings], [settings], true, false],
    ['both snapshots are incomplete', [settings], [settings], false, false],
  ])('is not quiet when %s', (why, first, second, a, b) => {
    const q = quiescence(snap(first, a), snap(second, b));
    expect(q).toEqual({
      quiet: false,
      why,
      rows:
        second.length === 0
          ? [{ path: 'settings.json', zone: 'configuration', type: 'deleted' }]
          : [],
    });
    expect(Object.isFrozen(q)).toBe(true);
  });
});
