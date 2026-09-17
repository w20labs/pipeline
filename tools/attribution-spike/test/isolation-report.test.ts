import { describe, expect, it } from 'vitest';

import { classifyChanges, quiescence } from '../src/isolation.js';
import { type IsolationInputs, isolationReport } from '../src/isolation-report.js';
import type { Checked, Identity } from '../src/process-identity.js';
import type { LaunchBinding, SessionOwnership } from '../src/session.js';
import type { Snapshot } from '../src/snapshot.js';
import type { SnapshotEntry } from '../src/snapshot-stream.js';

const U = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
const T = `projects/-work-app/${U}.jsonl`;
const BINDING: LaunchBinding = {
  sessionId: U,
  configRoot: '/cfg',
  scratch: '/work/app',
  argv: ['claude', '--session-id', U],
};
const at = (path: string, over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  path,
  kind: 'file',
  size: 1n,
  mtimeNs: 1n,
  dev: 1n,
  ino: 1n,
  ...over,
});
const snap = (entries: SnapshotEntry[], complete = true): Snapshot => ({
  complete,
  entries,
  helperDiagnostics: [],
  problems: [],
});
const record = { pid: 42, startedAt: 'Thu Sep 17 03:00:00 2026', command: '/bin/sh' };
const checked = (proceed: boolean, identities: Identity[]): Checked => ({
  proceed,
  checked: identities.length,
  outcomes: identities.map((identity) => ({ record, identity })),
});
const inputs = (over: Partial<IsolationInputs> = {}): IsolationInputs => ({
  lock: { ok: true, lock: { path: '/cfg/.lock', token: 'secret-token' } },
  records: checked(true, [{ kind: 'absent' }]),
  quiescence: quiescence(snap([]), snap([])),
  classification: classifyChanges(snap([]), snap([]), BINDING),
  ownership: { owned: true, path: `/cfg/${T}`, sessionId: U },
  ...over,
});

