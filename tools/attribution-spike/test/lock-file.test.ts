import { type ChildProcess, spawn as nodeSpawn, type spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runChild } from '../src/child.js';

/** The lock helper's acquire mode, on a real filesystem, bounded through `runChild`. */
const HELPER = fileURLToPath(new URL('../src/lock-file.py', import.meta.url));
const TOKEN = '0123456789abcdef0123456789abcdef';
const NONCE = 'fedcba9876543210fedcba9876543210';
const TEMP = `run.lock.tmp-${NONCE}`;
const RECORD = {
  runId: 'run-1',
  pid: 4_242,
  startedAt: '2026-09-17T08:30:00Z',
  token: TOKEN,
  nonce: NONCE,
};

interface Tracked {
  readonly child: ChildProcess;
  exit?: true;
}
const made: string[] = [];
const tracked: Tracked[] = [];
const running: Promise<unknown>[] = [];

/** Node's spawn, recording the child and its exit before anything is awaited. */
const trackingSpawn = ((command: string, args: string[], options: object) => {
  const child = nodeSpawn(command, args, options);
  const t: Tracked = { child };
  tracked.push(t);
  child.once('exit', () => (t.exit = true));
  return child;
}) as unknown as typeof spawn;

afterEach(async () => {
  const [children, results, dirs] = [tracked.splice(0), running.splice(0), made.splice(0)];
  await Promise.allSettled(results); // bounded by each run's deadline; a rejection skips nothing
  const unconfirmed: string[] = [];
  for (const t of children) {
    if (t.exit !== undefined) continue; // ended
    if (t.child.pid === undefined) continue; // never spawned: nothing to terminate
    try {
      t.child.kill('SIGKILL');
    } catch (cause) {
      unconfirmed.push(`pid ${String(t.child.pid)}: SIGKILL threw: ${String(cause)}`);
    }
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      t.child.once('exit', () => (clearTimeout(timer), resolve(true)));
    });
    if (!ended) unconfirmed.push(`pid ${String(t.child.pid)}: no exit within 2 s of SIGKILL`);
  }
  // a live helper could still write here, so the directories stay until every child is known gone
  if (unconfirmed.length > 0)
    throw new Error(`termination unconfirmed; kept ${dirs.join(', ')}: ${unconfirmed.join('; ')}`);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 30_000);
const control = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-lock-'));
  made.push(base);
  const dir = join(base, 'control');
  mkdirSync(dir);
  return { base, dir };
};

const acquire = async (
  dir: string,
  input: string | Uint8Array = JSON.stringify(RECORD),
  python?: string,
) => {
  const argv = [HELPER, '--dir', dir, '--mode', 'acquire'];
  const pending = runChild(python ?? 'python3', argv, {
    deadline: Date.now() + 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn: trackingSpawn,
    now: Date.now,
    maxOutputBytes: 64_000,
    input,
  });
  running.push(pending);
  const outcome = await pending;
  expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
  const { stdout, stderr } = (outcome as { evidence: { stdout: string; stderr: string } }).evidence;
  expect(stdout.indexOf('\n')).toBe(stdout.length - 1); // exactly one line
  for (const text of [stdout, stderr]) expect(text).not.toContain(TOKEN); // never token-bearing
  return { result: JSON.parse(stdout) as Record<string, unknown>, stderr };
};
const refused = (reason: string, errno: string | null = null, diagnostics: unknown[] = []) => ({
  kind: 'refused',
  reason,
  errno,
  diagnostics,
});
const entries = (dir: string) => ({
  lock: (() => {
    try {
      return readFileSync(join(dir, 'run.lock'), 'utf8');
    } catch {
      return undefined;
    }
  })(),
  temp: (() => {
    try {
      return readFileSync(join(dir, TEMP), 'utf8');
    } catch {
      return undefined;
    }
  })(),
});

