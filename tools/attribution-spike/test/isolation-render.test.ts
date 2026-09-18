import { describe, expect, it } from 'vitest';

import { type ClassifiedRow, classifyChanges, quiescence } from '../src/isolation.js';
import { type Finding, type IsolationReport, isolationReport } from '../src/isolation-report.js';
import {
  quote,
  renderIsolationFinding,
  renderIsolationReport,
  renderOwnership,
  renderSafeguards,
} from '../src/isolation-render.js';
import type { SessionOwnership } from '../src/session.js';
import type { Snapshot } from '../src/snapshot.js';
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

type Safeguards = IsolationReport['safeguards'];
const RECORDS: Safeguards['records'] = {
  checked: 15,
  launch: 'blocked',
  // distinct counts, so two swapped labels cannot pass
  outcomes: { absent: 1, reused: 2, leftover: 3, unresolved: 4, invalid_record: 5 },
};
const QUIET: Safeguards['quiescence'] = { quiet: true };
const HELD: Safeguards['lock'] = { held: true, path: '/cfg/.lock' };
const RECORDS_LINE =
  '  - Harness process records: 15 checked, launch blocked (absent 1, reused 2, leftover 3, unresolved 4, invalid_record 5)';

describe('rendering safeguards and ownership', () => {
  it.each([
    [HELD, ['  - Lock: held at "/cfg/.lock"']],
    [{ held: false, why: 'held by another run' }, ['  - Lock: not held — "held by another run"']],
    [
      {
        held: false,
        why: 'write failed',
        cleanupDiagnostics: ['unlink: EACCES', 'close: EBADF'],
        strandedLock: '/cfg/.lock',
      },
      [
        '  - Lock: not held — "write failed"',
        '      cleanup: "unlink: EACCES"',
        '      cleanup: "close: EBADF"',
        '      stranded lock: "/cfg/.lock"',
      ],
    ],
  ] as [Safeguards['lock'], string[]][])('renders the lock %o exactly', (lock, lines) => {
    expect(renderSafeguards({ lock, records: RECORDS, quiescence: QUIET })).toEqual([
      'Exclusive use: not proven. Safeguards:',
      ...lines,
      RECORDS_LINE,
      '  - Quiescence: no change detected between two complete snapshots',
    ]);
  });

  it('renders allowed records with every outcome in fixed order', () => {
    const records = { ...RECORDS, checked: 3, launch: 'allowed' as const };
    expect(renderSafeguards({ lock: HELD, records, quiescence: QUIET })[2]).toBe(
      '  - Harness process records: 3 checked, launch allowed (absent 1, reused 2, leftover 3, unresolved 4, invalid_record 5)',
    );
  });

  it('renders refused quiescence with its reason and rows, without statuses', () => {
    const quiescence: Safeguards['quiescence'] = {
      quiet: false,
      why: 'the second snapshot is incomplete',
      rows: [
        { path: 'a', zone: 'configuration', type: 'deleted' },
        { path: 'projects/b', zone: 'transcript', type: 'unconfirmed', seenIn: 'before' },
      ],
    };
    expect(renderSafeguards({ lock: HELD, records: RECORDS, quiescence }).slice(3)).toEqual([
      '  - Quiescence: not quiet — "the second snapshot is incomplete"',
      '      - "a" (configuration) deleted',
      '      - "projects/b" (transcript) unconfirmed, seen only before',
    ]);
  });

  it.each([
    [
      { owned: true, path: '/cfg/t.jsonl', sessionId: 'abc' },
      ['Ownership: owned — "/cfg/t.jsonl" (session "abc")'],
    ],
    [
      {
        owned: false,
        why: 'the helper failed',
        path: '/cfg/t.jsonl',
        diagnostics: ['close failed', 'EIO'],
      },
      [
        'Ownership: not owned — "the helper failed"',
        '    path: "/cfg/t.jsonl"',
        '    diagnostic: "close failed"',
        '    diagnostic: "EIO"',
      ],
    ],
    [
      { owned: false, why: 'the session id is not a UUID' },
      ['Ownership: not owned — "the session id is not a UUID"'],
    ],
  ] as [SessionOwnership, string[]][])('renders ownership %o exactly', (ownership, lines) => {
    expect(renderOwnership(ownership)).toEqual(lines);
  });
});

