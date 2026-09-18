/**
 * The baseline snapshot phase: one bounded walk of the research tree, kept whole for later phases.
 *
 * **A baseline is not quiescence.** One walk establishes a starting point and nothing more; deciding
 * that a tree is at rest needs two complete pre-launch snapshots and their comparison, which is not
 * this phase's work.
 *
 * The snapshot itself — entries included, and the partial entries of an incomplete walk — is kept
 * privately and handed on through `taken()`. It never reaches a `PhaseResult`, so the runner cannot
 * serialize a tree into `run.json`. That bounds what this module writes, not what a caller may do:
 * a phase handed the snapshot later can serialize it wherever it likes, and nothing here prevents
 * that.
 *
 * What does reach the summary is counted and fixed: the helper's diagnostics carry paths under the
 * research tree and the operating system's own words (`snapshot-tree.py`), so they are categorized
 * and counted here, never repeated.
 */
import type { spawn as nodeSpawn } from 'node:child_process';

import type { Phase, PhaseResult } from './runner.js';
import { type Snapshot, takeSnapshot } from './snapshot.js';

/**
 * Three independent bounds. They are not derived from one another: 20,000 records of the maximum
 * line length would be about 78 MiB, far past the output bound, and a tree of ordinary paths reaches
 * the cap long before either byte bound. Whichever binds first ends the walk, and an ended walk is
 * reported incomplete — never silently truncated.
 */
export const SNAPSHOT_CAP = 20_000;
/** One record: a path and its fixed numeric fields. */
export const SNAPSHOT_LINE_BYTES = 4_096;
/** Total captured output, which ordinary trees stay well inside. */
export const SNAPSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SnapshotDeps {
  readonly take?: typeof takeSnapshot;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

export interface SnapshotPhase {
  readonly phase: Phase;
  /** The snapshot exactly as taken, partial entries and all, or `undefined` before the walk. */
  readonly taken: () => Snapshot | undefined;
}

/** A call that failed, by throwing where it was called or rejecting later. Its words are not kept. */
const FAILED = 'failed';
const guarded = async (call: () => Promise<Snapshot>): Promise<Snapshot | typeof FAILED> =>
  (async () => call())().catch((): typeof FAILED => FAILED);

/** Fixed wording from the helper's termination, mapped as elsewhere in this spike. */
const TERMINATION: Record<string, string> = {
  'the helper ended exited': 'ended early',
  'the helper ended unterminated': 'ended early',
  'the helper was signalled to stop': 'signalled to stop',
  'the helper exceeded maxOutputBytes': 'exceeded its output bound',
  'the helper wrote to stderr': 'wrote to stderr',
};
const KILLED = /^the helper was killed by (SIG[A-Z0-9]+)$/;
const EXITED = /^the helper exited (-?\d+|null)$/;
/** Stream problems, after their line number and any path are dropped. */
const STREAM = new Set([
  'a record after done',
  'not JSON',
  'not an object',
  'entry fields',
  'entry path',
  'entry kind',
  'entry numbers',
  'more entries than the cap',
  'diagnostic fields',
  'unknown record type',
  'the stream limits must be positive safe integers',
  'the stream ends with a partial line',
  'the stream has no done',
  'done fields',
  'done.entries does not match the entries sent',
  'done.diagnostics does not match the diagnostics sent',
  'done claims complete while reporting diagnostics',
]);

/** One fixed token per problem. Anything unrecognized says exactly that and nothing more. */
export const problemCategory = (problem: string): string => {
  if (problem.startsWith('the helper did not run: ')) return 'did not run';
  if (Object.hasOwn(TERMINATION, problem)) return TERMINATION[problem] as string;
  const killed = KILLED.exec(problem);
  if (killed !== null) return `killed by ${String(killed[1])}`;
  const exited = EXITED.exec(problem);
  if (exited !== null) return `exited ${String(exited[1])}`;
  // stream problems are prefixed by their line number; a few carry a path as well
  const rest = /^\d+: (.*)$/.exec(problem)?.[1] ?? problem;
  if (rest.startsWith('longer than ')) return 'line too long';
  if (rest.startsWith('duplicate path ')) return 'duplicate path';
  return STREAM.has(rest) ? rest : 'unrecognized';
};

/**
 * The helper's own diagnostics carry paths and the system's words (`snapshot-tree.py`), so only
 * their kind is kept. A kind is read from the message's structure, never from a substring: a path
 * may contain anything, including text that reads like a reason. Every interpretation that fits the
 * protocol is counted — repeats of one kind included — and only a single fitting interpretation
 * names a category. Anything else is `unrecognized`, which says less but never says something false.
 */
interface Form {
  readonly marker: string;
  readonly tail: RegExp;
}
/** Emitted as `<path>: <marker><tail>`. */
const PATH_FORMS: readonly Form[] = [
  { marker: 'cannot list', tail: /^: .+$/s },
  { marker: 'cannot stat the opened directory', tail: /^: .+$/s },
  { marker: 'cannot stat', tail: /^: .+$/s },
  { marker: 'cannot open directory', tail: /^: .+$/s },
  { marker: 'close failed', tail: /^: .+$/s },
  { marker: 'depth_reached', tail: /^: not opened beyond depth \d+$/ },
  { marker: 'changed between stat and open', tail: /^$/ },
];
/** Emitted with no path in front, by the walk's own top level. */
const BARE_FORMS: readonly Form[] = [
  { marker: 'cap_reached', tail: /^: stopped after \d+ entries$/ },
  { marker: 'cannot open root', tail: /^: .+$/s },
  { marker: 'usage', tail: /^: .+$/s },
  { marker: 'this Python lacks', tail: /^: .+$/s },
  { marker: 'the root must be absolute', tail: /^ and the cap a positive integer$/ },
];

/** What the helper may put in front of a reason: the root itself, or a relative path it walked. */
const pathLike = (text: string): boolean =>
  text === '.' ||
  (text.length > 0 &&
    !text.includes('\0') &&
    text.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));

