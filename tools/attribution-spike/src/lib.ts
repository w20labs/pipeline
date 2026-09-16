import { basename, dirname, isAbsolute, relative } from 'node:path';

/**
 * The decisions the attribution spike's harness makes, separated from the I/O that feeds them.
 *
 * They live here because each is a place the harness was wrong in a way no live run would have
 * revealed. Each is now a function with a regression beside it, so the next paid run exercises
 * behaviour that has already been checked.
 */

export type Agent = 'claude' | 'codex';

/** A transcript file that *might* belong to this run. Its body is not read to decide. */
export interface Candidate {
  readonly path: string;
  /**
   * The file's first record, parsed. Codex opens with `session_meta` carrying `cwd` and
   * `session_id`; Claude names its file after the session. Nothing past this record is read until
   * the file is known to be ours.
   */
  readonly header?: unknown;
}

/** A transcript this run created. Only these may have their bodies read or copied. */
export interface Owned {
  readonly path: string;
  readonly sessionId: string;
}

/** A file that was not shown to be ours. It stays a candidate; nothing of it is read. */
export interface Unproven {
  readonly path: string;
  readonly why: string;
}

export interface Ownership {
  readonly agent: Agent;
  /** The directory the run's agents were started in. Matched exactly, never by prefix. */
  readonly scratch: string;
  /**
   * Transcript stores this run has exclusive use of, because it created them and pointed the
   * agents at them — a private `CODEX_HOME` and `CLAUDE_CONFIG_DIR` rather than the operator's.
   *
   * This is where provenance comes from, and nothing else here can supply it. A file's own
   * contents cannot say which *run* started the session, and neither can its age: a session
   * started in the shared store during this run, by anything at all, is new and says the right
   * working directory. Only "this run made the place it was written to" binds a transcript to
   * these launches.
   *
   * Empty means no store was isolated, and therefore nothing is owned.
   */
  readonly ownedRoots: readonly string[];
  /**
   * Transcript paths already present in those roots before this run launched anything.
   *
   * A candidate filter, kept because a reused private root would otherwise carry an earlier run's
   * sessions. It is not provenance on its own.
   */
  readonly preExisting: ReadonlySet<string>;
}

/**
 * Whether `path` lies inside `root`, by path segment.
 *
 * A string prefix would put `/run/storefront` inside `/run/store`, which is how the directory
 * checks here went wrong before.
 */
const under = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * The directory name Claude derives its project store from.
 *
 * Note it is **not injective** — `~/.cache/x` and `~/-cache/x` produce the same slug — so it
 * locates a transcript within a store this run owns and is never evidence of whose it is.
 */
export const claudeSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** Claude names each transcript after its session id. */
const CLAUDE_SESSION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const statedCwdOf = (header: Record<string, unknown> | undefined): unknown =>
  header === undefined ? undefined : (record(header['payload'])?.['cwd'] ?? header['cwd']);

/**
 * The transcripts this run created, and why every other candidate was not shown to be one.
 *
 * Three things must hold, and each covers a way "recently modified, same directory" was wrong: the
 * file did not exist before this run started; the header is the shape that agent actually writes,
 * carrying a session identity; and the directory it names is *exactly* the scratch directory —
 * matched by path segment, because a substring match also accepts a sibling project whose slug
 * merely begins the same way.
 *
 * Anything else remains a candidate. Its body is never read, and nothing of it is copied.
 */
export const ownedTranscripts = (
  candidates: readonly Candidate[],
  where: Ownership,
): { owned: Owned[]; unproven: Unproven[] } => {
  const owned: Owned[] = [];
  const unproven: Unproven[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const leave = (why: string): void => void unproven.push({ path: candidate.path, why });
    // Provenance first. Everything after this only narrows what an owned store already contains.
    if (!where.ownedRoots.some((root) => under(root, candidate.path))) {
      leave('is not in a store this run has exclusive use of');
      continue;
    }
    if (where.preExisting.has(candidate.path)) {
      leave('existed before this run started');
      continue;
    }
    const header = record(candidate.header);
    const stated = statedCwdOf(header);
    // A stated directory always decides, whichever agent wrote it and wherever the file sits.
    if (stated !== undefined && stated !== where.scratch) {
      leave(`states cwd ${String(stated)}`);
      continue;
    }

    let sessionId: string | undefined;
    if (where.agent === 'codex') {
      if (header?.['type'] !== 'session_meta') {
        leave('is not a codex session_meta header');
        continue;
      }
      if (typeof stated !== 'string') {
        leave('its session_meta states no cwd');
        continue;
      }
      const id = record(header['payload'])?.['session_id'];
      if (typeof id !== 'string' || id.length === 0) {
        leave('its session_meta carries no session_id');
        continue;
      }
      sessionId = id;
    } else {
      // Claude's store is keyed by the directory and its file is named for the session, so the
      // path carries both facts — but only when the directory matches as a whole segment.
      if (basename(dirname(candidate.path)) !== claudeSlug(where.scratch)) {
        leave('is not in this run’s project directory');
        continue;
      }
      const named = CLAUDE_SESSION.exec(basename(candidate.path));
      if (named === null) {
        leave('is not named for a session');
        continue;
      }
      sessionId = named[1] as string;
    }

    if (seen.has(sessionId)) {
      leave(`repeats the session id ${sessionId}`);
      continue;
    }
    seen.add(sessionId);
    owned.push({ path: candidate.path, sessionId });
  }
  return { owned, unproven };
};

