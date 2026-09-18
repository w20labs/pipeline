import { describe, expect, it } from 'vitest';

import { quiescencePhase } from '../src/quiescence-phase.js';
import type { PhaseResult } from '../src/runner.js';
import type { SnapshotEntry } from '../src/snapshot-stream.js';
import type { Snapshot } from '../src/snapshot.js';

const ROOT = '/cache/research/config';
const DEADLINE = 10_000;
const entry = (path: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  path,
  kind: 'file',
  size: 1n,
  mtimeNs: 2n,
  dev: 3n,
  ino: 4n,
  ...over,
});
const snapshotOf = (over: Partial<Snapshot> = {}): Snapshot =>
  Object.freeze({
    complete: true,
    entries: Object.freeze([entry('projects/a.jsonl')]),
    helperDiagnostics: Object.freeze([]),
    problems: Object.freeze([]),
    ...over,
  });
/** The phase driven with a stand-in for the second walk and a baseline the test chooses. */
const driven = (
  baseline: Snapshot | undefined,
  second: Snapshot | (() => Promise<Snapshot>) = snapshotOf(),
) => {
  const asked: Record<string, unknown>[] = [];
  const built = quiescencePhase(
    { root: ROOT, baseline: () => baseline },
    {
      take: (async (_root: string, options: Record<string, unknown>) => {
        asked.push(options);
        return typeof second === 'function' ? await second() : second;
      }) as never,
    },
  );
  return { ...built, asked };
};
const ran = (phase: { run: (c: { runDir: string; deadline: number }) => Promise<PhaseResult> }) =>
  phase.run({ runDir: '/runs/run-1', deadline: DEADLINE });
const empty = { created: 0, deleted: 0, changed: 0, unconfirmed: 0 };
const none = { total: 0, zone: { transcript: empty, configuration: empty } };