describe('rendering the whole report', () => {
  const U2 = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
  const binding = {
    sessionId: U2,
    configRoot: '/cfg',
    scratch: '/w',
    argv: ['claude', '--session-id', U2],
  };
  const file = (path: string) => ({
    path,
    kind: 'file' as const,
    size: 1n,
    mtimeNs: 1n,
    dev: 1n,
    ino: 1n,
  });
  const snap = (entries: ReturnType<typeof file>[]): Snapshot => ({
    complete: true,
    entries,
    helperDiagnostics: [],
    problems: [],
  });
  const report = (after: Snapshot) =>
    renderIsolationReport(
      isolationReport({
        lock: { ok: true, lock: { path: '/cfg/.lock' } }, // no token: the report never reads one
        records: {
          proceed: true,
          checked: 1,
          outcomes: [
            { record: { pid: 7, startedAt: 'x', command: 'y' }, identity: { kind: 'absent' } },
          ],
        },
        quiescence: quiescence(snap([]), snap([])),
        classification: classifyChanges(snap([]), after, binding),
        ownership: { owned: true, path: `/cfg/projects/-w/${U2}.jsonl`, sessionId: U2 },
      }),
    );

  it('renders finding, safeguards and ownership in order, exactly', () => {
    expect(report(snap([file('projects/-w/other.jsonl')]))).toEqual([
      'Isolation: contested — 1 unexplained transcript-zone difference',
      '  - "projects/-w/other.jsonl" (transcript) created — unexplained',
      '',
      'Exclusive use: not proven. Safeguards:',
      '  - Lock: held at "/cfg/.lock"',
      '  - Harness process records: 1 checked, launch allowed (absent 1, reused 0, leftover 0, unresolved 0, invalid_record 0)',
      '  - Quiescence: no change detected between two complete snapshots',
      '',
      `Ownership: owned — "/cfg/projects/-w/${U2}.jsonl" (session "${U2}")`,
    ]);
  });

  it.each([
    ['a contested finding beside quiet quiescence', [file('projects/-w/other.jsonl')], false],
    ['no change at all', [], true],
  ])(
    'says "no change detected" in the finding only when it is the finding: %s',
    (_label, after, said) => {
      const lines = report(snap(after));
      const finding = lines.slice(0, lines.indexOf(''));
      const rest = lines.slice(lines.indexOf(''));
      expect(finding.some((l) => l.includes('no change detected'))).toBe(said);
      expect(rest.some((l) => l.includes('no change detected'))).toBe(true); // the quiet safeguard
      expect(lines.join('\n')).not.toMatch(/nothing else/i);
    },
  );

  const HOSTILE = 'x"\nOwnership: owned\r\u2028\u2029"';
  const LINE_BREAKS = /[\n\r\u2028\u2029]/;
  it.each([
    [
      'refused lock and ownership',
      {
        finding: { kind: 'not_classified', why: HOSTILE },
        exclusiveUse: 'not proven',
        safeguards: {
          lock: { held: false, why: HOSTILE, cleanupDiagnostics: [HOSTILE], strandedLock: HOSTILE },
          records: RECORDS,
          quiescence: {
            quiet: false,
            why: HOSTILE,
            rows: [{ path: HOSTILE, zone: 'configuration', type: 'deleted' }],
          },
        },
        ownership: { owned: false, why: HOSTILE, path: HOSTILE, diagnostics: [HOSTILE] },
      },
      9, // finding, lock, cleanup, stranded lock, quiescence, its row, ownership, path, diagnostic
    ],
    [
      'held lock and owned transcript',
      {
        finding: { kind: 'no_change_detected' },
        exclusiveUse: 'not proven',
        safeguards: { lock: { held: true, path: HOSTILE }, records: RECORDS, quiescence: QUIET },
        ownership: { owned: true, path: HOSTILE, sessionId: HOSTILE },
      },
      3,
    ],
  ] as [string, IsolationReport, number][])(
    'keeps hostile text on its own line: %s',
    (_label, r, fields) => {
      const lines = renderIsolationReport(r);
      for (const line of lines) expect(line).not.toMatch(LINE_BREAKS);
      for (const head of [
        'Isolation:',
        'Exclusive use:',
        '  - Lock:',
        '  - Harness',
        '  - Quiescence:',
        'Ownership:',
      ])
        expect(lines.filter((l) => l.startsWith(head))).toHaveLength(1);
      expect(lines.join('\n').split(quote(HOSTILE)).length - 1).toBe(fields);
    },
  );
});
