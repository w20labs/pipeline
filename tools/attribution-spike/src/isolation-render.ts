import type { ClassifiedRow } from './isolation.js';
import type { Finding } from './isolation-report.js';
import type { DifferenceRow } from './snapshot-diff.js';

/**
 * The isolation finding as exact lines. Fixed wording is written as it is; every string that came
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
