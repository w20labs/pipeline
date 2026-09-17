import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  FIRST_RECORD_LIMIT,
  readFirstRecord,
  validateResponse,
  validComponent,
} from '../src/first-record.js';
import { productionReader } from '../src/session.js';

const LATER = () => Date.now() + 10_000;
const answer = (fields: Record<string, unknown>) =>
  JSON.stringify({ ok: true, closeErrors: [], ...fields });
const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('which path components the helper may be given', () => {
  it.each([['projects'], ['a-slug'], ['3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d.jsonl']])(
    'accepts %s',
    (part) => expect(validComponent(part)).toBe(true),
  );
  it.each([[''], ['.'], ['..'], ['a/b'], ['/abs'], ['a\\b'], ['a\0b']])('refuses %j', (part) =>
    expect(validComponent(part)).toBe(false),
  );

  it('refuses a bad component before any helper is started', async () => {
    let spawned = 0;
    const counting = ((...args: Parameters<typeof spawn>) => {
      spawned += 1;
      return spawn(...args);
    }) as typeof spawn;
    const result = await readFirstRecord('/root', ['projects', '..', 'x'], {
      deadline: LATER(),
      spawn: counting,
    });
    expect(result).toEqual({
      ok: false,
      why: 'a path component is empty, relative or contains a separator',
    });
    expect(spawned).toBe(0);
  });
});

describe('what the helper’s answer must agree with', () => {
  const SHAPE = 'the helper answered in an unexpected shape';
  it.each([
    ['not JSON', 'nope', 'the helper printed something that is not JSON'],
    ['a list', '[]', SHAPE],
    ['no closeErrors', JSON.stringify({ ok: true, count: 0, bytes: '', newline: false }), SHAPE],
    [
      'a count that is not an integer',
      answer({ count: 1.5, bytes: b64('x'), newline: false }),
      SHAPE,
    ],
    [
      'a byte count that disagrees with the bytes',
      answer({ count: 2, bytes: b64('x'), newline: false }),
      'the helper’s byte count does not match the bytes it returned',
    ],
    [
      'bytes that are not canonical base64',
      answer({ count: 1, bytes: 'eA', newline: false }),
      'the helper’s bytes are not canonical base64',
    ],
    [
      'more than the limit',
      answer({
        count: FIRST_RECORD_LIMIT + 1,
        bytes: b64('x'.repeat(FIRST_RECORD_LIMIT + 1)),
        newline: false,
      }),
      `the helper returned more than ${FIRST_RECORD_LIMIT} bytes`,
    ],
    [
      'a newline claimed but not at the end',
      answer({ count: 3, bytes: b64('a\nb'), newline: true }),
      'the helper’s newline report does not agree with its bytes',
    ],
    [
      'a newline claimed with none present',
      answer({ count: 2, bytes: b64('ab'), newline: true }),
      'the helper’s newline report does not agree with its bytes',
    ],
    [
      'no newline claimed with one present',
      answer({ count: 2, bytes: b64('a\n'), newline: false }),
      'the helper’s newline report does not agree with its bytes',
    ],
  ])('refuses %s', (_label, stdout, why) => {
    expect(validateResponse(stdout)).toEqual({ ok: false, why });
  });

  it('refuses an empty answer that claims a complete record', () => {
    // with no bytes there is no last byte, so "the newline is the last byte" cannot hold
    expect(validateResponse(answer({ count: 0, bytes: '', newline: true }))).toEqual({
      ok: false,
      why: 'the helper’s newline report does not agree with its bytes',
    });
  });

  it('accepts an empty answer that claims nothing — an empty file is simply incomplete', () => {
    expect(validateResponse(answer({ count: 0, bytes: '', newline: false }))).toEqual({
      ok: true,
      bytes: Buffer.alloc(0),
      newline: false,
    });
  });

  it('accepts a consistent answer', () => {
    expect(validateResponse(answer({ count: 3, bytes: b64('ab\n'), newline: true }))).toEqual({
      ok: true,
      bytes: Buffer.from('ab\n'),
      newline: true,
    });
  });

  it('refuses a clean read that could not be closed, keeping the diagnostic', () => {
    const stdout = JSON.stringify({
      ok: true,
      count: 3,
      bytes: b64('ab\n'),
      newline: true,
      closeErrors: ['Bad file descriptor'],
    });
    expect(validateResponse(stdout)).toEqual({
      ok: false,
      why: 'the helper could not release what it opened',
      diagnostics: ['Bad file descriptor'],
    });
  });

  it('keeps close diagnostics on a refusal too', () => {
    const stdout = JSON.stringify({
      ok: false,
      step: 'file',
      error: 'x: No such file or directory',
      closeErrors: ['Bad file descriptor'],
    });
    expect(validateResponse(stdout)).toEqual({
      ok: false,
      why: 'the helper stopped at file: x: No such file or directory',
      diagnostics: ['Bad file descriptor'],
    });
  });
});

describe('running the helper', () => {
  it('reports a missing python3 clearly, within the bound', async () => {
    const began = Date.now();
    const result = await readFirstRecord('/root', ['x'], {
      deadline: Date.now() + 5_000,
      python: '/nonexistent/python3',
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { why: string }).why).toMatch(
      /^python3 is required and could not be started: /,
    );
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it('never passes a barrier from the production reader, even if one is smuggled in', async () => {
    const argvs: string[][] = [];
    const recording = ((command: string, args: string[], options: object) => {
      argvs.push(args);
      return spawn(command, args, options);
    }) as unknown as typeof spawn;
    const smuggled = { spawn: recording, barrier: '/tmp/anything' } as unknown as Parameters<
      typeof productionReader
    >[1];
    await productionReader(Date.now() + 5_000, smuggled)('/nonexistent-root', ['x']);
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).not.toContain('--barrier');
  });
});