describe('the quiescence phase', () => {
  it('completes when two complete walks differ in nothing', async () => {
    const run = driven(snapshotOf(), snapshotOf());
    expect(await ran(run.phase)).toEqual({
      kind: 'completed',
      evidence: {
        root: ROOT,
        before: 1,
        after: 1,
        rows: none,
        second: { problems: [], diagnostics: [] },
      },
    });
    expect(run.comparison()?.rows).toEqual([]);
    expect(run.taken()?.complete).toBe(true);
  });

  it('refuses without walking when there is no baseline to compare against', async () => {
    const run = driven(undefined);
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the tree was not compared: no baseline was taken',
    });
    expect(run.asked).toEqual([]); // nothing was walked a second time
    expect(run.taken()).toBeUndefined();
    expect(run.comparison()).toBeUndefined();
  });

  it('refuses without walking when the baseline itself is incomplete', async () => {
    const run = driven(snapshotOf({ complete: false }));
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the tree was not compared: the baseline walk is incomplete',
    });
    expect(run.asked).toEqual([]);
  });

  it('counts difference rows, not paths, and says where they were', async () => {
    const before = snapshotOf({
      entries: [entry('projects/a.jsonl'), entry('config/settings.json')],
    });
    const after = snapshotOf({
      entries: [
        entry('projects/a.jsonl', { size: 9n, mtimeNs: 11n }), // two fields differ: two rows
        entry('config/new.json'),
      ],
    });
    const run = driven(before, after);
    const result = await ran(run.phase);

    expect(result).toEqual({
      kind: 'refused',
      why: 'the tree differs between the two walks',
      evidence: {
        root: ROOT,
        before: 2,
        after: 2,
        rows: {
          total: 4,
          zone: {
            // one file differing in two fields is two rows, and they are the transcript's
            transcript: { created: 0, deleted: 0, changed: 2, unconfirmed: 0 },
            configuration: { created: 1, deleted: 1, changed: 0, unconfirmed: 0 },
          },
        },
        second: { problems: [], diagnostics: [] },
      },
    });
    // the rows themselves, paths and all, stay in the comparison the phase kept
    expect(run.comparison()?.rows.map((r) => r.path)).toEqual([
      'config/new.json',
      'config/settings.json',
      'projects/a.jsonl',
      'projects/a.jsonl',
    ]);
    expect(JSON.stringify(result)).not.toContain('settings.json');
  });

  it('refuses an incomplete second walk, keeping both it and what could be compared', async () => {
    const partial = snapshotOf({
      complete: false,
      entries: [entry('projects/a.jsonl'), entry('projects/b.jsonl')],
      problems: ['the helper ended exited'],
      helperDiagnostics: ['projects/c: cannot list: Permission denied'],
    });
    const run = driven(snapshotOf(), partial);
    const result = await ran(run.phase);

    expect(result).toEqual({
      kind: 'refused',
      why: 'the second walk is incomplete',
      evidence: {
        root: ROOT,
        before: 1,
        after: 2,
        rows: {
          total: 1,
          zone: {
            transcript: { created: 0, deleted: 0, changed: 0, unconfirmed: 1 },
            configuration: empty,
          },
        },
        second: {
          problems: ['ended early'],
          diagnostics: [{ category: 'cannot list', count: 1 }],
        },
      },
    });
    // one-sided rows of an incomplete pair say only that they were unconfirmed
    expect(run.comparison()?.bothSnapshotsComplete).toBe(false);
    expect(run.taken()).toBe(partial);
    expect(JSON.stringify(result)).not.toContain('Permission denied');
  });

  it('keeps the second walk when the comparison itself fails, and remembers no comparison', async () => {
    const doubled = snapshotOf({ entries: [entry('projects/a.jsonl'), entry('projects/a.jsonl')] });
    const run = driven(snapshotOf(), doubled); // a duplicate path makes diffSnapshots throw
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the two walks could not be compared',
    });
    expect(run.taken()).toBe(doubled); // retained before the comparison was attempted
    expect(run.comparison()).toBeUndefined();
  });

  it.each([
    [
      'throws where it is called',
      () => {
        throw new Error('walk /secret/root SENTINEL');
      },
    ],
    [
      'rejects later',
      async () => {
        throw new Error('walk /secret/root SENTINEL');
      },
    ],
  ])('contains a second walk that %s', async (_label, take) => {
    const built = quiescencePhase(
      { root: ROOT, baseline: () => snapshotOf() },
      { take: take as never },
    );
    const result = await ran(built.phase);
    expect(result).toEqual({ kind: 'refused', why: 'the second walk could not be taken' });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(built.taken()).toBeUndefined();
    expect(built.comparison()).toBeUndefined();
  });

  it('compares once: a second run refuses and leaves the first comparison in place', async () => {
    const run = driven(snapshotOf(), snapshotOf());
    await ran(run.phase);
    const first = run.comparison();

    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the quiescence phase was already used by this run',
    });
    expect(run.asked).toHaveLength(1);
    expect(run.comparison()).toBe(first);
  });

  it('walks under the bounds the snapshot phase owns', async () => {
    const run = driven(snapshotOf(), snapshotOf());
    await ran(run.phase);
    expect(run.asked).toEqual([
      { deadline: DEADLINE, cap: 20_000, maxOutputBytes: 8 * 1024 * 1024, maxLineBytes: 4_096 },
    ]);
  });

  it('tells a transcript creation with a configuration deletion from its mirror', async () => {
    const paired = async (created: string, deleted: string) => {
      const run = driven(
        snapshotOf({ entries: [entry(deleted)] }),
        snapshotOf({ entries: [entry(created)] }),
      );
      const result = await ran(run.phase);
      return (result as { evidence: { rows: unknown } }).evidence.rows;
    };
    const oneWay = await paired('projects/a.jsonl', 'config/settings.json');
    const mirrored = await paired('config/settings.json', 'projects/a.jsonl');

    expect(oneWay).toEqual({
      total: 2,
      zone: {
        transcript: { created: 1, deleted: 0, changed: 0, unconfirmed: 0 },
        configuration: { created: 0, deleted: 1, changed: 0, unconfirmed: 0 },
      },
    });
    expect(mirrored).toEqual({
      total: 2,
      zone: {
        transcript: { created: 0, deleted: 1, changed: 0, unconfirmed: 0 },
        configuration: { created: 1, deleted: 0, changed: 0, unconfirmed: 0 },
      },
    });
    expect(oneWay).not.toEqual(mirrored); // the same totals, a different finding
  });
});