describe('taking the run lock', () => {
  it('publishes a whole record, readable only by its owner, leaving no temporary file', async () => {
    const c = control();
    const { result } = await acquire(c.dir);
    expect(result).toEqual({ kind: 'acquired', diagnostics: [] });
    const lock = readFileSync(join(c.dir, 'run.lock'), 'utf8');
    expect(JSON.parse(lock)).toEqual({
      version: 1,
      runId: 'run-1',
      pid: 4_242,
      startedAt: '2026-09-17T08:30:00Z',
      token: TOKEN,
    });
    expect(lstatSync(join(c.dir, 'run.lock')).mode & 0o777).toBe(0o600);
    expect(entries(c.dir).temp).toBeUndefined();
  });

  it('reports a lock that is already there, and leaves it exactly as it was', async () => {
    const c = control();
    writeFileSync(join(c.dir, 'run.lock'), 'another run');
    const before = lstatSync(join(c.dir, 'run.lock'));
    const { result } = await acquire(c.dir);
    expect(result).toEqual({ kind: 'held', diagnostics: [] });
    expect(readFileSync(join(c.dir, 'run.lock'), 'utf8')).toBe('another run');
    expect(lstatSync(join(c.dir, 'run.lock')).ino).toBe(before.ino);
    expect(entries(c.dir).temp).toBeUndefined(); // our own temporary file is gone
  });

  it('refuses a temporary name that already exists, and never removes it', async () => {
    const c = control();
    writeFileSync(join(c.dir, TEMP), 'someone else');
    const before = lstatSync(join(c.dir, TEMP));
    const { result } = await acquire(c.dir);
    expect(result).toEqual(refused('temp_exists', 'EEXIST'));
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: 'someone else' });
    expect(lstatSync(join(c.dir, TEMP)).ino).toBe(before.ino);
  });

  /** A python3 that runs `patch` first; it is exec'd, so the helper stays the tracked process. */
  const shimmed = (base: string, name: string, patch: string) => {
    const shim = join(base, name);
    writeFileSync(
      shim,
      `#!/bin/sh\nexec python3 -c '\nimport errno, os, runpy, sys\n${patch}\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n' "$@"\n`,
      { mode: 0o755 },
    );
    return shim;
  };

  it('refuses a failed write, removing only the file it created', async () => {
    const c = control();
    const patch = [
      'real = os.write',
      'def failing(fd, data):',
      '    if fd < 3: return real(fd, data)  # the helper own output still works',
      '    raise OSError(errno.EIO, "io")',
      'os.write = failing',
    ].join('\n');
    const shim = shimmed(c.base, 'python3-write-fails', patch);
    expect((await acquire(c.dir, JSON.stringify(RECORD), shim)).result).toEqual(
      refused('write_failed', 'EIO'),
    );
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });

  it('refuses a missing flag instead of failing to start', async () => {
    const c = control();
    const shim = shimmed(c.base, 'python3-no-nofollow', 'del os.O_NOFOLLOW');
    expect((await acquire(c.dir, JSON.stringify(RECORD), shim)).result).toEqual(
      refused('capability'),
    );
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });

  const SENTINEL = 'SENTINEL-SECRET';
  const record = (over: object) => JSON.stringify({ ...RECORD, ...over });
  it.each([
    [
      'bytes that are not UTF-8',
      Buffer.concat([Buffer.from('{"runId":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    ],
    ['text that is not JSON', SENTINEL],
    ['an array', JSON.stringify([RECORD])],
    ['a number', '7'],
    // both values are valid: only duplicate detection can refuse this one
    ['a duplicate key', `{${record({}).slice(1, -1)}, "token": "${TOKEN.replace('0', 'f')}"}`],
    ['a missing key', JSON.stringify({ ...RECORD, token: undefined })],
    ['an unknown key', record({ [SENTINEL]: 1 })],
    ['a token of 31 characters', record({ token: TOKEN.slice(1) })],
    ['a token of 33 characters', record({ token: `${TOKEN}a` })],
    ['an uppercase token', record({ token: TOKEN.toUpperCase() })],
    ['a token with a trailing newline', record({ token: `${TOKEN}\n` })],
    ['a nonce that is not hex', record({ nonce: SENTINEL.padEnd(32, 'z') })],
    ['a runId with a separator', record({ runId: `a/${SENTINEL}` })],
    ['a pid of zero', record({ pid: 0 })],
    ['a fractional pid', record({ pid: 1.5 })],
    ['a boolean pid', record({ pid: true })],
    ['an impossible timestamp', record({ startedAt: '2026-02-30T00:00:00Z' })],
    ['a timestamp without Z', record({ startedAt: '2026-09-17T08:30:00' })],
  ])('refuses %s, publishing nothing', async (_label, input) => {
    const c = control();
    const { result, stderr } = await acquire(c.dir, input);
    expect(result).toEqual(refused('arguments'));
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
    for (const text of [JSON.stringify(result), stderr]) expect(text).not.toContain('SENTINEL');
  });

  it.each([
    [
      'one byte over the limit',
      ' '.repeat(4_096 - JSON.stringify(RECORD).length + 1),
      refused('arguments'),
      false,
    ],
    [
      'exactly the limit',
      ' '.repeat(4_096 - JSON.stringify(RECORD).length),
      { kind: 'acquired', diagnostics: [] },
      true,
    ],
  ])('handles input %s', async (_label, padding, expected, published) => {
    const c = control();
    const { result } = await acquire(c.dir, JSON.stringify(RECORD) + padding);
    expect(result).toEqual(expected);
    expect(entries(c.dir).lock === undefined).toBe(!published);
  });

  it('refuses when it is given no record at all', async () => {
    const c = control();
    expect((await acquire(c.dir, '')).result).toEqual(refused('arguments'));
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });
});
