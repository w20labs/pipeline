import { describe, expect, it } from 'vitest';

import {
  SNAPSHOT_CAP,
  SNAPSHOT_LINE_BYTES,
  SNAPSHOT_OUTPUT_BYTES,
  snapshotPhase,
} from '../src/snapshot-phase.js';
import type { Snapshot } from '../src/snapshot.js';
import type { SnapshotEntry } from '../src/snapshot-stream.js';
import type { PhaseResult } from '../src/runner.js';

const ROOT = '/cache/research/config';
const DEADLINE = 10_000;
const entry = (path: string): SnapshotEntry => ({
  path,
  kind: 'file',
  size: 1n,
  mtimeNs: 2n,
  dev: 3n,
  ino: 4n,
});
const snapshotOf = (over: Partial<Snapshot> = {}): Snapshot =>
  Object.freeze({
    complete: true,
    entries: Object.freeze([entry('a')]),
    helperDiagnostics: Object.freeze([]),
    problems: Object.freeze([]),
    ...over,
  });
/** The phase driven with a stand-in for the walk, so a test states exactly what it returned. */
const driven = (result: Snapshot | (() => Promise<Snapshot>), root = ROOT) => {
  const asked: { root: string; options: Record<string, unknown> }[] = [];
  const built = snapshotPhase(
    { root },
    {
      take: (async (r: string, options: Record<string, unknown>) => {
        asked.push({ root: r, options });
        return typeof result === 'function' ? await result() : result;
      }) as never,
    },
  );
  return { ...built, asked };
};
const ran = (phase: { run: (c: { runDir: string; deadline: number }) => Promise<PhaseResult> }) =>
  phase.run({ runDir: '/runs/run-1', deadline: DEADLINE });

