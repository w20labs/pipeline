import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runChild } from '../src/child.js';
import { SNAPSHOT_HELPER, takeSnapshot } from '../src/snapshot.js';

const LIMITS = { cap: 10, maxOutputBytes: 100_000, maxLineBytes: 4_096 };
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const entry = (path: string) =>
  line({ type: 'entry', path, kind: 'file', size: '1', mtimeNs: '1', dev: '1', ino: '1' });
const done = (entries: number) => line({ type: 'done', entries, diagnostics: 0, complete: true });
const VALID = entry('a') + done(1);

interface Script {
  stdout?: string;
  stderr?: string;
  exit?: number | null;
  signal?: string | null;
  /** 'close' (default): exit then close. 'exit-only': exit, pipes held open. 'never': no end at all. */
  end?: 'close' | 'exit-only' | 'never';
  /** Write the valid stream and exit 0 only once asked to stop. */
  exitOnSigterm?: boolean;
  throws?: Error;
}

/** A helper that answers as scripted and records how it was invoked. */
const fakeHelper = (script: Script) => {
  const argv: string[][] = [];
  let spawns = 0;
  const stub = ((_cmd: string, args: string[]) => {
    spawns += 1;
    argv.push(args);
    if (script.throws !== undefined) throw script.throws;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      unref: () => undefined,
      kill: (signal: string) => {
        if (signal === 'SIGTERM' && script.exitOnSigterm === true)
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from(VALID));
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
          });
        return true;
      },
    });
    queueMicrotask(() => {
      child.emit('spawn');
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.exitOnSigterm === true || script.end === 'never') return;
      child.emit('exit', script.exit ?? 0, script.signal ?? null);
      if (script.end !== 'exit-only') child.emit('close', script.exit ?? 0, script.signal ?? null);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawn: stub, argv, spawns: () => spawns };
};

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.useRealTimers();
});
const tree = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-take-snapshot-'));
  made.push(base);
  mkdirSync(join(base, 'projects'));
  writeFileSync(join(base, 'projects', 'a.jsonl'), 'abc');
  symlinkSync('/etc', join(base, 'link'));
  return base;
};

