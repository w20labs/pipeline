import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireLockBounded,
  type AcquireOptions,
  type LockHandle,
  type LockOwner,
  type RandomSource,
  releaseLockBounded,
} from '../src/lock.js';

/** The real helper through the wrapper. Every process here is the test's own child. */

interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
interface Tracked {
  readonly child: ChildProcess;
  readonly kills: string[];
  exit?: Ended;
  close?: Ended;
  error?: Error;
}

let tracked: Tracked[] = [];
let pending: Promise<unknown>[] = [];
let dirs: string[] = [];

/** Node's spawn, with the child and its exit, close, error and kill calls recorded before anything is awaited. */
const trackingSpawn = ((command: string, args: string[], options: object) => {
  const child = spawn(command, args, options);
  const t: Tracked = { child, kills: [] };
  tracked.push(t);
  child.once('exit', (code, signal) => (t.exit = { code, signal }));
  child.once('close', (code, signal) => (t.close = { code, signal }));
  child.once('error', (error) => (t.error = error));
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    t.kills.push(String(signal));
    return kill(signal);
  };
  return child;
}) as unknown as typeof spawn;

afterEach(async () => {
  const [children, results, created] = [tracked, pending, dirs];
  [tracked, pending, dirs] = [[], [], []];
  await Promise.allSettled(results); // each is bounded by its own deadline; a rejection skips nothing
  const unconfirmed: string[] = [];
  for (const t of children) {
    // ended, or never started at all: an error alone does not mean a started process is gone
    if (
      t.exit !== undefined ||
      t.close !== undefined ||
      (t.error !== undefined && t.child.pid === undefined)
    )
      continue;
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
  // a directory is removed only once every child that could still use it is known to have ended
  if (unconfirmed.length > 0)
    throw new Error(
      `termination unconfirmed; kept ${created.join(', ')}: ${unconfirmed.join('; ')}`,
    );
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
}, 30_000);

const STARTED_AT = '2026-09-17T08:30:00Z';
const TOKEN_A = 'a1'.repeat(16);
const NONCE_A = 'a2'.repeat(16);
const TOKEN_B = 'b1'.repeat(16);
const NONCE_B = 'b2'.repeat(16);
const owner = (runId: string): LockOwner => ({ runId, pid: process.pid, startedAt: STARTED_AT });
/** Known secrets, so the file on disk can be compared exactly rather than by shape. */
const fixed =
  (...values: string[]): RandomSource =>
  () =>
    Buffer.from(values.shift() ?? '', 'hex');

const control = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-lock-process-'));
  dirs.push(base);
  const dir = join(base, 'control');
  mkdirSync(dir);
  return dir;
};
const take = (
  dir: string,
  runId: string,
  secrets: string[],
  over: Partial<AcquireOptions> = {},
) => {
  const result = acquireLockBounded(dir, owner(runId), {
    deadline: Date.now() + 20_000,
    spawn: trackingSpawn,
    random: fixed(...secrets),
    ...over,
  });
  pending.push(result);
  return result;
};
const give = (handle: LockHandle) => {
  const result = releaseLockBounded(handle, {
    deadline: Date.now() + 20_000,
    spawn: trackingSpawn,
  });
  pending.push(result);
  return result;
};
/** A record of the shape the helper itself writes: the token, never the nonce. */
const record = (runId: string, token: string) =>
  `${JSON.stringify({ version: 1, runId, pid: process.pid, startedAt: STARTED_AT, token })}\n`;
const held = (dir: string) => {
  const path = join(dir, 'run.lock');
  const stat = statSync(path);
  return { bytes: readFileSync(path, 'utf8'), ino: stat.ino, dev: stat.dev };
};

describe('the lock helper, run for real through the wrapper', () => {
  it('publishes this run’s record, then takes it back', async () => {
    const dir = control();
    const outcome = await take(dir, 'run-a', [TOKEN_A, NONCE_A]);
    expect(outcome).toEqual({
      kind: 'acquired',
      handle: { controlDir: dir, runId: 'run-a' },
      diagnostics: [],
    });

    const written = readFileSync(join(dir, 'run.lock'), 'utf8');
    expect(JSON.parse(written)).toEqual({
      version: 1,
      runId: 'run-a',
      pid: process.pid,
      startedAt: STARTED_AT,
      token: TOKEN_A,
    });
    expect(written).not.toContain(NONCE_A); // the nonce names the temporary file, and nothing else
    expect(readdirSync(dir)).toEqual(['run.lock']); // run.lock.tmp-<nonce> is gone
    for (const secret of [TOKEN_A, NONCE_A]) expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(tracked).toHaveLength(1);
    expect([tracked[0]?.exit?.code, tracked[0]?.kills]).toEqual([0, []]);

    if (outcome.kind !== 'acquired') throw new Error(outcome.kind);
    expect(await give(outcome.handle)).toEqual({ kind: 'released', diagnostics: [] });
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);

  it('tells a second run it is held, and cleans up only that run’s leftover', async () => {
    const dir = control();
    const first = await take(dir, 'run-a', [TOKEN_A, NONCE_A]);
    const second = await take(dir, 'run-b', [TOKEN_B, NONCE_B]);
    expect(second).toEqual({
      kind: 'held',
      handle: { controlDir: dir, runId: 'run-b' },
      diagnostics: [],
    });
    if (first.kind !== 'acquired' || second.kind !== 'held') throw new Error('unexpected');

    // the helper already dropped B's temporary file; seed a valid one so its removal is provable
    const leftover = join(dir, `run.lock.tmp-${NONCE_B}`);
    writeFileSync(leftover, record('run-b', TOKEN_B));
    const before = held(dir);

    expect(await give(second.handle)).toEqual({ kind: 'not_ours', diagnostics: [] });
    expect(held(dir)).toEqual(before); // A's lock: same bytes, same inode, same device
    expect(readdirSync(dir)).toEqual(['run.lock']); // and B's own leftover is gone

    expect(await give(first.handle)).toEqual({ kind: 'released', diagnostics: [] });
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);

  it('leaves a lock that another run put there in its place', async () => {
    const dir = control();
    const first = await take(dir, 'run-a', [TOKEN_A, NONCE_A]);
    if (first.kind !== 'acquired') throw new Error(first.kind);

    // a separately created file, moved into place: its own inode, and another run's token
    const replacement = join(dir, 'other.lock');
    writeFileSync(replacement, record('run-c', TOKEN_B));
    renameSync(replacement, join(dir, 'run.lock'));
    const theirs = held(dir);

    expect(await give(first.handle)).toEqual({ kind: 'not_ours', diagnostics: [] });
    // bytes and inode both survive: the lock now in place was never this run's to remove
    expect(held(dir)).toEqual(theirs);
    expect(readdirSync(dir)).toEqual(['run.lock']);
  }, 30_000);
});