/** What the CLI said. Recorded for the findings; it establishes nothing on its own. */
export interface CliResult {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TurnEvidence {
  /** Assistant records in the owned transcripts, counted at submission and again afterwards. */
  readonly assistantBefore: number;
  readonly assistantAfter: number;
  /** Two pane captures taken a settling interval apart, after the CLI returned. */
  readonly paneA: string;
  readonly paneB: string;
}

/**
 * What was observed around a turn — and nothing more.
 *
 * There is deliberately no verdict here. A transcript that grew and a pane that stopped changing
 * are consistent with a finished answer and equally consistent with a commentary line written
 * while a tool is still running; neither input carries the submission's identity, and neither
 * shows that a response terminated. Recording them as observations is all this spike can honestly
 * do until it has measured a signal tied to the submission.
 */
export const observeTurn = (
  evidence: TurnEvidence,
): { readonly signals: readonly string[]; readonly establishesCompletion: false } => ({
  signals: [
    `assistant records ${evidence.assistantBefore} -> ${evidence.assistantAfter}`,
    evidence.assistantAfter > evidence.assistantBefore
      ? 'the transcript grew after the submission'
      : 'the transcript did not grow after the submission',
    evidence.paneA.length > 0 && evidence.paneA === evidence.paneB
      ? 'the pane did not change between two reads'
      : 'the pane changed between two reads, or was empty',
  ],
  // stated in the type, so no caller can read these observations as a conclusion
  establishesCompletion: false,
});

/**
 * Whether this spike may send a second prompt to a pane whose first turn is outstanding.
 *
 * It may not, and it takes no arguments, so there is nothing a caller can supply to change that.
 * Repetition needs completion established for *that submission*, which is the very thing the spike
 * exists to find; gating it on a proxy would assume the answer and put a second prompt into a pane
 * that may still be working. The repeated-prompt scenario is therefore recorded as withheld, and
 * its second prompt is a manual step until a real signal exists.
 */
export const mayRepeat = (): { readonly allowed: false; readonly why: string } => ({
  allowed: false,
  why: 'no completion signal tied to a submission has been established yet',
});
/**
 * The absolute bound every wait in this run answers to.
 *
 * herdr's own `--timeout` bounds the command it is given; it does not bound a child that never
 * closes, nor the reads around it, nor startup, nor cleanup. Cleanup's share is reserved from the
 * start, so the run cannot spend its way out of being able to tidy up.
 */
export class Budget {
  constructor(
    private readonly startedAt: number,
    private readonly totalMs: number,
    private readonly cleanupMs: number,
  ) {}
  /** What work may still take, holding the cleanup reserve back. */
  forWork(now: number): number {
    return Math.max(0, this.startedAt + this.totalMs - this.cleanupMs - now);
  }
  /** What cleanup may take: its reserve, plus anything work did not spend. */
  forCleanup(now: number): number {
    return Math.max(0, this.startedAt + this.totalMs - now);
  }
  spent(now: number): boolean {
    return this.forWork(now) <= 0;
  }
}

/** A deadline miss is a fact about the run, so it is named rather than thrown away. */
export class Overran extends Error {
  constructor(
    readonly label: string,
    readonly afterMs: number,
  ) {
    super(`${label} did not finish within ${afterMs}ms`);
    this.name = 'Overran';
  }
}

/**
 * Bound one wait. Whatever it was waiting on keeps running; only the waiting ends.
 *
 * The deadline is an instant, computed on entry, and the clock decides — not the timer. A timer
 * callback only runs once the event loop is free, so a loop blocked past the deadline lets the
 * work's own callback arrive first and a race on callbacks alone would accept it: a 20ms budget
 * accepting success at 80ms. Nothing can preempt a blocked loop, but once it resumes this reports
 * what actually happened.
 */
export const within = <T>(work: Promise<T>, label: string, ms: number): Promise<T> => {
  // A budget already spent is not a race to lose, and an already-resolved promise must not win it.
  // The work was created by the caller and keeps running regardless, so its eventual rejection
  // still needs a handler: without one, abandoning the wait here would crash the process with an
  // unhandled rejection before any cleanup ran. It is observed and discarded, never reported.
  if (ms <= 0) {
    work.catch(() => undefined);
    return Promise.reject(new Overran(label, ms));
  }
  const deadline = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work.then((value) => {
      if (Date.now() >= deadline) throw new Overran(label, ms);
      return value;
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Overran(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * When each sample is due, measured from the instant the prompt's child actually closed.
 *
 * The first harness slept, then read, then called that "settled" — so a child that closed at 50 ms
 * was recorded as settling at 1,700 ms, and every later offset carried the accumulated cost of the
 * reads before it. Targets are absolute and computed once, from a closure timestamp taken inside
 * the close callback itself.
 */
export const sampleTargets = (closedAt: number, offsets: readonly number[]): number[] =>
  offsets.map((offset) => closedAt + offset);

export interface Timed {
  readonly offset: number;
  /** When this sample should have started. */
  readonly targetAt: number;
  readonly startedAt: number;
  readonly endedAt: number;
  /** How late it actually started. A sample at +0 that starts at +900 measures something else. */
  readonly missedByMs: number;
  /** How long the read itself took, which the next target must not silently absorb. */
  readonly tookMs: number;
}

export const timedSample = (
  offset: number,
  targetAt: number,
  startedAt: number,
  endedAt: number,
): Timed => ({
  offset,
  targetAt,
  startedAt,
  endedAt,
  missedByMs: Math.max(0, startedAt - targetAt),
  tookMs: endedAt - startedAt,
});

/** How long to wait before a target, never negative and never past what the budget allows. */
export const dueIn = (targetAt: number, now: number, budget: number): number =>
  Math.max(0, Math.min(targetAt - now, budget));