/** Every reading of the message that the protocol allows, including repeats of one kind. */
const interpretations = (message: string): string[] => {
  const found: string[] = [];
  for (const { marker, tail } of BARE_FORMS)
    if (message.startsWith(marker) && tail.test(message.slice(marker.length))) found.push(marker);
  for (const { marker, tail } of PATH_FORMS) {
    const separated = `: ${marker}`;
    for (let at = message.indexOf(separated); at !== -1; at = message.indexOf(separated, at + 1))
      if (pathLike(message.slice(0, at)) && tail.test(message.slice(at + separated.length)))
        found.push(marker);
  }
  return found;
};

export const diagnosticCategory = (message: string): string => {
  const found = interpretations(message);
  return found.length === 1 ? (found[0] as string) : 'unrecognized';
};

/** Categories with their counts, in a fixed order, so a summary never repeats what was written. */
export const counted = (
  messages: readonly string[],
): readonly { category: string; count: number }[] => {
  const totals = new Map<string, number>();
  for (const message of messages) {
    const category = diagnosticCategory(message);
    totals.set(category, (totals.get(category) ?? 0) + 1);
  }
  return Object.freeze(
    [...totals]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([category, count]) => Object.freeze({ category, count })),
  );
};

const listed = (problems: readonly string[]) =>
  [...new Set(problems.map(problemCategory))].join(', ');
const refused = (why: string): PhaseResult => ({ kind: 'refused', why });

/**
 * One walk per phase object. A second run refuses rather than walking again: the baseline belongs to
 * the first, and replacing it would leave later phases comparing against a tree they never saw.
 */
export const snapshotPhase = (
  locations: { readonly root: string },
  deps: SnapshotDeps = {},
): SnapshotPhase => {
  const root = locations.root;
  const take = deps.take ?? takeSnapshot;
  // captured with the rest: a caller cannot redirect the walk once the phase is made
  const bounds = Object.freeze({
    cap: SNAPSHOT_CAP,
    maxOutputBytes: SNAPSHOT_OUTPUT_BYTES,
    maxLineBytes: SNAPSHOT_LINE_BYTES,
    ...(deps.python === undefined ? {} : { python: deps.python }),
    ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  let baseline: Snapshot | undefined;
  let used = false;

  const phase: Phase = {
    name: 'snapshot',
    run: async ({ deadline }) => {
      if (used) return refused('the snapshot phase was already used by this run');
      used = true;
      const snapshot = await guarded(() => take(root, { deadline, ...bounds }));
      if (snapshot === FAILED) return refused('the baseline snapshot could not be taken');
      baseline = snapshot; // kept whole, even when the walk did not finish
      const diagnostics = counted(snapshot.helperDiagnostics);
      if (!snapshot.complete) {
        // an ordinary diagnostic ends a walk without any problem in the stream: say what there is
        const named = listed(snapshot.problems);
        const counts = diagnostics.map((d) => `${d.category} ×${String(d.count)}`).join(', ');
        return refused(
          `the baseline snapshot is incomplete${named === '' ? '' : ` (${named})`}${
            counts === '' ? '' : `; diagnostics: ${counts}`
          }`,
        );
      }
      return {
        kind: 'completed',
        evidence: { root, entries: snapshot.entries.length, complete: true, diagnostics },
      };
    },
  };
  return Object.freeze({ phase, taken: () => baseline });
};
