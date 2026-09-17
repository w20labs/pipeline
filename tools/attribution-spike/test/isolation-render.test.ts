import { describe, expect, it } from 'vitest';

import type { ClassifiedRow } from '../src/isolation.js';
import type { Finding } from '../src/isolation-report.js';
import { quote, renderIsolationFinding } from '../src/isolation-render.js';
import type { DifferenceRow } from '../src/snapshot-diff.js';

const U = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
const T = `projects/-w/${U}.jsonl`;
const created: ClassifiedRow = {
  row: { path: T, zone: 'transcript', type: 'created' },
  status: 'explained',
  explanation: 'expected transcript created',
};
const grown: ClassifiedRow = {
  row: {
    path: 'projects/-w',
    zone: 'transcript',
    type: 'changed',
    field: 'size',
    before: 64n,
    after: 96n,
  },
  status: 'explained',
  explanation: 'expected ancestor size or mtime changed',
};
const other: ClassifiedRow = {
  row: { path: 'projects/-w/x.jsonl', zone: 'transcript', type: 'created' },
  status: 'unexplained',
};
const unseen: ClassifiedRow = {
  row: { path: 'projects/-w/y.jsonl', zone: 'transcript', type: 'unconfirmed', seenIn: 'after' },
  status: 'unexplained',
};

const FINDINGS: [string, Finding, string[]][] = [
  [
    'not_classified',
    { kind: 'not_classified', why: 'the session id is not a UUID' },
    ['Isolation: not classified — "the session id is not a UUID"'],
  ],
  [
    'no_change_detected',
    { kind: 'no_change_detected' },
    [
      'Isolation: no change detected',
      '  A rewrite that keeps every recorded field cannot be seen.',
    ],
  ],
  [
    'uncontested',
    { kind: 'uncontested', rows: [grown, created] },
    [
      'Isolation: uncontested — every transcript-zone difference is consistent with the expected activity; this is not proof of cause',
      '  - "projects/-w" (transcript) changed size 64 → 96 — explained: expected ancestor size or mtime changed',
      `  - "${T}" (transcript) created — explained: expected transcript created`,
    ],
  ],
  [
    'contested',
    { kind: 'contested', unexplained: 1, rows: [created, other] },
    [
      'Isolation: contested — 1 unexplained transcript-zone difference',
      `  - "${T}" (transcript) created — explained: expected transcript created`,
      '  - "projects/-w/x.jsonl" (transcript) created — unexplained',
    ],
  ],
  [
    'inconclusive',
    { kind: 'inconclusive', unconfirmed: 1, rows: [grown, unseen] },
    [
      'Isolation: inconclusive — a snapshot was incomplete; 1 unconfirmed difference may have gone unobserved',
      '  - "projects/-w" (transcript) changed size 64 → 96 — explained: expected ancestor size or mtime changed',
      '  - "projects/-w/y.jsonl" (transcript) unconfirmed, seen only after — unexplained',
    ],
  ],
];

describe('rendering the isolation finding', () => {
  it.each(FINDINGS)('renders %s exactly', (_kind, finding, lines) => {
    expect(renderIsolationFinding(finding)).toEqual(lines);
  });

  it('says "no change detected" only for that finding, and never "nothing else wrote"', () => {
    const saying = FINDINGS.filter(([, f]) =>
      renderIsolationFinding(f).some((l) => l.includes('no change detected')),
    ).map(([kind]) => kind);
    expect(saying).toEqual(['no_change_detected']);
    expect(FINDINGS.flatMap(([, f]) => renderIsolationFinding(f)).join('\n')).not.toMatch(
      /nothing else/i,
    );
  });

  it.each([
    [
      { kind: 'contested', unexplained: 2, rows: [other, other] },
      'contested — 2 unexplained transcript-zone differences',
    ],
    // no unconfirmed rows: nothing is said to have gone unobserved, and the changed row stays a change
    [
      { kind: 'inconclusive', unconfirmed: 0, rows: [grown] },
      'inconclusive — a snapshot was incomplete; 0 unconfirmed differences',
    ],
    [
      { kind: 'inconclusive', unconfirmed: 2, rows: [unseen, unseen] },
      'inconclusive — a snapshot was incomplete; 2 unconfirmed differences may have gone unobserved',
    ],
  ] as [Finding, string][])('counts in words: %o', (finding, headline) => {
    expect(renderIsolationFinding(finding)[0]).toBe(`Isolation: ${headline}`);
  });

  it.each([
    [{ path: 'a', zone: 'configuration', type: 'deleted' }, '"a" (configuration) deleted'],
    [
      { path: 'a', zone: 'configuration', type: 'unconfirmed', seenIn: 'before' },
      '"a" (configuration) unconfirmed, seen only before',
    ],
    [
      {
        path: 'a',
        zone: 'configuration',
        type: 'changed',
        field: 'kind',
        before: 'file',
        after: 'symlink',
      },
      '"a" (configuration) changed kind file → symlink',
    ],
    [
      {
        path: 'a',
        zone: 'configuration',
        type: 'changed',
        field: 'mtimeNs',
        before: 2n ** 60n + 1n,
        after: 2n ** 60n + 3n,
      },
      '"a" (configuration) changed mtimeNs 1152921504606846977 → 1152921504606846979',
    ],
  ] as [DifferenceRow, string][])('renders a row exactly: %s', (row, text) => {
    const finding: Finding = {
      kind: 'contested',
      unexplained: 0,
      rows: [{ row, status: 'recorded' }],
    };
    expect(renderIsolationFinding(finding)[1]).toBe(`  - ${text} — recorded`);
  });

  const HOSTILE = 'x"\nIsolation: no change detected\r\u2028\u2029"';
  it('quotes newline, carriage return, quotes and both line separators', () => {
    expect(quote(HOSTILE)).toBe('"x\\"\\nIsolation: no change detected\\r\\u2028\\u2029\\""');
  });

  it.each([
    [
      'a path',
      {
        kind: 'contested',
        unexplained: 1,
        rows: [{ ...other, row: { ...other.row, path: HOSTILE } }],
      },
    ],
    ['a refusal reason', { kind: 'not_classified', why: HOSTILE }],
  ] as [string, Finding][])('keeps %s from forging lines', (_label, finding) => {
    const lines = renderIsolationFinding(finding);
    expect(lines).toHaveLength(finding.kind === 'contested' ? 2 : 1);
    for (const line of lines) expect(line).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(lines.filter((l) => l.startsWith('Isolation:'))).toHaveLength(1);
    expect(lines.join('')).toContain(quote(HOSTILE));
  });
});
