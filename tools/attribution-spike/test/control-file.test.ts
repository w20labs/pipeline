import { describe, expect, it } from 'vitest';

import { MAX_CAP, parseControlResult } from '../src/control-file.js';

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const b64 = (text: string) => Buffer.from(text).toString('base64');
const closeFile = { step: 'close_file', errno: 'EBADF' };
const refused = (reason: string, errno: string | null, diagnostics: unknown[] = []) => ({
  kind: 'refused',
  reason,
  errno,
  diagnostics,
});
const unusable = (problem: string) => ({ kind: 'unusable', problems: [problem] });

describe('validating the control-file helper output', () => {
  it.each([
    [
      'a read',
      { kind: 'read', base64: b64('abc'), diagnostics: [] },
      { kind: 'read', bytes: Buffer.from('abc') },
    ],
    [
      'an empty read',
      { kind: 'read', base64: '', diagnostics: [] },
      { kind: 'read', bytes: Buffer.alloc(0) },
    ],
    ['a missing file', { kind: 'missing', diagnostics: [] }, { kind: 'missing' }],
    ['a refusal with an errno', refused('symlink', 'ELOOP'), refused('symlink', 'ELOOP')],
    ['a refusal with a null errno', refused('too_large', null), refused('too_large', null)],
    [
      'a close failure',
      refused('close_failed', null, [closeFile]),
      refused('close_failed', null, [closeFile]),
    ],
    // a close can fail after the refusal was decided; the original reason stands
    [
      'a refusal that also failed to close',
      refused('not_regular', null, [closeFile]),
      refused('not_regular', null, [closeFile]),
    ],
  ])('accepts %s, exactly', (_label, output, expected) => {
    expect(parseControlResult(line(output), 64)).toEqual(expected);
  });

  it('freezes the result and its diagnostics, and copies bytes that the caller then owns', () => {
    const r = parseControlResult(line(refused('close_failed', null, [closeFile])), 64);
    expect(
      r.kind === 'refused' && [
        Object.isFrozen(r),
        Object.isFrozen(r.diagnostics),
        Object.isFrozen(r.diagnostics[0]),
      ],
    ).toEqual([true, true, true]);
    const read = parseControlResult(
      line({ kind: 'read', base64: b64('abc'), diagnostics: [] }),
      64,
    );
    expect(Object.isFrozen(read)).toBe(true);
    if (read.kind !== 'read') throw new Error('expected a read');
    read.bytes[0] = 0x7a; // a Buffer cannot be frozen: this copy belongs to the caller alone
    expect(
      parseControlResult(line({ kind: 'read', base64: b64('abc'), diagnostics: [] }), 64),
    ).toEqual({ kind: 'read', bytes: Buffer.from('abc') });
  });

  it.each([0, -1, 1.5, MAX_CAP + 1, Number.NaN])('refuses the cap %s before parsing', (cap) => {
    expect(parseControlResult(line({ kind: 'missing', diagnostics: [] }), cap)).toEqual(
      unusable('the cap must be a safe integer from 1 to MAX_CAP'),
    );
  });

  it.each([
    ['empty output', '', 'the output is not exactly one line'],
    [
      'no trailing newline',
      JSON.stringify({ kind: 'missing', diagnostics: [] }),
      'the output is not exactly one line',
    ],
    [
      'two lines',
      line({ kind: 'missing', diagnostics: [] }).repeat(2),
      'the output is not exactly one line',
    ],
    ['text that is not JSON', 'SECRET-TOKEN\n', 'the output is not JSON'],
    ['null', 'null\n', 'the output is not an object'],
    ['an array', '[]\n', 'the output is not an object'],
    ['a number', '7\n', 'the output is not an object'],
  ])('refuses %s with fixed wording', (_label, stdout, problem) => {
    const r = parseControlResult(stdout, 64);
    expect(r).toEqual(unusable(problem));
    expect(JSON.stringify(r)).not.toContain('SECRET'); // never echoes what it could not parse
  });

  const valid = { kind: 'read', base64: b64('abc'), diagnostics: [] };
  it.each([
    ['an unknown kind', { ...valid, kind: 'maybe' }, 'kind is unknown'],
    ['a kind inherited from Object', { kind: 'toString', diagnostics: [] }, 'kind is unknown'],
    ['an extra field', { ...valid, extra: 1 }, 'the read result has the wrong fields'],
    [
      'a missing field',
      { kind: 'refused', reason: 'symlink', diagnostics: [] },
      'the refused result has the wrong fields',
    ],
    [
      'diagnostics that are not an array',
      { ...valid, diagnostics: {} },
      'diagnostics are malformed',
    ],
    ['a null diagnostic', refused('close_failed', null, [null]), 'diagnostics are malformed'],
    [
      'a diagnostic with an unknown step',
      refused('close_failed', null, [{ step: 'close_x', errno: null }]),
      'diagnostics are malformed',
    ],
    [
      'a diagnostic with an extra field',
      refused('close_failed', null, [{ ...closeFile, why: 'x' }]),
      'diagnostics are malformed',
    ],
    [
      'a diagnostic with a lowercase errno',
      refused('close_failed', null, [{ step: 'close_file', errno: 'ebadf' }]),
      'diagnostics are malformed',
    ],
    [
      'a diagnostic with a numeric errno',
      refused('close_failed', null, [{ step: 'close_file', errno: 9 }]),
      'diagnostics are malformed',
    ],
    ['an unknown reason', refused('confused', null), 'reason is unknown'],
    ['a malformed errno', refused('symlink', 'ELOOP loop'), 'errno is malformed'],
    ['a missing errno value', refused('symlink', ''), 'errno is malformed'],
    [
      'a close failure without diagnostics',
      refused('close_failed', null),
      'close_failed carries no diagnostics',
    ],
    [
      'a read with diagnostics',
      { ...valid, diagnostics: [closeFile] },
      'the read result carries diagnostics',
    ],
    [
      'a missing file with diagnostics',
      { kind: 'missing', diagnostics: [closeFile] },
      'the missing result carries diagnostics',
    ],
    ['base64 that is not a string', { ...valid, base64: 7 }, 'base64 is not a string'],
    ['invalid base64', { ...valid, base64: 'YWJj*' }, 'base64 is not canonical'],
    ['non-canonical base64', { ...valid, base64: 'YWJ=' }, 'base64 is not canonical'],
  ])('refuses %s, returning no bytes', (_label, output, problem) => {
    expect(parseControlResult(line(output), 64)).toEqual(unusable(problem));
  });

  it('accepts exactly cap bytes and refuses one more, even though the base64 itself is valid', () => {
    expect(
      parseControlResult(line({ kind: 'read', base64: b64('abcd'), diagnostics: [] }), 4),
    ).toEqual({ kind: 'read', bytes: Buffer.from('abcd') });
    expect(
      parseControlResult(line({ kind: 'read', base64: b64('abcde'), diagnostics: [] }), 4),
    ).toEqual(unusable('the bytes exceed the cap'));
  });
});