describe('taking a snapshot with the real helper', () => {
  it('is complete, exact to the bigint, and frozen throughout', async () => {
    const root = tree();
    const s = await takeSnapshot(root, { ...LIMITS, deadline: Date.now() + 10_000 });
    expect(s).toMatchObject({ complete: true, problems: [], helperDiagnostics: [] });
    expect(s.entries.map((e) => e.path)).toEqual(['link', 'projects', 'projects/a.jsonl']);
    for (const e of s.entries) {
      const st = lstatSync(join(root, e.path), { bigint: true });
      expect([e.size, e.mtimeNs, e.dev, e.ino]).toEqual([st.size, st.mtimeNs, st.dev, st.ino]);
    }
    for (const frozen of [s, s.entries, s.problems, s.helperDiagnostics, s.entries[0]])
      expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('keeps an entry that fit before an output overflow, and is incomplete', async () => {
    const root = tree();
    // The helper's own first line, measured from an unbounded raw run — Python's JSON spacing differs
    // from JSON.stringify's. Nothing in the tree changes between runs, so the line is the same length.
    const raw = await runChild('python3', [SNAPSHOT_HELPER, '--root', root, '--cap', '10'], {
      deadline: Date.now() + 10_000,
      termGraceMs: 200,
      killGraceMs: 200,
      spawn,
      now: Date.now,
    });
    const stdout = (raw as { evidence: { stdout: string } }).evidence.stdout;
    const firstLineBytes = Buffer.byteLength(stdout.slice(0, stdout.indexOf('\n') + 1));
    const s = await takeSnapshot(root, {
      ...LIMITS,
      maxOutputBytes: firstLineBytes + 8, // the whole first entry, and a few bytes into the next
      deadline: Date.now() + 10_000,
    });
    expect(s.complete).toBe(false);
    expect(s.problems).toContain('the helper exceeded maxOutputBytes');
    expect(s.entries.map((e) => e.path)).toEqual(['link']); // exactly the entry that fit
  });
});

describe('what the helper’s termination adds', () => {
  const take = (script: Script, over = {}) => {
    const h = fakeHelper(script);
    return takeSnapshot('/root', {
      ...LIMITS,
      deadline: Date.now() + 10_000,
      spawn: h.spawn,
      ...over,
    }).then((s) => ({ s, h }));
  };

  it.each([
    ['a relative root', 'root', {}, 'the root must be an absolute path without NUL'],
    ['a root with NUL', '/ro\0ot', {}, 'the root must be an absolute path without NUL'],
    [
      'a zero cap',
      '/root',
      { cap: 0 },
      'cap, maxOutputBytes and maxLineBytes must be positive safe integers',
    ],
    [
      'a fractional cap',
      '/root',
      { cap: 1.5 },
      'cap, maxOutputBytes and maxLineBytes must be positive safe integers',
    ],
    [
      'a negative output bound',
      '/root',
      { maxOutputBytes: -1 },
      'cap, maxOutputBytes and maxLineBytes must be positive safe integers',
    ],
    [
      'a zero line bound',
      '/root',
      { maxLineBytes: 0 },
      'cap, maxOutputBytes and maxLineBytes must be positive safe integers',
    ],
    [
      'a non-finite deadline',
      '/root',
      { deadline: Number.POSITIVE_INFINITY },
      'the deadline must be finite',
    ],
  ])('refuses %s without spawning', async (_label, root, over, problem) => {
    const h = fakeHelper({ stdout: VALID });
    const s = await takeSnapshot(root, {
      ...LIMITS,
      deadline: Date.now() + 10_000,
      spawn: h.spawn,
      ...over,
    });
    expect(s).toEqual({ complete: false, entries: [], helperDiagnostics: [], problems: [problem] });
    expect(h.spawns()).toBe(0);
  });

  it.each([
    ['exit 1 after a valid stream', { stdout: VALID, exit: 1 }, 'the helper exited 1'],
    [
      'a signal after a valid stream',
      { stdout: VALID, exit: null, signal: 'SIGSEGV' },
      'the helper was killed by SIGSEGV',
    ],
    [
      'stderr beside a valid stream',
      { stdout: VALID, stderr: 'warning\n' },
      'the helper wrote to stderr',
    ],
  ])('is incomplete with %s, keeping the entries', async (_label, script, problem) => {
    const { s } = await take(script);
    expect(s.complete).toBe(false);
    expect(s.problems[0]).toBe(problem); // termination first
    expect(s.entries.map((e) => e.path)).toEqual(['a']);
  });

  it.each([
    [
      'a spawn failure',
      { throws: new Error('spawn python3 ENOENT') },
      {},
      'the helper did not run: spawn python3 ENOENT',
    ],
    [
      'a deadline already passed',
      { stdout: VALID },
      { deadline: Date.now() - 1 },
      'the helper did not run: the deadline had already passed; nothing was spawned',
    ],
  ])('is incomplete after %s', async (_label, script, over, problem) => {
    const { s } = await take(script, over);
    expect(s.complete).toBe(false);
    expect(s.problems[0]).toBe(problem);
    expect(s.entries).toEqual([]);
  });

  it('passes the same cap to the helper and to the stream check', async () => {
    const { s, h } = await take({ stdout: entry('a') + entry('b') + done(2) }, { cap: 1 });
    expect(h.argv).toEqual([[SNAPSHOT_HELPER, '--root', '/root', '--cap', '1']]);
    expect(s.problems).toEqual(['line 2: more entries than the cap']);
    expect(s.complete).toBe(false); // a clean exit does not rescue an invalid stream
  });

  /** Take a snapshot whose caller loosens one limit as soon as the helper has been dispatched. */
  const loosenedWhilePending = async (stdout: string, start: object, loosened: object) => {
    const h = fakeHelper({ stdout });
    const options = { ...LIMITS, deadline: Date.now() + 10_000, ...start } as Record<
      string,
      unknown
    >;
    options.spawn = ((...args: Parameters<typeof spawn>) => {
      const child = h.spawn(...args);
      Object.assign(options, loosened);
      return child;
    }) as typeof spawn;
    const s = await takeSnapshot('/root', options as unknown as Parameters<typeof takeSnapshot>[1]);
    expect(options).toMatchObject(loosened); // the change really landed before the stream was checked
    return { s, h };
  };

  it('checks the stream against the cap it dispatched, not one changed during the query', async () => {
    const { s, h } = await loosenedWhilePending(
      entry('a') + entry('b') + done(2),
      { cap: 1 },
      { cap: 2 },
    );
    expect(h.argv).toEqual([[SNAPSHOT_HELPER, '--root', '/root', '--cap', '1']]);
    expect(s.complete).toBe(false);
    expect(s.problems).toEqual(['line 2: more entries than the cap']);
  });

  it('checks line lengths against the bound it started with, not one changed during the query', async () => {
    const bound = Buffer.byteLength(entry('a')) - 2; // one byte short of the entry line
    const { s } = await loosenedWhilePending(
      VALID,
      { maxLineBytes: bound },
      { maxLineBytes: 4_096 },
    );
    expect(s.complete).toBe(false);
    expect(s.problems).toEqual([
      `line 1: longer than ${String(bound)} bytes`,
      'done.entries does not match the entries sent',
    ]);
  });

  describe('on controlled time', () => {
    const D = 1_000_000 + 10_000;
    const clocked = (script: Script) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.setSystemTime(1_000_000);
      const h = fakeHelper(script);
      const state: { s?: Awaited<ReturnType<typeof takeSnapshot>> } = {};
      void takeSnapshot('/root', { ...LIMITS, deadline: D, spawn: h.spawn }).then(
        (s) => (state.s = s),
      );
      return state;
    };

    it('is incomplete when a helper caught SIGTERM and exited 0 with a valid stream', async () => {
      const state = clocked({ exitOnSigterm: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.s).toMatchObject({
        complete: false,
        problems: ['the helper was signalled to stop'],
      });
      expect(state.s?.entries.map((e) => e.path)).toEqual(['a']); // the stream itself was valid
    });

    it('is incomplete when the helper exited but its pipes stayed open, keeping its entries', async () => {
      const state = clocked({ stdout: VALID, end: 'exit-only' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.s?.complete).toBe(false);
      expect(state.s?.problems[0]).toBe('the helper ended exited');
      expect(state.s?.entries.map((e) => e.path)).toEqual(['a']);
    });

    it('keeps what a hanging helper streamed, and is incomplete at the deadline', async () => {
      const state = clocked({ stdout: entry('a') + entry('b'), end: 'never' });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(state.s).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.s?.problems).toEqual([
        'the helper ended unterminated',
        'the helper was signalled to stop',
        'the stream has no done',
      ]);
      expect(state.s?.entries.map((e) => e.path)).toEqual(['a', 'b']);
    });
  });
});
