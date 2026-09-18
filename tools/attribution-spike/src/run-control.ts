/** A research run's controls: cleanup around a run, a record before launch, one allowed prompt. */

export type Guarded<T> =
  | { readonly ok: true; readonly value: T; readonly cleanupDiagnostics: readonly string[] }
  | {
      readonly ok: false;
      readonly failure: string;
      readonly cleanupDiagnostics: readonly string[];
    };

/** Run `work`, then every cleanup. A cleanup failure never replaces or hides the run's failure. */
export const withCleanup = async <T>(
  work: () => Promise<T>,
  cleanups: readonly (() => string | undefined | Promise<string | undefined>)[],
): Promise<Guarded<T>> => {
  let outcome: { ok: true; value: T } | { ok: false; failure: string };
  try {
    outcome = { ok: true, value: await work() };
  } catch (cause) {
    outcome = { ok: false, failure: cause instanceof Error ? cause.message : String(cause) };
  }
  const cleanupDiagnostics: string[] = [];
  for (const cleanup of cleanups) {
    try {
      const diagnostic = await cleanup();
      if (diagnostic !== undefined) cleanupDiagnostics.push(diagnostic);
    } catch (cause) {
      cleanupDiagnostics.push(`cleanup threw: ${String(cause)}`);
    }
  }
  return { ...outcome, cleanupDiagnostics };
};

/**
 * Persist the launch record, then dispatch exactly what was recorded. The arguments are copied
 * before anything is awaited, and a record that could not be written means no launch at all.
 */
export const recordThenDispatch = async <T>(
  argv: readonly string[],
  persist: (argv: readonly string[]) => Promise<void>,
  dispatch: (argv: readonly string[]) => Promise<T>,
): Promise<{ ok: true; argv: readonly string[]; dispatched: T } | { ok: false; why: string }> => {
  const snapshot = Object.freeze([...argv]);
  try {
    await persist(snapshot);
  } catch (cause) {
    return {
      ok: false,
      why: `the launch record could not be written; nothing was launched: ${String(cause)}`,
    };
  }
  return { ok: true, argv: snapshot, dispatched: await dispatch(snapshot) };
};

export interface GateTarget {
  readonly runId: string;
  readonly pane: string;
  readonly sessionId: string;
}
/** An operator saw this run's pane and session ready. It says nothing about runtime readiness. */
export interface Confirmation extends GateTarget {
  readonly confirmedAt: number;
}
/** Permission to send one prompt in this run. Separate from confirmation, and used once. */
export interface Authorization {
  readonly runId: string;
}

export type GateResult =
  | { readonly kind: 'refused'; readonly why: string }
  | { readonly kind: 'submitted'; readonly outcome: unknown }
  /** Attempted and failed. The authorization stays used: what reached the agent is unknown. */
  | { readonly kind: 'submission_failed'; readonly why: string };

/**
 * Lets exactly one prompt through, with both records matching this launch. The authorization is
 * consumed synchronously *before* submitting, so concurrent attempts cannot both pass, and a failed
 * or uncertain submission does not give it back: a resend needs a new authorization.
 */
export const promptGate = (given: GateTarget) => {
  // copied now: the caller's object may change later, and this gate belongs to the launch it had
  const target: GateTarget = Object.freeze({
    runId: given.runId,
    pane: given.pane,
    sessionId: given.sessionId,
  });
  let used = false;
  return async (
    confirmation: Confirmation | undefined,
    authorization: Authorization | undefined,
    submit: () => Promise<unknown>,
  ): Promise<GateResult> => {
    if (confirmation === undefined) return { kind: 'refused', why: 'no operator confirmation' };
    if (authorization === undefined) return { kind: 'refused', why: 'no authorization to prompt' };
    for (const field of ['runId', 'pane', 'sessionId'] as const)
      if (confirmation[field] !== target[field])
        return { kind: 'refused', why: `the confirmation is for another ${field}` };
    if (authorization.runId !== target.runId)
      return { kind: 'refused', why: 'the authorization is for another run' };
    if (used) return { kind: 'refused', why: 'this run’s authorization has already been used' };
    used = true;
    try {
      return { kind: 'submitted', outcome: await submit() };
    } catch (cause) {
      return { kind: 'submission_failed', why: String(cause) };
    }
  };
};
