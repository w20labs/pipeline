import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FirstRecord } from '../src/first-record.js';
import { claudeSlug } from '../src/lib.js';
import { type LaunchBinding, type RecordReader, sessionBoundTranscript } from '../src/session.js';

const U = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';
const ROOT = '/research/claude-config';
const SCRATCH = '/Users/someone/.cache/pipeline-04b-scratch';
const COMPONENTS = ['projects', claudeSlug(SCRATCH), `${U}.jsonl`];
const EXPECTED = join(ROOT, ...COMPONENTS);
const bound = (over: Partial<LaunchBinding> = {}): LaunchBinding => ({
  sessionId: U,
  configRoot: ROOT,
  scratch: SCRATCH,
  argv: ['claude', '--session-id', U, '--model', 'sonnet'],
  ...over,
});
const line = (fields: Record<string, unknown>) => `${JSON.stringify(fields)}\n`;
const VALID = line({ type: 'user', sessionId: U, cwd: SCRATCH });

/** A reader that answers with fixed evidence and logs every request, so a case can prove none. */
const reader = (answer: FirstRecord) => {
  const calls: [string, readonly string[]][] = [];
  const read: RecordReader = (root, components) => {
    calls.push([root, components]);
    return Promise.resolve(answer);
  };
  return { read, calls };
};
const bytes = (text: string): FirstRecord => ({
  ok: true,
  bytes: Buffer.from(text),
  newline: text.endsWith('\n'),
});

describe('owning a transcript by the session id its launch was given', () => {
  it('owns the expected file when a bound launch’s first record names that session', async () => {
    const r = reader(bytes(VALID));
    expect(await sessionBoundTranscript(bound(), new Set(), r.read)).toEqual({
      owned: true,
      path: EXPECTED,
      sessionId: U,
    });
    expect(r.calls).toEqual([[ROOT, COMPONENTS]]); // one file asked for, and only that one
  });

  const BINDING = 'the recorded launch was not bound to exactly this session id';
  const ABSOLUTE = 'the configuration root and working directory must be absolute';
  it.each([
    ['no --session-id at all', { argv: ['claude', '--model', 'sonnet'] }, BINDING],
    [
      'a different session id',
      { argv: ['claude', '--session-id', 'a0000000-0000-4000-8000-000000000000'] },
      BINDING,
    ],
    ['the flag given twice', { argv: ['claude', '--session-id', U, '--session-id', U] }, BINDING],
    [
      'a session id that is not a UUID',
      { sessionId: 'not-a-uuid', argv: ['claude', '--session-id', 'not-a-uuid'] },
      'the session id is not a UUID',
    ],
    ['a relative configuration root', { configRoot: 'research/claude-config' }, ABSOLUTE],
    ['a relative working directory', { scratch: '.cache/scratch' }, ABSOLUTE],
  ])('refuses %s without reading anything, however right the file looks', async (_l, over, why) => {
    // contents that say the right things are not ownership: the binding comes from the launch
    const r = reader(bytes(VALID));
    expect(await sessionBoundTranscript(bound(over), new Set(), r.read)).toEqual({
      owned: false,
      why,
    });
    expect(r.calls).toEqual([]);
  });

  it('refuses an expected path that existed before launch, without reading it', async () => {
    const r = reader(bytes(VALID));
    expect(await sessionBoundTranscript(bound(), new Set([EXPECTED]), r.read)).toEqual({
      owned: false,
      why: 'the expected transcript existed before launch',
      path: EXPECTED,
    });
    expect(r.calls).toEqual([]);
  });

  const NO_ID = 'the first record does not state this session id';
  it.each([
    ['no session id', line({ cwd: SCRATCH }), NO_ID],
    [
      'another session id',
      line({ sessionId: 'a0000000-0000-4000-8000-000000000000', cwd: SCRATCH }),
      NO_ID,
    ],
    [
      'another working directory',
      line({ sessionId: U, cwd: '/elsewhere' }),
      'the first record does not state this working directory',
    ],
    ['a record that is not JSON', 'not json\n', 'the first record is not JSON'],
    ['a record that is not an object', '["list"]\n', 'the first record is not an object'],
    [
      'no newline within the limit',
      VALID.trimEnd(),
      'no complete first record within the read limit',
    ],
  ])('leaves a first record with %s unproven', async (_label, content, why) => {
    const r = reader(bytes(content));
    expect(await sessionBoundTranscript(bound(), new Set(), r.read)).toEqual({
      owned: false,
      why,
      path: EXPECTED,
    });
  });

  it('passes a reader’s refusal through, keeping its diagnostics, and never reports ownership', async () => {
    const r = reader({
      ok: false,
      why: 'the helper could not release what it opened',
      diagnostics: ['Bad file descriptor'],
    });
    expect(await sessionBoundTranscript(bound(), new Set(), r.read)).toEqual({
      owned: false,
      why: 'the helper could not release what it opened',
      path: EXPECTED,
      diagnostics: ['Bad file descriptor'],
    });
  });
});
