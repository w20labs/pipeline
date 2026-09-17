import type { ClassifiedRow } from './isolation.js';
import type { Finding, IsolationReport } from './isolation-report.js';
import type { SessionOwnership } from './session.js';
import type { DifferenceRow } from './snapshot-diff.js';

/**
 * The isolation report as exact lines. Fixed wording is written as it is; every string that came
 * from outside (paths, reasons) is JSON-quoted, with U+2028 and U+2029 escaped as well, so no value
 * can end a line early or forge one of the report's own lines.
 */

export const quote = (text: string): string =>
  JSON.stringify(text)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/** One difference, without a status: `"path" (zone) type…`. Values are printed in full. */
export const renderDifference = (row: DifferenceRow): string => {
  const head = `${quote(row.path)} (${row.zone})`;
  switch (row.type) {
    case 'created':
    case 'deleted':
      return `${head} ${row.type}`;
    case 'unconfirmed':
      return `${head} unconfirmed, seen only ${row.seenIn}`;
    case 'changed':
      return `${head} changed ${row.field} ${String(row.before)} → ${String(row.after)}`;
  }
};

const renderRow = ({ row, ...classified }: ClassifiedRow): string =>
  `  - ${renderDifference(row)} — ${
    classified.status === 'explained' ? `explained: ${classified.explanation}` : classified.status
  }`;

export const renderIsolationFinding = (finding: Finding): readonly string[] => {
  switch (finding.kind) {
    case 'not_classified':
      return [`Isolation: not classified — ${quote(finding.why)}`];
    case 'no_change_detected':
      return [
        'Isolation: no change detected',
        '  A rewrite that keeps every recorded field cannot be seen.',
      ];
    case 'uncontested':
      return [
        'Isolation: uncontested — every transcript-zone difference is consistent with the expected activity; this is not proof of cause',
        ...finding.rows.map(renderRow),
      ];
    case 'contested':
      return [
        `Isolation: contested — ${plural(finding.unexplained, 'unexplained transcript-zone difference')}`,
        ...finding.rows.map(renderRow),
      ];
    case 'inconclusive': {
      // only unconfirmed rows are uncertain; with none, nothing is said to have gone unobserved
      const unconfirmed = plural(finding.unconfirmed, 'unconfirmed difference');
      return [
        `Isolation: inconclusive — a snapshot was incomplete; ${
          finding.unconfirmed === 0 ? unconfirmed : `${unconfirmed} may have gone unobserved`
        }`,
        ...finding.rows.map(renderRow),
      ];
    }
  }
};

/** Outcome kinds in the order they are always listed. */
const OUTCOMES = ['absent', 'reused', 'leftover', 'unresolved', 'invalid_record'] as const;

export const renderSafeguards = ({
  lock,
  records,
  quiescence,
}: IsolationReport['safeguards']): readonly string[] => [
  'Exclusive use: not proven. Safeguards:',
  ...(lock.held
    ? [`  - Lock: held at ${quote(lock.path)}`]
    : [
        `  - Lock: not held — ${quote(lock.why)}`,
        ...(lock.cleanupDiagnostics ?? []).map((d) => `      cleanup: ${quote(d)}`),
        ...(lock.strandedLock === undefined
          ? []
          : [`      stranded lock: ${quote(lock.strandedLock)}`]),
      ]),
  `  - Harness process records: ${String(records.checked)} checked, launch ${records.launch} (${OUTCOMES.map(
    (kind) => `${kind} ${String(records.outcomes[kind])}`,
  ).join(', ')})`,
  ...(quiescence.quiet
    ? ['  - Quiescence: no change detected between two complete snapshots']
    : [
        `  - Quiescence: not quiet — ${quote(quiescence.why)}`,
        ...quiescence.rows.map((row) => `      - ${renderDifference(row)}`),
      ]),
];

export const renderOwnership = (ownership: SessionOwnership): readonly string[] =>
  ownership.owned
    ? [`Ownership: owned — ${quote(ownership.path)} (session ${quote(ownership.sessionId)})`]
    : [
        `Ownership: not owned — ${quote(ownership.why)}`,
        ...(ownership.path === undefined ? [] : [`    path: ${quote(ownership.path)}`]),
        ...(ownership.diagnostics ?? []).map((d) => `    diagnostic: ${quote(d)}`),
      ];

/** Finding, safeguards, ownership: in that order, one empty line between sections. */
export const renderIsolationReport = (report: IsolationReport): readonly string[] => [
  ...renderIsolationFinding(report.finding),
  '',
  ...renderSafeguards(report.safeguards),
  '',
  ...renderOwnership(report.ownership),
];
