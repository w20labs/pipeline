import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { type ControlResult, maxOutputBytesFor, readControlFile } from '../src/control-file.js';
import { manifestPhase } from '../src/manifest.js';

const CONFIG = '/cache/research/claude-config';
const CONTROL = '/cache/research/control';
const MANIFEST = {
  version: 1,
  configPath: CONFIG,
  claudeVersion: '2.1.272',
  bootstrappedAt: '2026-09-17T08:30:00Z',
  separateAuthorization: false,
  bootstrapSessionClosed: true,
};
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const readOf = (text: string) =>
  line({ kind: 'read', base64: Buffer.from(text).toString('base64'), diagnostics: [] });

interface Script {
  stdout?: string;
  stderr?: string;
  exit?: number | null;
  signal?: string | null;
  throws?: Error;
  /** Never exit on its own; exit once signalled. */
  untilSignalled?: boolean;
}
/** A fake helper process: scripted output and ending, so the real wrapper produces the problems. */
const fakeSpawn = (script: Script) =>
  (() => {
    if (script.throws !== undefined) throw script.throws;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      unref: () => undefined,
      kill: () => (
        queueMicrotask(() => (child.emit('exit', 0, null), child.emit('close', 0, null))),
        true
      ),
    });
    queueMicrotask(() => {
      if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout));
      child.emit('spawn');
      if (script.untilSignalled === true) return;
      const exit = script.exit === undefined ? 0 : script.exit;
      child.emit('exit', exit, script.signal ?? null);
      child.emit('close', exit, script.signal ?? null);
    });
    return child;
  }) as unknown as typeof spawn;
/** The real wrapper, reading through a fake helper. */
const through =
  (script: Script): typeof readControlFile =>
  (dir, name, options) =>
    readControlFile(dir, name, { ...options, spawn: fakeSpawn(script) });
const run = (read: typeof readControlFile, controlDir = CONTROL) =>
  manifestPhase({ controlDir, researchConfig: CONFIG }, read).run({
    runDir: '/runs/r',
    deadline: Date.now() + 10_000,
  });
const unreadable = (detail: string) => ({
  kind: 'refused',
  why: `the bootstrap manifest could not be read: ${detail}`,
});