describe('the baseline snapshot phase', () => {
  it('walks the root under its own bounds, and reports what it found by count', async () => {
    const run = driven(snapshotOf({ entries: [entry('a'), entry('b')] }));
    expect(await ran(run.phase)).toEqual({
      kind: 'completed',
      evidence: { root: ROOT, entries: 2, complete: true, diagnostics: [] },
    });
    expect(run.asked).toEqual([
      {
        root: ROOT,
        options: {
          deadline: DEADLINE,
          cap: SNAPSHOT_CAP,
          maxOutputBytes: SNAPSHOT_OUTPUT_BYTES,
          maxLineBytes: SNAPSHOT_LINE_BYTES,
        },
      },
    ]);
    // three independent bounds: the cap cannot be reached inside the output bound at full length
    expect(SNAPSHOT_CAP * SNAPSHOT_LINE_BYTES).toBeGreaterThan(SNAPSHOT_OUTPUT_BYTES);
  });

  it('hands on the snapshot it took, entries and all, rather than a copy', async () => {
    const taken = snapshotOf({ entries: [entry('a'), entry('b')] });
    const run = driven(taken);
    await ran(run.phase);
    expect(run.taken()).toBe(taken); // the identical frozen object, not a reshaped one
    expect(run.taken()?.entries).toHaveLength(2);
  });

  it('keeps the partial entries of a walk that did not finish', async () => {
    const partial = snapshotOf({
      complete: false,
      entries: [entry('a')],
      problems: ['the helper ended exited', '7: not JSON'],
    });
    const run = driven(partial);
    const result = await ran(run.phase);

    expect(result).toEqual({
      kind: 'refused',
      why: 'the baseline snapshot is incomplete (ended early, not JSON)',
    });
    expect(run.taken()).toBe(partial); // refusing to continue is not refusing to remember
    expect(run.taken()?.entries).toHaveLength(1);
  });

  it('walks once: a second run refuses and leaves the first baseline in place', async () => {
    const first = snapshotOf({ entries: [entry('a')] });
    let answer: Snapshot = first;
    const run = driven(() => Promise.resolve(answer));
    await ran(run.phase);
    answer = snapshotOf({ entries: [entry('b'), entry('c')] });

    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the snapshot phase was already used by this run',
    });
    expect(run.asked).toHaveLength(1); // the second run never walked
    expect(run.taken()).toBe(first);
  });

  it.each([
    ['a problem it does not know', ['7: something new'], 'unrecognized'],
    ['a line that ran too long', ['3: longer than 4096 bytes'], 'line too long'],
    ['a duplicated path', ['4: duplicate path secrets/keys.json'], 'duplicate path'],
    ['a helper that was killed', ['the helper was killed by SIGKILL'], 'killed by SIGKILL'],
    [
      'a helper that never ran',
      ['the helper did not run: spawn /secret/python ENOENT'],
      'did not run',
    ],
  ])('says %s in fixed words only', async (_label, problems, category) => {
    const run = driven(snapshotOf({ complete: false, problems }));
    const result = await ran(run.phase);
    expect(result).toEqual({
      kind: 'refused',
      why: `the baseline snapshot is incomplete (${category})`,
    });
    // whatever the problem carried stays in the snapshot, not in what the run reports
    for (const secret of ['secrets/keys.json', '/secret/python']) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('counts the helper’s diagnostics by kind, repeating none of them', async () => {
    const messages = [
      'projects/a: cannot list: Permission denied',
      'projects/b: cannot list: Permission denied',
      'projects/c: cannot stat: No such file or directory',
      'projects/d: something the helper has not said before',
    ];
    const complete = driven(snapshotOf({ helperDiagnostics: messages }));
    expect(await ran(complete.phase)).toEqual({
      kind: 'completed',
      evidence: {
        root: ROOT,
        entries: 1,
        complete: true,
        diagnostics: [
          { category: 'cannot list', count: 2 },
          { category: 'cannot stat', count: 1 },
          { category: 'unrecognized', count: 1 },
        ],
      },
    });
    // the raw messages are still there for whoever takes the baseline
    expect(complete.taken()?.helperDiagnostics).toEqual(messages);
  });

  it('names the diagnostics beside the problems when the walk did not finish', async () => {
    const run = driven(
      snapshotOf({
        complete: false,
        problems: ['the helper was signalled to stop'],
        helperDiagnostics: ['projects/a: cannot open directory: Permission denied'],
      }),
    );
    expect(await ran(run.phase)).toEqual({
      kind: 'refused',
      why: 'the baseline snapshot is incomplete (signalled to stop); diagnostics: cannot open directory ×1',
    });
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
  ])('contains a walk that %s', async (_label, take) => {
    const built = snapshotPhase({ root: ROOT }, { take: take as never });
    const result = await ran(built.phase);
    expect(result).toEqual({ kind: 'refused', why: 'the baseline snapshot could not be taken' });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(built.taken()).toBeUndefined(); // nothing was established, so nothing is remembered
  });

  // one row per diagnose() call site in snapshot-tree.py: a kind the helper can emit and this
  // module does not name is a gap, and this table is where it shows
  it.each([
    ['projects/a: cannot list: Permission denied', 'cannot list'],
    ['projects/a/f: cannot stat: No such file or directory', 'cannot stat'],
    ['projects/a: cannot open directory: Permission denied', 'cannot open directory'],
    [
      'projects/a: cannot stat the opened directory: Permission denied',
      'cannot stat the opened directory',
    ],
    ['projects/a: changed between stat and open', 'changed between stat and open'],
    ['projects/a: depth_reached: not opened beyond depth 64', 'depth_reached'],
    ['root: close failed: Bad file descriptor', 'close failed'],
    ['cap_reached: stopped after 20000 entries', 'cap_reached'],
    ['cannot open root: Permission denied', 'cannot open root'],
    ['usage: --root <absolute path> --cap <positive integer>', 'usage'],
    ['this Python lacks: os.scandir(fd)', 'this Python lacks'],
    ['the root must be absolute and the cap a positive integer', 'the root must be absolute'],
    // a path containing a reason word is still read by structure, so the real failure is named
    ['projects/cannot list: cannot stat: No such file or directory', 'cannot stat'],
    // a whole bare-form message inside the tail is text, not a second reading
    ['projects/a: cannot stat: cap_reached: stopped after 20000 entries', 'cannot stat'],
  ])('reads %s as its own kind', async (message, category) => {
    const run = driven(snapshotOf({ helperDiagnostics: [message] }));
    expect(await ran(run.phase)).toMatchObject({
      evidence: { diagnostics: [{ category, count: 1 }] },
    });
  });

  it.each([
    // the same kind twice: two readings of one message
    ['projects/a: cannot stat: b: cannot stat: No such file or directory'],
    // a reason word inside a path, with no structure behind it
    ['projects/cannot list/f'],
    // the right words, the wrong shape
    ['projects/a: depth_reached: not opened beyond depth many'],
    // a prefix that is no path the helper could have walked
    ['../a: cannot stat: No such file or directory'],
    // the marker not behind a separator: part of a path, not a reason
    ['projects/a cannot stat: No such file or directory'],
  ])('says unrecognized when %s cannot be read one way', async (message) => {
    const run = driven(snapshotOf({ helperDiagnostics: [message] }));
    expect(await ran(run.phase)).toMatchObject({
      evidence: { diagnostics: [{ category: 'unrecognized', count: 1 }] },
    });
  });
});
