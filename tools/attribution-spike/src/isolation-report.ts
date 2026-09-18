import type { ClassifiedRow, Classification, Quiescence } from './isolation.js';
import type { Checked, Identity } from './process-identity.js';
import type { SessionOwnership } from './session.js';
import type { DifferenceRow } from './snapshot-diff.js';

/**
 * What a run can say about isolation, as structure. Rendering it to exact lines is separate.
 *
 * Exclusive use is never proven: the safeguards are reported as they happened, beside that. Ownership
 * is P1's result, carried unchanged; no isolation finding alters it. Lock *release* belongs to the
 * runner's cleanup report, not here.
 */

/**
 * What the report needs of a lock attempt: where a held lock is, or why one was not held. Declared
 * here rather than imported, so the report depends on the fields it renders and on nothing else.
 */
export type LockAttempt =
  | { readonly ok: true; readonly lock: { readonly path: string } }
  | {
      readonly ok: false;
      readonly why: string;
      readonly cleanupDiagnostics?: readonly string[];
      /** A partial lock an attempt created and could not confirm removing. */
      readonly strandedLock?: string;
    };

export interface IsolationInputs {
  readonly lock: LockAttempt;
  readonly records: Checked;
  readonly quiescence: Quiescence;
  readonly classification: Classification;
  readonly ownership: SessionOwnership;
}

export type Finding =
  /** The binding was refused, so nothing was classified. */
  | { readonly kind: 'not_classified'; readonly why: string }
  /** A snapshot was incomplete. Changed rows stay established; only `unconfirmed` rows are uncertain. */
  | {
      readonly kind: 'inconclusive';
      readonly unconfirmed: number;
      readonly rows: readonly ClassifiedRow[];
    }
  | {
      readonly kind: 'contested';
      readonly unexplained: number;
      readonly rows: readonly ClassifiedRow[];
    }
  /** Both snapshots complete and no difference at all. A rewrite keeping every field is invisible. */
  | { readonly kind: 'no_change_detected' }
  /** Differences exist and none is unexplained: consistent with expected activity, not proof of cause. */
  | { readonly kind: 'uncontested'; readonly rows: readonly ClassifiedRow[] };

export type LockSafeguard =
  | { readonly held: true; readonly path: string }
  | {
      readonly held: false;
      readonly why: string;
      readonly cleanupDiagnostics?: readonly string[];
      readonly strandedLock?: string;
    };

export interface IsolationReport {
  readonly finding: Finding;
  readonly exclusiveUse: 'not proven';
  readonly safeguards: {
    readonly lock: LockSafeguard;
    readonly records: {
      readonly checked: number;
      readonly launch: 'allowed' | 'blocked';
      readonly outcomes: Readonly<Record<Identity['kind'], number>>;
    };
    readonly quiescence:
      | { readonly quiet: true }
      | { readonly quiet: false; readonly why: string; readonly rows: readonly DifferenceRow[] };
  };
  readonly ownership: SessionOwnership;
}

/** A deep copy, frozen throughout: the caller's objects are neither frozen nor aliased. */
const frozenCopy = <T>(value: T): T => {
  const freeze = (v: unknown): unknown => {
    if (typeof v === 'object' && v !== null) Object.values(Object.freeze(v)).forEach(freeze);
    return v;
  };
  return freeze(structuredClone(value)) as T;
};

const finding = (c: Classification): Finding => {
  if (!c.ok) return { kind: 'not_classified', why: c.why };
  const count = (test: (r: ClassifiedRow) => boolean) => c.rows.filter(test).length;
  if (c.verdict === 'inconclusive')
    return {
      kind: 'inconclusive',
      unconfirmed: count((r) => r.row.type === 'unconfirmed'),
      rows: c.rows,
    };
  if (c.verdict === 'contested')
    return {
      kind: 'contested',
      unexplained: count((r) => r.status === 'unexplained'),
      rows: c.rows,
    };
  return c.rows.length === 0
    ? { kind: 'no_change_detected' }
    : { kind: 'uncontested', rows: c.rows };
};

export const isolationReport = (inputs: IsolationInputs): IsolationReport => {
  const { lock, records, quiescence, classification, ownership } = inputs;
  const outcomes: Record<Identity['kind'], number> = {
    absent: 0,
    reused: 0,
    leftover: 0,
    unresolved: 0,
    invalid_record: 0,
  };
  for (const { identity } of records.outcomes) outcomes[identity.kind] += 1;
  return frozenCopy<IsolationReport>({
    finding: finding(classification),
    exclusiveUse: 'not proven',
    safeguards: {
      // the token is the lock's own secret for release; the report needs only where it was held
      lock: lock.ok
        ? { held: true, path: lock.lock.path }
        : {
            held: false,
            why: lock.why,
            ...(lock.cleanupDiagnostics === undefined
              ? {}
              : { cleanupDiagnostics: lock.cleanupDiagnostics }),
            ...(lock.strandedLock === undefined ? {} : { strandedLock: lock.strandedLock }),
          },
      records: {
        checked: records.checked,
        launch: records.proceed ? 'allowed' : 'blocked',
        outcomes,
      },
      quiescence,
    },
    ownership,
  });
};
