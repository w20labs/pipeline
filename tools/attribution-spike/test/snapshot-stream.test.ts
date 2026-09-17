import { describe, expect, it } from 'vitest';

import { parseSnapshotStream } from '../src/snapshot-stream.js';

const LIMITS = { cap: 10, maxLineBytes: 1_000 };
const entry = (path: string, over: Record<string, unknown> = {}) => ({
  type: 'entry',
  path,
  kind: 'file',
  size: '3',
  mtimeNs: '1789615372448465125',
  dev: '16777232',
  ino: '18446744073709551615', // larger than any JSON number keeps exactly
  ...over,
});
const diagnostic = (message: string) => ({ type: 'diagnostic', message });
const done = (entries: number, diagnostics = 0, complete = true) => ({
  type: 'done',
  entries,
  diagnostics,
  complete,
});
/** Records as the helper writes them: one JSON object per line, each ending in a newline. */
const stream = (...records: unknown[]) =>
  records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const parse = (stdout: string, limits = LIMITS) => parseSnapshotStream(stdout, limits);

describe('a well-formed stream', () => {
  it('is protocol-complete, with exact bigint metadata, and frozen throughout', () => {
    const result = parse(stream(entry('a'), entry('a/b', { kind: 'dir' }), done(2)));
    expect(result.protocolComplete).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.entries[0]).toEqual({
      path: 'a',
      kind: 'file',
      size: 3n,
      mtimeNs: 1789615372448465125n,
      dev: 16777232n,
      ino: 18446744073709551615n,
    });
    for (const frozen of [
      result,
      result.entries,
      result.helperDiagnostics,
      result.problems,
      result.entries[0],
    ])
      expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('carries a helper’s own incomplete report and its diagnostics, finding nothing wrong', () => {
    const result = parse(
      stream(entry('a'), diagnostic('cap_reached: stopped after 1 entries'), done(1, 1, false)),
    );
    expect(result).toMatchObject({ protocolComplete: false, problems: [] });
    expect(result.helperDiagnostics).toEqual(['cap_reached: stopped after 1 entries']);
  });
});

describe('what the parser refuses', () => {
  it.each([
    ['not JSON', stream('{nope', done(0)), 'line 1: not JSON'],
    ['an array', stream('[]', done(0)), 'line 1: not an object'],
    ['an unknown type', stream({ type: 'note' }, done(0)), 'line 1: unknown record type'],
    [
      'an entry missing a field',
      stream({ ...entry('a'), ino: undefined }, done(1)),
      'line 1: entry fields',
    ],
    [
      'an entry with an extra field',
      stream(entry('a', { mode: '644' }), done(1)),
      'line 1: entry fields',
    ],
    ['an unknown kind', stream(entry('a', { kind: 'socket' }), done(1)), 'line 1: entry kind'],
    ['a JSON number', stream(entry('a', { size: 3 }), done(1)), 'line 1: entry numbers'],
    ['a leading zero', stream(entry('a', { dev: '016' }), done(1)), 'line 1: entry numbers'],
    ['a negative', stream(entry('a', { size: '-1' }), done(1)), 'line 1: entry numbers'],
    ['a fraction', stream(entry('a', { mtimeNs: '1.5' }), done(1)), 'line 1: entry numbers'],
    ['an absolute path', stream(entry('/etc'), done(1)), 'line 1: entry path'],
    ['an empty path', stream(entry(''), done(1)), 'line 1: entry path'],
    ['a . segment', stream(entry('a/./b'), done(1)), 'line 1: entry path'],
    ['a .. segment', stream(entry('a/../b'), done(1)), 'line 1: entry path'],
    ['an empty segment', stream(entry('a//b'), done(1)), 'line 1: entry path'],
    ['a backslash', stream(entry('a\\b'), done(1)), 'line 1: entry path'],
    ['a NUL', stream(entry('a\0b'), done(1)), 'line 1: entry path'],
    [
      'a diagnostic with an extra field',
      stream({ ...diagnostic('x'), at: 1 }, done(0, 1, false)),
      'line 1: diagnostic fields',
    ],
    ['a record after done', stream(done(0), entry('a')), 'line 2: a record after done'],
    ['a second done', stream(done(0), done(0)), 'line 2: a record after done'],
    ['a missing done', stream(entry('a')), 'the stream has no done'],
    ['an empty stream', '', 'the stream has no done'],
    ['a done with an extra field', stream({ ...done(0), at: 1 }), 'done fields'],
    ['a non-boolean complete', stream({ ...done(0), complete: 'yes' }), 'done fields'],
    ['a fractional count', stream({ ...done(0), entries: 0.5 }), 'done fields'],
    [
      'an entries count that disagrees',
      stream(entry('a'), done(2)),
      'done.entries does not match the entries sent',
    ],
    [
      'a diagnostics count that disagrees',
      stream(diagnostic('x'), done(0, 0, false)),
      'done.diagnostics does not match the diagnostics sent',
    ],
    [
      'complete claimed with diagnostics',
      stream(diagnostic('x'), done(0, 1, true)),
      'done claims complete while reporting diagnostics',
    ],
  ])('refuses %s', (_label, stdout, problem) => {
    const result = parse(stdout);
    expect(result.problems).toContain(problem);
    expect(result.protocolComplete).toBe(false);
  });

  it('refuses a trailing partial line, even after a valid done', () => {
    const result = parse(`${stream(done(0))}{"type": "ent`);
    expect(result.problems).toEqual(['the stream ends with a partial line']);
    expect(result.protocolComplete).toBe(false);
  });

  it('keeps the first of a duplicated path, and refuses the second', () => {
    const result = parse(stream(entry('a', { size: '1' }), entry('a', { size: '2' }), done(2)));
    expect(result.entries.map((e) => e.size)).toEqual([1n]);
    expect(result.problems).toEqual(['line 2: duplicate path a']);
  });

  it('refuses entries past the cap, keeping those within it', () => {
    const result = parse(stream(entry('a'), entry('b'), entry('c'), done(3)), {
      cap: 2,
      maxLineBytes: 1_000,
    });
    expect(result.entries.map((e) => e.path)).toEqual(['a', 'b']);
    expect(result.problems).toEqual(['line 3: more entries than the cap']);
  });

  it('keeps valid entries alongside a problem elsewhere', () => {
    const result = parse(stream(entry('a'), '{nope', entry('b'), done(2)));
    expect(result.entries.map((e) => e.path)).toEqual(['a', 'b']);
    expect(result.protocolComplete).toBe(false);
  });

  it.each([
    ['a cap of zero', { cap: 0, maxLineBytes: 1_000 }],
    ['a fractional line bound', { cap: 10, maxLineBytes: 1.5 }],
  ])('refuses %s before reading anything', (_label, limits) => {
    const result = parse(stream(entry('a'), done(1)), limits);
    expect(result).toMatchObject({ protocolComplete: false, entries: [] });
    expect(result.problems).toEqual(['the stream limits must be positive safe integers']);
  });
});

describe('the line bound, in UTF-8 bytes without the newline', () => {
  const line = JSON.stringify(entry('é')); // é is 2 bytes but 1 UTF-16 code unit
  const bytes = Buffer.byteLength(line, 'utf8');

  it('accepts a line of exactly the bound, its newline not counted', () => {
    expect(line.length).toBe(bytes - 1); // the character count would undercount it
    expect(parse(stream(line, done(1)), { cap: 10, maxLineBytes: bytes }).protocolComplete).toBe(
      true,
    );
  });

  it('refuses one byte more, where counting characters would have let it through', () => {
    const result = parse(stream(line, done(1)), { cap: 10, maxLineBytes: bytes - 1 });
    expect(result.problems).toContain(`line 1: longer than ${bytes - 1} bytes`);
  });
});
