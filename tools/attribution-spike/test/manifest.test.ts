import { describe, expect, it } from 'vitest';

import { MAX_MANIFEST_BYTES, validateManifest } from '../src/manifest.js';

const CONFIG = '/cache/research/claude-config';
const VALID = {
  version: 1,
  configPath: CONFIG,
  claudeVersion: '2.1.272 (Claude Code)',
  bootstrappedAt: '2026-09-17T08:30:00Z',
  separateAuthorization: 'unknown',
  bootstrapSessionClosed: true,
};
const text = (t: string) => validateManifest(Buffer.from(t, 'utf8'), CONFIG);
const manifest = (over: object = {}) => text(JSON.stringify({ ...VALID, ...over }));
const refused = (why: string) => ({ ok: false, why });

describe('validating the bootstrap manifest', () => {
  it.each([
    [{}, 'unknown', '2026-09-17T08:30:00Z'],
    [
      { separateAuthorization: true, bootstrappedAt: '2026-09-17T08:30:00.123Z' },
      true,
      '2026-09-17T08:30:00.123Z',
    ],
    [
      { separateAuthorization: false, bootstrappedAt: '2024-02-29T23:59:59.000Z' },
      false,
      '2024-02-29T23:59:59.000Z',
    ],
  ] as [object, boolean | string, string][])(
    'accepts %o, returning only the three evidence fields',
    (over, authorization, at) => {
      const r = manifest(over);
      expect(r).toEqual({
        ok: true,
        evidence: {
          claudeVersion: '2.1.272 (Claude Code)',
          bootstrappedAt: at,
          separateAuthorization: authorization,
        },
      });
      expect(r.ok && Object.isFrozen(r) && Object.isFrozen(r.evidence)).toBe(true);
    },
  );

  it('accepts exactly 16 KiB, padded with JSON whitespace, and refuses one byte more', () => {
    const body = JSON.stringify(VALID);
    const padded = body + ' '.repeat(MAX_MANIFEST_BYTES - body.length);
    expect(Buffer.byteLength(padded)).toBe(16 * 1024);
    expect(text(padded)).toMatchObject({ ok: true });
    expect(text(`${padded} `)).toEqual(refused('the manifest is larger than 16 KiB'));
  });

  it.each(['cache/research', '/cache/re\0search'])(
    'refuses the research configuration %j',
    (config) => {
      expect(validateManifest(Buffer.from(JSON.stringify(VALID)), config)).toEqual(
        refused('the research configuration must be an absolute path without NUL'),
      );
    },
  );

  it.each([
    ['a lone 0xFF', [0xff]],
    ['an overlong encoding', [0xc0, 0xaf]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a truncated sequence at the end', [0xe2, 0x82]],
  ])('refuses %s as not UTF-8', (_label, tail) => {
    const bytes = Buffer.concat([
      Buffer.from(JSON.stringify(VALID).slice(0, -1)),
      Buffer.from(tail),
      Buffer.from('}'),
    ]);
    expect(validateManifest(bytes, CONFIG)).toEqual(refused('the manifest is not valid UTF-8'));
  });

  it.each([
    ['a byte order mark', `\uFEFF${JSON.stringify(VALID)}`, 'the manifest is not JSON'],
    ['text that is not JSON', 'SENTINEL', 'the manifest is not JSON'],
    ['null', 'null', 'the manifest is not a JSON object'],
    ['an array', '[]', 'the manifest is not a JSON object'],
    ['a number', '1', 'the manifest is not a JSON object'],
    ['a string', '"SENTINEL"', 'the manifest is not a JSON object'],
  ])('refuses %s', (_label, t, why) => {
    expect(text(t)).toEqual(refused(why));
  });

  const body = JSON.stringify(VALID).slice(1, -1);
  it.each([
    ['the same key twice', `{${body}, "version": 1}`],
    ['a key repeated through an escape', `{${body}, "\\u0076ersion": 1}`],
    ['a closed session overriding an open one', `{"bootstrapSessionClosed": false, ${body}}`],
  ])('refuses %s', (_label, t) => {
    expect(text(t)).toEqual(refused('the manifest repeats a key'));
  });

  it('is not misled by keys inside strings or nested values', () => {
    // quotes, backslashes, braces and a "version" key inside a string value are part of that value
    const tricky = '2.1 " \\ {"version": 1, "configPath": "/x"}';
    expect(manifest({ claudeVersion: tricky })).toMatchObject({ ok: true });
    // a nested object's keys are not top-level keys; the value itself is simply wrong
    expect(
      manifest({ separateAuthorization: { version: 1, bootstrapSessionClosed: true } }),
    ).toEqual(refused('separateAuthorization must be true, false or "unknown"'));
  });

  it('refuses keys outside the schema without naming them', () => {
    expect(manifest({ SENTINEL: 1 })).toEqual(refused('the manifest has keys outside its schema'));
  });

  it.each(Object.keys(VALID))('names %s when it is missing', (key) => {
    const partial: Record<string, unknown> = { ...VALID };
    delete partial[key];
    expect(text(JSON.stringify(partial))).toEqual(refused(`the manifest is missing ${key}`));
  });

  /** A version carrying one line-unsafe character, built by code so none is literal in this file. */
  const unsafe = (code: number) => `SENTINEL${String.fromCharCode(code)}forged`;
  const VALUE_REFUSALS: [string, object, string][] = [
    ['version 2', { version: 2 }, 'version must be 1'],
    ['version "1"', { version: '1' }, 'version must be 1'],
    ['version 1.5', { version: 1.5 }, 'version must be 1'],
    [
      'another configPath',
      { configPath: '/SENTINEL' },
      'configPath does not name this research configuration',
    ],
    [
      'a numeric configPath',
      { configPath: 7 },
      'configPath does not name this research configuration',
    ],
    [
      'an open bootstrap session',
      { bootstrapSessionClosed: false },
      'the bootstrap session is not recorded as closed',
    ],
    [
      'a closed session as a string',
      { bootstrapSessionClosed: 'true' },
      'the bootstrap session is not recorded as closed',
    ],
    [
      'an empty version',
      { claudeVersion: '' },
      'claudeVersion must be a string of 1 to 128 characters',
    ],
    [
      'a numeric version',
      { claudeVersion: 2 },
      'claudeVersion must be a string of 1 to 128 characters',
    ],
    [
      'a 129-character version',
      { claudeVersion: 'S'.repeat(129) },
      'claudeVersion must be a string of 1 to 128 characters',
    ],
    ...[0x0a, 0x0d, 0x2028, 0x2029, 0x00, 0x7f].map(
      (code) =>
        [
          `a version with character ${code.toString(16)}`,
          { claudeVersion: unsafe(code) },
          'claudeVersion contains a control character',
        ] as [string, object, string],
    ),
    [
      'authorization "yes"',
      { separateAuthorization: 'SENTINEL' },
      'separateAuthorization must be true, false or "unknown"',
    ],
    [
      'authorization null',
      { separateAuthorization: null },
      'separateAuthorization must be true, false or "unknown"',
    ],
  ];
  it.each(VALUE_REFUSALS)('refuses %s', (_label, over, why) => {
    expect(manifest(over)).toEqual(refused(why));
  });

  const TIMES = [
    ['February 30', '2026-02-30T00:00:00Z'],
    ['February 29 in a common year', '2025-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-09-17T24:00:00Z'],
    ['a leap second', '2016-12-31T23:59:60Z'],
    ['minute 60', '2026-09-17T08:60:00Z'],
    ['no Z', '2026-09-17T08:30:00'],
    ['an offset', '2026-09-17T08:30:00+02:00'],
    ['lowercase t and z', '2026-09-17t08:30:00z'],
    ['two fractional digits', '2026-09-17T08:30:00.12Z'],
    ['four fractional digits', '2026-09-17T08:30:00.1234Z'],
    ['surrounding spaces', ' 2026-09-17T08:30:00Z '],
    ['a date only', '2026-09-17'],
    ['garbage', 'SENTINEL'],
  ];
  it.each(TIMES)('refuses a bootstrappedAt with %s', (_label, bootstrappedAt) => {
    expect(manifest({ bootstrappedAt })).toEqual(
      refused('bootstrappedAt must be a real UTC time in ISO 8601 form'),
    );
  });

  it('never echoes rejected content: keys, values or malformed text', () => {
    const results = [
      text('SENTINEL'),
      text('"SENTINEL"'),
      manifest({ SENTINEL: 'SENTINEL' }),
      ...VALUE_REFUSALS.map(([, over]) => manifest(over)),
      ...TIMES.map(([, bootstrappedAt]) => manifest({ bootstrappedAt })),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('SENTINEL');
      expect(JSON.stringify(r)).not.toContain('forged');
    }
  });
});