describe('the isolation report', () => {
  const grown = at('projects/-work-app/f.jsonl', { size: 2n });
  it.each([
    ['no difference at all', snap([]), snap([]), BINDING, { kind: 'no_change_detected' }],
    ['only the expected transcript', snap([]), snap([at(T)]), BINDING, { kind: 'uncontested' }],
    [
      'another transcript and a configuration change',
      snap([at('settings.json')]),
      snap([at(T), at('projects/-work-app/other.jsonl'), at('settings.json', { size: 9n })]),
      BINDING,
      { kind: 'contested', unexplained: 1 },
    ],
    [
      'an incomplete before snapshot',
      snap([at('projects/-work-app/f.jsonl')], false),
      snap([grown, at(T)]),
      BINDING,
      { kind: 'inconclusive', unconfirmed: 1 },
    ],
    [
      'a refused binding',
      snap([]),
      snap([]),
      { ...BINDING, sessionId: 'U' },
      { kind: 'not_classified', why: 'the session id is not a UUID' },
    ],
  ] as const)('finds %s, and never proves exclusive use', (_label, before, after, b, expected) => {
    const classification = classifyChanges(before, after, b);
    const report = isolationReport(inputs({ classification }));
    const rows =
      classification.ok && classification.rows.length > 0 ? { rows: classification.rows } : {};
    expect(report.finding).toEqual({ ...expected, ...rows });
    expect(report.exclusiveUse).toBe('not proven');
  });

  it('keeps established changes established in an inconclusive finding', () => {
    const classification = classifyChanges(
      snap([at('projects/-work-app/f.jsonl')], false),
      snap([grown, at(T)]),
      BINDING,
    );
    const { finding } = isolationReport(inputs({ classification }));
    expect(
      finding.kind === 'inconclusive' && finding.rows.map((r) => [r.row.type, r.status]),
    ).toEqual([
      ['unconfirmed', 'unexplained'], // the transcript: seen after only, so it may have gone unseen
      ['changed', 'unexplained'], // f.jsonl, observed on both sides: a change, not an uncertainty
    ]);
  });

  it.each([
    [
      'held, without its token',
      { ok: true, lock: { path: '/cfg/.lock', token: 'secret-token' } },
      { held: true, path: '/cfg/.lock' },
    ],
    [
      'refused',
      { ok: false, why: 'held by another run' },
      { held: false, why: 'held by another run' },
    ],
    [
      'refused after a partial create',
      {
        ok: false,
        why: 'write failed',
        cleanupDiagnostics: ['unlink: EACCES'],
        strandedLock: '/cfg/.lock',
      },
      {
        held: false,
        why: 'write failed',
        cleanupDiagnostics: ['unlink: EACCES'],
        strandedLock: '/cfg/.lock',
      },
    ],
  ] as const)('reports the lock %s', (_label, lock, expected) => {
    const report = isolationReport(inputs({ lock }));
    expect(report.safeguards.lock).toEqual(expected);
    expect(
      JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain('secret-token');
  });

  it.each([
    [true, [{ kind: 'absent' }, { kind: 'reused', observed: record }]],
    [
      false,
      [
        { kind: 'leftover' },
        { kind: 'unresolved', why: 'ps timed out' },
        { kind: 'invalid_record', why: 'bad pid' },
        { kind: 'absent' },
      ],
    ],
  ] as const)('reports harness records as checked (launch allowed: %s)', (proceed, identities) => {
    const { records } = isolationReport(
      inputs({ records: checked(proceed, [...identities]) }),
    ).safeguards;
    const count = (kind: Identity['kind']) => identities.filter((i) => i.kind === kind).length;
    expect(records).toEqual({
      checked: identities.length,
      launch: proceed ? 'allowed' : 'blocked',
      outcomes: {
        absent: count('absent'),
        reused: count('reused'),
        leftover: count('leftover'),
        unresolved: count('unresolved'),
        invalid_record: count('invalid_record'),
      },
    });
  });

  it('reports quiescence as it happened, refused with its reason and rows', () => {
    const refused = quiescence(snap([at('settings.json')]), snap([], false));
    expect(isolationReport(inputs({ quiescence: refused })).safeguards.quiescence).toEqual({
      quiet: false,
      why: 'the second snapshot is incomplete',
      rows: [
        { path: 'settings.json', zone: 'configuration', type: 'unconfirmed', seenIn: 'before' },
      ],
    });
  });

  it.each([
    [{ owned: true, path: `/cfg/${T}`, sessionId: U }],
    [{ owned: false, why: 'the helper failed', path: `/cfg/${T}`, diagnostics: ['close failed'] }],
  ] as SessionOwnership[][])('carries ownership unchanged, whatever the finding', (ownership) => {
    const contested = classifyChanges(snap([]), snap([at('projects/x/y.jsonl')]), BINDING);
    expect(isolationReport(inputs({ ownership, classification: contested })).ownership).toEqual(
      ownership,
    );
  });

  it('copies its inputs: freezing and later changes stay on their own side', () => {
    const diagnostics = ['close failed'];
    const ownership = { owned: false as const, why: 'the helper failed', diagnostics };
    const lock = {
      ok: false as const,
      why: 'write failed',
      cleanupDiagnostics: ['unlink: EACCES'],
    };
    const report = isolationReport(inputs({ ownership, lock }));
    expect([
      Object.isFrozen(ownership),
      Object.isFrozen(diagnostics),
      Object.isFrozen(lock),
    ]).toEqual([false, false, false]);
    diagnostics.push('later');
    lock.cleanupDiagnostics.push('later');
    expect(report.ownership).toEqual({
      owned: false,
      why: 'the helper failed',
      diagnostics: ['close failed'],
    });
    expect(report.safeguards.lock).toMatchObject({ cleanupDiagnostics: ['unlink: EACCES'] });
    const frozen = (v: unknown): boolean =>
      typeof v !== 'object' || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(
      frozen(
        isolationReport(
          inputs({ classification: classifyChanges(snap([]), snap([at(T)]), BINDING) }),
        ),
      ),
    ).toBe(true);
    expect(frozen(report)).toBe(true);
  });
});
