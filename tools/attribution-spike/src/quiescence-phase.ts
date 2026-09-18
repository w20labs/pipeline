/**
 * The quiescence phase: a second walk of the research tree, and what it differs from the first.
 *
 * **The claim is narrow.** Completing means no metadata difference was detected between two
 * complete walks — not that the tree stayed at rest. The two walks are consecutive: nothing waits
 * between them, so anything that changed and changed back, or changed between the walks' own
 * traversals, is outside what this can see.
 *
 * Both walks' own bounds and sanitizers are the snapshot phase's, reused rather than restated. What
 * reaches the summary is the root and counts — of difference **rows**, so one file differing in
 * several fields counts once per field — never a path and never the helper's words.
 */
import type { spawn as nodeSpawn } from 'node:child_process';

import type { Phase, PhaseResult } from './runner.js';
import { diffSnapshots, type SnapshotDiff, type Zone } from './snapshot-diff.js';
import {
  counted,
  problemCategory,
  SNAPSHOT_CAP,
  SNAPSHOT_LINE_BYTES,
  SNAPSHOT_OUTPUT_BYTES,
} from './snapshot-phase.js';
import { type Snapshot, takeSnapshot } from './snapshot.js';

export interface QuiescenceDeps {
  readonly take?: typeof takeSnapshot;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

export interface QuiescencePhase {
  readonly phase: Phase;
  /** The second walk exactly as taken, partial entries and all, once it has been taken. */
  readonly taken: () => Snapshot | undefined;
  /** The comparison, when one was made. `undefined` when none was, including after a failure. */
  readonly comparison: () => SnapshotDiff | undefined;
}

type RowType = 'created' | 'deleted' | 'changed' | 'unconfirmed';
interface RowCounts {
  readonly total: number;
  /** Each pair on its own: two zones with mirrored types are not the same finding. */
  readonly zone: Record<Zone, Record<RowType, number>>;
}

const FAILED = 'failed';
const guarded = async (call: () => Promise<Snapshot>): Promise<Snapshot | typeof FAILED> =>
  (async () => call())().catch((): typeof FAILED => FAILED);

/**
 * Rows, counted by what each established **and** where: a path may appear in several of them, and
 * one type in one zone is a different finding from the same type in the other.
 */
const rowCounts = (diff: SnapshotDiff): RowCounts => {
  const empty = (): Record<RowType, number> => ({
    created: 0,
    deleted: 0,
    changed: 0,
    unconfirmed: 0,
  });
  const zone: Record<Zone, Record<RowType, number>> = {
    transcript: empty(),
    configuration: empty(),
  };
  for (const row of diff.rows) zone[row.zone][row.type] += 1;
  return Object.freeze({
    total: diff.rows.length,
    zone: Object.freeze({
      transcript: Object.freeze(zone.transcript),
      configuration: Object.freeze(zone.configuration),
    }),
  });
};

const refused = (why: string, evidence?: unknown): PhaseResult =>
  evidence === undefined ? { kind: 'refused', why } : { kind: 'refused', why, evidence };

/** Everything a walk reported, as fixed categories and counts. */
const walkEvidence = (snapshot: Snapshot) => ({
  problems: [...new Set(snapshot.problems.map(problemCategory))],
  diagnostics: counted(snapshot.helperDiagnostics),
});

/**
 * One comparison per phase object. A second run refuses rather than walking again: the comparison
 * belongs to the first, and replacing it would leave later phases reading a different pair.
 */
export const quiescencePhase = (
  locations: { readonly root: string; readonly baseline: () => Snapshot | undefined },
  deps: QuiescenceDeps = {},
): QuiescencePhase => {
  const root = locations.root;
  const baselineOf = locations.baseline;
  const take = deps.take ?? takeSnapshot;
  const bounds = Object.freeze({
    cap: SNAPSHOT_CAP,
    maxOutputBytes: SNAPSHOT_OUTPUT_BYTES,
    maxLineBytes: SNAPSHOT_LINE_BYTES,
    ...(deps.python === undefined ? {} : { python: deps.python }),
    ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  let second: Snapshot | undefined;
  let compared: SnapshotDiff | undefined;
  let used = false;

  const phase: Phase = {
    name: 'quiescence',
    run: async ({ deadline }) => {
      if (used) return refused('the quiescence phase was already used by this run');
      used = true;
      const before = baselineOf();
      // nothing to compare against: neither of these walks again
      if (before === undefined) return refused('the tree was not compared: no baseline was taken');
      if (!before.complete)
        return refused('the tree was not compared: the baseline walk is incomplete');

      const walked = await guarded(() => take(root, { deadline, ...bounds }));
      if (walked === FAILED) return refused('the second walk could not be taken');
      second = walked; // retained before anything is compared

      let diff: SnapshotDiff;
      try {
        diff = diffSnapshots(before, walked);
      } catch {
        // the comparison established nothing, so none is remembered; the walk itself still is
        return refused('the two walks could not be compared');
      }
      compared = diff;

      const counts = rowCounts(diff);
      const evidence = {
        root,
        before: before.entries.length,
        after: walked.entries.length,
        rows: counts,
        second: walkEvidence(walked),
      };
      if (!walked.complete) return refused('the second walk is incomplete', evidence);
      if (counts.total > 0) return refused('the tree differs between the two walks', evidence);
      return { kind: 'completed', evidence };
    },
  };
  return Object.freeze({ phase, taken: () => second, comparison: () => compared });
};