describe('the manifest phase', () => {
  it('reads bootstrap.json from the copied control directory, once, with the phase deadline and the manifest cap', async () => {
    const calls: unknown[][] = [];
    const locations = { controlDir: CONTROL, researchConfig: CONFIG };
    const phase = manifestPhase(
      locations,
      async (...args) => (
        calls.push(args),
        { kind: 'read', bytes: Buffer.from(JSON.stringify(MANIFEST)) }
      ),
    );
    Object.assign(locations, { controlDir: '/elsewhere', researchConfig: '/elsewhere' }); // after construction
    expect(await phase.run({ runDir: '/runs/r', deadline: 12_345 })).toEqual({
      kind: 'completed',
      evidence: {
        claudeVersion: '2.1.272',
        bootstrappedAt: '2026-09-17T08:30:00Z',
        separateAuthorization: false,
      },
    });
    expect(calls).toEqual([[CONTROL, 'bootstrap.json', { deadline: 12_345, cap: 16_384 }]]);
  });

  it.each([
    [
      'missing',
      line({ kind: 'missing', diagnostics: [] }),
      { kind: 'refused', why: 'the bootstrap manifest is missing' },
    ],
    [
      'a symlink',
      line({ kind: 'refused', reason: 'symlink', errno: 'ELOOP', diagnostics: [] }),
      unreadable('the helper refused (symlink, ELOOP)'),
    ],
    [
      'not a regular file',
      line({ kind: 'refused', reason: 'not_regular', errno: null, diagnostics: [] }),
      unreadable('the helper refused (not_regular)'),
    ],
    [
      'too large',
      line({ kind: 'refused', reason: 'too_large', errno: null, diagnostics: [] }),
      unreadable('the helper refused (too_large)'),
    ],
    [
      'a failed close',
      line({
        kind: 'refused',
        reason: 'close_failed',
        errno: null,
        diagnostics: [{ step: 'close_file', errno: 'EBADF' }],
      }),
      unreadable('the helper refused (close_failed); close failed: close_file EBADF'),
    ],
  ])('refuses a manifest that is %s, in fixed words', async (_label, stdout, expected) => {
    expect(await run(through({ stdout }))).toEqual(expected);
  });

  it.each([
    [
      'a spawn failure',
      { throws: new Error('spawn /SENTINEL/python3 ENOENT') },
      'did not run, invalid output',
    ],
    ['exit 1', { stdout: readOf('{}'), exit: 1 }, 'exited 1'],
    [
      'a signal',
      { stdout: readOf('{}'), exit: null, signal: 'SIGSEGV' },
      'killed by SIGSEGV, exited null',
    ],
    ['stderr', { stdout: readOf('{}'), stderr: 'SENTINEL\n' }, 'wrote to stderr'],
    [
      'output past its bound',
      { stdout: 'x'.repeat(maxOutputBytesFor(16_384) + 1) },
      'ended early, exceeded its output bound, invalid output',
    ],
    [
      'output past its bound until signalled',
      { stdout: 'x'.repeat(maxOutputBytesFor(16_384) + 1), untilSignalled: true },
      'ended early, signalled to stop, exceeded its output bound, invalid output',
    ],
    ['output that is not JSON', { stdout: 'SENTINEL\n' }, 'invalid output'],
  ] as [string, Script, string][])(
    'keeps the category of %s, and none of its text',
    async (_label, script, categories) => {
      const r = await run(through(script));
      expect(r).toEqual(unreadable(categories));
      expect(JSON.stringify(r)).not.toContain('SENTINEL');
    },
  );

  it('names a request the wrapper refused before spawning', async () => {
    expect(await run(through({}), 'control')).toEqual(unreadable('invalid request'));
  });

  it('refuses a manifest that was read but is invalid, with the validator’s fixed reason', async () => {
    const body = JSON.stringify(MANIFEST).slice(1, -1);
    expect(await run(through({ stdout: readOf(`{${body}, "version": 1}`) }))).toEqual({
      kind: 'refused',
      why: 'the bootstrap manifest is invalid: the manifest repeats a key',
    });
  });

  /** A reader that answers `unusable` with exactly these problems, for cases the wrapper cannot produce. */
  const answering =
    (...problems: string[]): typeof readControlFile =>
    async () =>
      ({ kind: 'unusable', problems }) as ControlResult;
  it.each([
    ['no problems at all', [], 'unrecognized'],
    [
      'repeated categories',
      [
        'the helper ended exited',
        'the helper ended unterminated',
        'the output is not JSON',
        'the output is not an object',
      ],
      'ended early, invalid output',
    ],
    ['text it does not know', ['SENTINEL'], 'unrecognized'],
    ['a signal with trailing space', ['the helper was killed by SIGTERM '], 'unrecognized'],
    ['a lowercase signal', ['the helper was killed by sigterm'], 'unrecognized'],
    ['a signal followed by text', ['the helper was killed by SIGTERM SENTINEL'], 'unrecognized'],
    ['an exit code followed by text', ['the helper exited 1x'], 'unrecognized'],
    ['an exit code with trailing space', ['the helper exited 1 '], 'unrecognized'],
    ['an empty exit code', ['the helper exited '], 'unrecognized'],
    ['a known problem with trailing text', ['the helper wrote to stderr SENTINEL'], 'unrecognized'],
    ['a did-not-run detail', ['the helper did not run: SENTINEL'], 'did not run'],
    [
      'text that only mentions not running',
      ['SENTINEL: the helper did not run: x'],
      'unrecognized',
    ],
  ] as [string, string[], string][])('sanitizes %s', async (_label, problems, categories) => {
    const r = await run(answering(...problems));
    expect(r).toEqual(unreadable(categories));
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });

  it.each([
    [
      'throws synchronously',
      (() => {
        throw new Error('SENTINEL');
      }) as typeof readControlFile,
    ],
    ['rejects', (() => Promise.reject(new Error('SENTINEL'))) as typeof readControlFile],
  ])('refuses in fixed words when the reader %s', async (_label, read) => {
    expect(await run(read)).toEqual({
      kind: 'refused',
      why: 'the bootstrap manifest reader failed unexpectedly',
    });
  });
});
