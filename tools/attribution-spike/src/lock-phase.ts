/**
 * The lock phase: takes the run lock before any work depends on it, and gives it back afterwards.
 *
 * Acquisition and release are bounded elsewhere (`lock.ts`); what this adds is the run's side of
 * the bargain. The acquisition is remembered as a promise the moment it starts, so cleanup can
 * reconcile it even when the runner stopped waiting for the phase: a helper that published the
 * lock must not be forgotten because its report arrived late. Nothing the helper or the system
 * wrote is repeated here — every message is fixed wording, built from vocabulary the wrapper has
 * already validated.
 */
import {
  acquireLockBounded,
  type AcquireOutcome,
  type LockDiagnostic,
  type LockOwner,
  releaseLockBounded,
  type ReleaseOutcome,
} from './lock.js';
import type { Phase, PhaseResult } from './runner.js';

export interface LockLocations {
  readonly controlDir: string;
  readonly owner: LockOwner;
}

/** Injected so tests drive the phase without processes; production uses the real wrappers. */
export interface LockDeps {
  readonly acquire?: typeof acquireLockBounded;
  readonly release?: typeof releaseLockBounded;
  readonly now?: () => number;
}

/** A diagnostic as one fixed token: the step and errno the wrapper already checked. */
const token = (d: LockDiagnostic) => `${d.step}${d.errno === null ? '' : ` ${d.errno}`}`;
const listed = (diagnostics: readonly LockDiagnostic[]) => diagnostics.map(token).join(', ');
const withDiagnostics = (why: string, diagnostics: readonly LockDiagnostic[]) =>
  diagnostics.length === 0 ? why : `${why}; diagnostics: ${listed(diagnostics)}`;
/** Said only where something may still hold the lock, never where nothing was published. */
const MAY_REMAIN = 'the lock may remain';

const refused = (why: string): PhaseResult => ({ kind: 'refused', why });

/** What the acquisition established, as the run's own report. */
const reportAcquire = (outcome: AcquireOutcome): PhaseResult => {
  switch (outcome.kind) {
    case 'acquired':
      return {
        kind: 'completed',
        evidence: {
          controlDir: outcome.handle.controlDir,
          runId: outcome.handle.runId,
          diagnostics: outcome.diagnostics.map(token),
        },
      };
    case 'held':
      return refused(withDiagnostics('another run holds the lock', outcome.diagnostics));
    case 'refused': {
      const errno = outcome.errno === null ? '' : `, ${outcome.errno}`;
      return refused(
        withDiagnostics(`the lock was refused (${outcome.reason}${errno})`, outcome.diagnostics),
      );
    }
    case 'unknown':
      // the helper ran; what it did to the directory is not established, so the lock may be held
      return refused(
        `whether the lock was taken is not established (${outcome.problems.join(', ')}); ${MAY_REMAIN}`,
      );
    case 'not_attempted':
      // nothing was spawned, so nothing was published: no warning belongs here
      return refused(`the lock was not attempted (${outcome.reason})`);
  }
};

/** What the release established. `undefined` means there is nothing worth saying. */
const reportRelease = (outcome: ReleaseOutcome): string | undefined => {
  switch (outcome.kind) {
    case 'released':
    case 'missing':
      // a clean outcome still reports what it found on the way: only an empty list is silent
      return outcome.diagnostics.length === 0
        ? undefined
        : `the lock was ${outcome.kind}; diagnostics: ${listed(outcome.diagnostics)}`;
    case 'not_ours':
    case 'replaced':
    case 'unrecognized':
      return withDiagnostics(
        `the lock in place was not this run's (${outcome.kind}); it was left as found`,
        outcome.diagnostics,
      );
    case 'refused': {
      const errno = outcome.errno === null ? '' : `, ${outcome.errno}`;
      return withDiagnostics(
        `the lock could not be released (${outcome.reason}${errno}); ${MAY_REMAIN}`,
        outcome.diagnostics,
      );
    }
    case 'unknown':
      return `whether the lock was released is not established (${outcome.problems.join(', ')}); ${MAY_REMAIN}`;
    case 'not_attempted':
      // never_ran is the one case where nothing was published, so nothing may remain
      return outcome.reason === 'never_ran'
        ? undefined
        : `the lock was not released (${outcome.reason}); ${MAY_REMAIN}`;
  }
};

/**
 * A call that failed, by throwing where it was called or by rejecting later. It is not proof that
 * nothing was published: a helper can publish and then fail on its way back, so this is uncertainty,
 * never absence. Distinct from `not_attempted`, which the wrapper reports without spawning at all.
 */
const FAILED = 'failed';
type Attempt = AcquireOutcome | typeof FAILED;
const FAILED_WHY = `the lock could not be asked for; ${MAY_REMAIN}`;

/** Whatever the call does — throw here, reject later — becomes one fixed fact, never its words. */
const guarded = <T>(call: () => Promise<T>): Promise<T | typeof FAILED> =>
  (async () => call())().catch((): typeof FAILED => FAILED);

/** The acquisition, if it resolves before the deadline. A late one is left to settle unheard. */
const reconcile = (
  attempt: Promise<Attempt>,
  deadline: number,
  now: () => number,
): Promise<Attempt | 'pending'> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('pending'), Math.max(0, deadline - now()));
    void attempt.then(
      (outcome) => (clearTimeout(timer), resolve(outcome)),
      () => (clearTimeout(timer), resolve(FAILED)),
    );
  });

/**
 * One acquisition per phase object. The locations are copied when it is made, and a second run
 * refuses rather than replacing the first acquisition's ownership: cleanup belongs to that one.
 */
export const lockPhase = (locations: LockLocations, deps: LockDeps = {}): Phase => {
  const controlDir = locations.controlDir;
  const owner: LockOwner = Object.freeze({
    runId: locations.owner.runId,
    pid: locations.owner.pid,
    startedAt: locations.owner.startedAt,
  });
  const acquire = deps.acquire ?? acquireLockBounded;
  const release = deps.release ?? releaseLockBounded;
  const now = deps.now ?? Date.now;
  /** Stored before anything is awaited, so cleanup can reconcile an acquisition still in flight. */
  let attempt: Promise<Attempt> | undefined;
  let used = false;

  return {
    name: 'lock',
    run: async ({ deadline }) => {
      if (used) return refused('the lock phase was already used by this run');
      used = true;
      // guarded before it is called: a synchronous throw would otherwise carry its own words out
      const started = guarded(() => acquire(controlDir, owner, { deadline }));
      attempt = started;
      const outcome = await started;
      return outcome === FAILED ? refused(FAILED_WHY) : reportAcquire(outcome);
    },
    cleanup: async (deadline) => {
      if (attempt === undefined) return undefined; // the phase never ran: nothing was asked
      const outcome = await reconcile(attempt, deadline, now);
      if (outcome === 'pending')
        return `the acquisition did not resolve by the cleanup deadline; ${MAY_REMAIN}`;
      // a failed call left no handle, so there is nothing to release and nothing established
      if (outcome === FAILED) return FAILED_WHY;
      if (outcome.kind === 'not_attempted') return undefined; // nothing was spawned
      // reconciling spends time, so the budget is rechecked before a release is started
      if (now() >= deadline) return `the cleanup budget was spent before release; ${MAY_REMAIN}`;
      const given = await guarded(() => release(outcome.handle, { deadline }));
      return given === FAILED
        ? `the lock could not be given back; ${MAY_REMAIN}`
        : reportRelease(given);
    },
  };
};
