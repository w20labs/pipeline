import {
  type ChildProcess,
  execFileSync,
  spawn as nodeSpawn,
  type spawn,
} from 'node:child_process';
import {
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  mode: 'acquire' | 'release' = 'acquire',
  cwd?: string,
) => {
  const argv = [HELPER, '--dir', dir, '--mode', mode];
  const pending = runChild(python ?? 'python3', argv, {
    deadline: Date.now() + 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn: trackingSpawn,
    now: Date.now,
    maxOutputBytes: 64_000,
    input,
    ...(cwd === undefined ? {} : { cwd }),
  });
  running.push(pending);
  const outcome = await pending;
  expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
  const { stdout, stderr } = (outcome as { evidence: { stdout: string; stderr: string } }).evidence;
  expect(stdout.indexOf('\n')).toBe(stdout.length - 1); // exactly one line
  for (const text of [stdout, stderr]) expect(text).not.toContain(TOKEN); // never token-bearing
  return { result: JSON.parse(stdout) as Record<string, unknown>, stderr };
};
/** Runs the helper with argv exactly as given, so argument handling can be checked. */
const acquireWith = async (args: string[]) => {
  const pending = runChild('python3', [HELPER, ...args], {
    deadline: Date.now() + 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn: trackingSpawn,
    now: Date.now,
    maxOutputBytes: 64_000,
    input: JSON.stringify(RECORD),
  });
  running.push(pending);
  const outcome = await pending;
  expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
  const { stdout } = (outcome as { evidence: { stdout: string } }).evidence;
  return { result: JSON.parse(stdout) as Record<string, unknown> };
};
type Control = ReturnType<typeof control>;
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
    ['deeply nested JSON', `${'['.repeat(1_100)}${']'.repeat(1_100)}`],
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

  /** Logs each open attempt and each close, so a path that should touch nothing can be checked. */
  const LOG = [
    'import json',
    'real_open, real_close = os.open, os.close',
    'def logged_open(path, flags, *a, **k):',
    '    sys.stderr.write(json.dumps({"open": str(path)}) + "\\n")',
    '    fd = real_open(path, flags, *a, **k)  # logged first, so a refused open is still seen',
    '    sys.stderr.write(json.dumps({"opened": fd}) + "\\n")',
    '    return fd',
    'def logged_close(fd):',
    '    sys.stderr.write(json.dumps({"close": fd}) + "\\n")',
    '    real_close(fd)',
    'os.open, os.close = logged_open, logged_close',
    'if real_open in os.supports_dir_fd: os.supports_dir_fd.add(logged_open)',
  ].join('\n');
  const logged = (stderr: string) =>
    stderr.split('\n').flatMap((l) => (l === '' ? [] : [JSON.parse(l) as Record<string, unknown>]));

  it.each([
    ['open without dir_fd', 'os.supports_dir_fd.discard(os.open)'],
    ['link without dir_fd', 'os.supports_dir_fd.discard(os.link)'],
    ['unlink without dir_fd', 'os.supports_dir_fd.discard(os.unlink)'],
    ['stat without dir_fd', 'os.supports_dir_fd.discard(os.stat)'],
    ['stat without follow_symlinks', 'os.supports_follow_symlinks.discard(os.stat)'],
    ['link without follow_symlinks', 'os.supports_follow_symlinks.discard(os.link)'],
    ['no fstat', 'del os.fstat'],
    ['no fsync', 'del os.fsync'],
    ['no O_NOFOLLOW', 'del os.O_NOFOLLOW'],
    ['no O_DIRECTORY', 'del os.O_DIRECTORY'],
    ['no O_NONBLOCK', 'del os.O_NONBLOCK'],
    ['no O_CLOEXEC', 'del os.O_CLOEXEC'],
  ])('refuses a Python with %s, opening nothing', async (_label, patch) => {
    const c = control();
    const shim = shimmed(c.base, `python3-cap-${patch.replace(/\W/g, '')}`, `${patch}\n${LOG}`);
    const { result, stderr } = await acquire(c.dir, JSON.stringify(RECORD), shim);
    expect(result).toEqual(refused('capability'));
    expect(logged(stderr)).toEqual([]);
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });

  it.each([
    ['a missing flag', ['--dir']],
    ['an unknown flag', ['--dir', '/tmp', '--why', 'x']],
    ['an unknown mode', ['--dir', '/tmp', '--mode', 'renew']],
    ['a relative directory', ['--dir', 'control', '--mode', 'acquire']],
    ['a trailing slash', ['--dir', '/tmp/control/', '--mode', 'acquire']],
    ['a .. segment', ['--dir', '/tmp/control/..', '--mode', 'acquire']],
    ['a path through .. that exists', ['--dir', 'THROUGH-DOTDOT', '--mode', 'acquire']],
    ['a leading //', ['--dir', '//tmp/control', '--mode', 'acquire']],
  ])('refuses %s, creating nothing', async (_label, args) => {
    const c = control();
    const { result } = await acquireWith(
      args.map((a) =>
        a === '/tmp'
          ? c.dir
          : a === 'THROUGH-DOTDOT'
            ? `${c.base}/../${join(c.base, 'control').slice(1)}`
            : a,
      ),
    );
    expect(result).toEqual(refused('arguments'));
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });

  it.each([
    [
      'a missing control directory',
      (c: Control) => join(c.base, 'absent'),
      'directory_missing',
      'ENOENT',
    ],
    [
      'a control directory that is a file',
      (c: Control) => (writeFileSync(join(c.base, 'plain'), ''), join(c.base, 'plain')),
      'directory_unusable',
      'ENOTDIR',
    ],
    [
      'a control directory that is a symlink',
      (c: Control) => (symlinkSync(c.dir, join(c.base, 'link')), join(c.base, 'link')),
      'directory_unusable',
      'ENOTDIR',
    ],
  ])('refuses %s', async (_label, locate, reason, errno) => {
    const c = control();
    const dir = locate(c);
    const { result } = await acquire(dir, JSON.stringify(RECORD));
    expect(result).toEqual(refused(reason, errno));
    expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
  });

  /** Records the temporary file's descriptor: the only one opened relative to the directory. */
  const TRACK_TEMP = [
    'temps = []',
    'real_open = os.open',
    'def tracking_open(path, flags, *a, **k):',
    '    fd = real_open(path, flags, *a, **k)',
    '    if k.get("dir_fd") is not None: temps.append(fd)',
    '    return fd',
    'os.open = tracking_open',
    'os.supports_dir_fd.add(tracking_open)',
  ].join('\n');

  /**
   * Makes one os function fail. A wrapper keeps the capabilities it wraps, or the helper would
   * refuse for want of a capability instead.
   */
  const failing = (target: string, code: string, when = 'True') =>
    [
      `real_${target} = os.${target}`,
      `def failing_${target}(*a, **k):`,
      `    if ${when}: raise OSError(errno.${code}, os.strerror(errno.${code}))`,
      `    return real_${target}(*a, **k)`,
      `os.${target} = failing_${target}`,
      `if real_${target} in os.supports_dir_fd: os.supports_dir_fd.add(failing_${target})`,
      `if real_${target} in os.supports_follow_symlinks: os.supports_follow_symlinks.add(failing_${target})`,
    ].join('\n');

  /** Closes for real exactly once, then reports failure — for the temporary file's descriptor only. */
  const FAILING_CLOSE = [
    'real_close = os.close',
    'def failing_close(fd):',
    '    real_close(fd)',
    '    if fd in temps: raise OSError(errno.EBADF, os.strerror(errno.EBADF))',
    'os.close = failing_close',
  ].join('\n');

  /** Only the temporary file's own close fails; the directory's must still succeed. */
  const CLOSE_TEMP_FAILS = `${TRACK_TEMP}\n${FAILING_CLOSE}`;

  it.each([
    ['a failed fsync', failing('fsync', 'EIO'), refused('fsync_failed', 'EIO')],
    ['a failed close of the temporary file', CLOSE_TEMP_FAILS, refused('close_failed', 'EBADF')],
    ['a failed link', failing('link', 'EXDEV'), refused('link_failed', 'EXDEV')],
    [
      'a write of no bytes',
      'real_write = os.write\nos.write = lambda fd, data: 0 if fd > 2 else real_write(fd, data)',
      refused('write_failed'),
    ],
  ])(
    'refuses %s before publishing, removing only its own temporary file',
    async (_label, patch, expected) => {
      const c = control();
      const shim = shimmed(c.base, `python3-${String(made.length)}-fail`, patch);
      expect((await acquire(c.dir, JSON.stringify(RECORD), shim)).result).toEqual(expected);
      expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
    },
  );

  it.each([
    ['a failed write', failing('write', 'EIO', 'a[0] > 2'), 'write_failed', 'EIO'],
    ['a failed fsync', failing('fsync', 'EIO'), 'fsync_failed', 'EIO'],
  ])(
    'keeps %s as the reason when the close then fails too',
    async (_label, patch, reason, errno) => {
      const c = control();
      const shim = shimmed(
        c.base,
        `python3-${String(made.length)}-both`,
        `${patch}\n${CLOSE_TEMP_FAILS}`,
      );
      const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
      // neither failure disappears: the first is the reason, the close is a diagnostic beside it
      expect(result).toEqual(refused(reason, errno, [{ step: 'close_temp', errno: 'EBADF' }]));
      expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
    },
  );

  it('cannot prove ownership when fstat fails, so it publishes nothing and removes nothing', async () => {
    const c = control();
    const shim = shimmed(c.base, 'python3-fstat-fails', failing('fstat', 'EIO'));
    const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
    expect(result).toEqual(
      refused('ownership_unknown', 'EIO', [{ step: 'temp_may_remain', errno: null }]),
    );
    expect(entries(c.dir).lock).toBeUndefined();
    expect(entries(c.dir).temp).toBe(''); // left exactly as created: empty, and not ours to remove
  });

  const lockOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'run.lock'), 'utf8')) as Record<string, unknown>;
  const RECORDED = {
    version: 1,
    runId: 'run-1',
    pid: 4_242,
    startedAt: '2026-09-17T08:30:00Z',
    token: TOKEN,
  };

  it.each([
    [
      'the temporary file cannot be removed',
      `${TRACK_TEMP}\n${failing('unlink', 'EIO')}`,
      [{ step: 'unlink_temp', errno: 'EIO' }],
      true,
    ],
    [
      'the directory will not close',
      `${TRACK_TEMP}\nreal_close = os.close\ndef failing_close(fd):\n    real_close(fd)\n    if fd not in temps: raise OSError(errno.EBADF, "bad")\nos.close = failing_close`,
      [{ step: 'close_directory', errno: 'EBADF' }],
      false,
    ],
  ])(
    'still holds the lock when %s after publishing',
    async (_label, patch, diagnostics, tempLeft) => {
      const c = control();
      const shim = shimmed(c.base, `python3-${String(made.length)}-after`, patch);
      const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
      // publication happened: the run holds the lock, and the diagnostic stays beside it
      expect(result).toEqual({ kind: 'acquired', diagnostics });
      expect(lockOf(c.dir)).toEqual(RECORDED);
      expect(entries(c.dir).temp !== undefined).toBe(tempLeft);
    },
  );

  it('reports a temporary file it can no longer stat, still holding the lock', async () => {
    const c = control();
    const patch = [
      'real_stat = os.stat',
      'def failing(*a, **k):',
      '    if k.get("dir_fd") is not None: raise OSError(errno.EIO, "io")',
      '    return real_stat(*a, **k)',
      'os.stat = failing',
      'os.supports_dir_fd.add(failing)',
      'os.supports_follow_symlinks.add(failing)',
    ].join('\n');
    const shim = shimmed(c.base, 'python3-stat-fails-late', patch);
    const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
    expect(result).toEqual({
      kind: 'acquired',
      diagnostics: [{ step: 'unlink_temp', errno: 'EIO' }],
    });
    expect(lockOf(c.dir)).toEqual(RECORDED);
    // the written record, left in place: never removed without evidence that it is still ours
    expect(JSON.parse(entries(c.dir).temp ?? '')).toEqual(RECORDED);
  });

  it('will not remove a temporary name that is no longer the file it created', async () => {
    const c = control();
    const other = join(c.base, 'someone-else');
    writeFileSync(other, 'not ours');
    // replacing our temporary file breaks the cooperative assumption; the helper still refuses to
    // remove a name whose device and inode no longer match what it created
    const patch = [
      'import shutil',
      'real_link = os.link',
      'def swapping(*a, **k):',
      '    result = real_link(*a, **k)',
      `    os.replace(${JSON.stringify(other)}, os.path.join(${JSON.stringify(c.dir)}, a[0]))`,
      '    return result',
      'os.link = swapping',
      'os.supports_dir_fd.add(swapping)',
      'os.supports_follow_symlinks.add(swapping)',
    ].join('\n');
    const shim = shimmed(c.base, 'python3-swap-temp', patch);
    const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
    expect(result).toEqual({
      kind: 'acquired',
      diagnostics: [{ step: 'temp_replaced', errno: null }],
    });
    expect(lockOf(c.dir)).toEqual(RECORDED);
    expect(entries(c.dir).temp).toBe('not ours'); // left alone, exactly as the intruder put it
  });

  it('links the temporary name without following it', async () => {
    const c = control();
    const target = join(c.base, 'target');
    writeFileSync(target, 'target contents');
    const calls = join(c.base, 'link-calls');
    // the temporary file is replaced by a symlink before publication: outside the cooperative
    // assumptions, and no proof that a valid record was published — only that the target is untouched
    const patch = [
      'import json',
      'real_link = os.link',
      'def logged(*a, **k):',
      `    open(${JSON.stringify(calls)}, "w").write(json.dumps({"follow": k.get("follow_symlinks"), "src": k.get("src_dir_fd") is not None, "dst": k.get("dst_dir_fd") is not None}))`,
      '    return real_link(*a, **k)',
      'os.link = logged',
      'os.supports_dir_fd.add(logged)',
      'os.supports_follow_symlinks.add(logged)',
      'real_fsync = os.fsync',
      'def swapping_fsync(fd):',
      '    result = real_fsync(fd)',
      `    path = os.path.join(${JSON.stringify(c.dir)}, "run.lock.tmp-${NONCE}")`,
      '    os.unlink(path)',
      `    os.symlink(${JSON.stringify(target)}, path)`,
      '    return result',
      'os.fsync = swapping_fsync',
    ].join('\n');
    const shim = shimmed(c.base, 'python3-link-nofollow', patch);
    const { result } = await acquire(c.dir, JSON.stringify(RECORD), shim);
    expect(JSON.parse(readFileSync(calls, 'utf8'))).toEqual({
      follow: false,
      src: true,
      dst: true,
    });
    expect(result).toMatchObject({ kind: 'acquired' });
    expect(readFileSync(target, 'utf8')).toBe('target contents'); // never written through
  });

  it('reports a symlinked lock as held, touching neither it nor its target', async () => {
    const c = control();
    const target = join(c.base, 'target');
    writeFileSync(target, 'target contents');
    symlinkSync(target, join(c.dir, 'run.lock'));
    const { result } = await acquire(c.dir);
    expect(result).toEqual({ kind: 'held', diagnostics: [] });
    expect(lstatSync(join(c.dir, 'run.lock')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('target contents');
    expect(entries(c.dir).temp).toBeUndefined();
  });

  it.each([
    ['an acquisition', () => undefined],
    ['a held lock', (c: Control) => writeFileSync(join(c.dir, 'run.lock'), 'other')],
    ['a refused temporary name', (c: Control) => writeFileSync(join(c.dir, TEMP), 'other')],
  ])(
    'closes every descriptor it opened, and writes one line, after %s',
    async (_label, arrange) => {
      const c = control();
      arrange(c);
      const shim = shimmed(c.base, `python3-${String(made.length)}-log`, LOG);
      const { stderr } = await acquire(c.dir, JSON.stringify(RECORD), shim);
      const events = logged(stderr);
      const opened = events.filter((e) => 'opened' in e).map((e) => e['opened']);
      // a refused open yields no descriptor; each one returned is closed exactly once
      expect(opened.length).toBeGreaterThan(0);
      expect(events.filter((e) => 'close' in e).map((e) => e['close'])).toEqual(
        [...opened].reverse(),
      );
    },
  );

  it('writes the exact record through one-byte writes', async () => {
    const c = control();
    const patch = 'real_write = os.write\nos.write = lambda fd, data: real_write(fd, data[:1])';
    const shim = shimmed(c.base, 'python3-short-writes', patch);
    expect((await acquire(c.dir, JSON.stringify(RECORD), shim)).result).toEqual({
      kind: 'acquired',
      diagnostics: [],
    });
    expect(lockOf(c.dir)).toEqual(RECORDED);
  });

  describe('releasing it again', () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const release = (
      dir: string,
      input: string | Uint8Array = JSON.stringify(RECORD),
      python?: string,
    ) => acquire(dir, input, python, 'release');
    /**
     * What must not change: inode and type always, plus the contents of what can be read without
     * blocking — a regular file's bytes, a symlink's text. A FIFO is never opened to check it.
     */
    const asFound = (path: string) => {
      const info = lstatSync(path);
      const type = info.mode & 0o170000;
      return {
        ino: info.ino,
        type,
        ...(info.isFile() ? { bytes: readFileSync(path, 'utf8') } : {}),
        ...(info.isSymbolicLink() ? { points: readlinkSync(path) } : {}),
      };
    };
    const locked = async (c: Control) => {
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      return asFound(join(c.dir, 'run.lock'));
    };

    it('removes the lock its own token published', async () => {
      const c = control();
      await locked(c);
      const { result, stderr } = await release(c.dir);
      expect(result).toEqual({ kind: 'released', diagnostics: [] });
      expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
      expect(stderr).toBe('');
    });

    it('reports a lock that is not there', async () => {
      const c = control();
      expect((await release(c.dir)).result).toEqual({ kind: 'missing', diagnostics: [] });
      expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
    });

    it('leaves another run’s lock exactly as found', async () => {
      const c = control();
      const before = await locked(c);
      const other = JSON.stringify({ ...RECORD, runId: 'run-2', token: OTHER, nonce: OTHER });
      expect((await release(c.dir, other)).result).toEqual({ kind: 'not_ours', diagnostics: [] });
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    it('will not release a lock whose token merely starts like its own', async () => {
      const c = control();
      const before = await locked(c);
      // the same first half, a different second: only a whole-token comparison can tell them apart
      const near = `${TOKEN.slice(0, 16)}${'9'.repeat(16)}`;
      const other = JSON.stringify({ ...RECORD, token: near, nonce: OTHER });
      expect((await release(c.dir, other)).result).toEqual({ kind: 'not_ours', diagnostics: [] });
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    const held = (over: object) => JSON.stringify({ ...RECORDED, ...over });
    it.each([
      ['text that is not JSON', 'not json'],
      ['an array', JSON.stringify([RECORDED])],
      ['a duplicate key', `{${held({}).slice(1, -1)}, "token": "${TOKEN}"}`],
      ['a missing key', JSON.stringify({ ...RECORDED, token: undefined })],
      ['an unknown key', held({ extra: 1 })],
      ['version 2', held({ version: 2 })],
      ['version true', held({ version: true })],
      ['a boolean pid', held({ pid: true })],
      ['a pid of zero', held({ pid: 0 })],
      ['a malformed token', held({ token: TOKEN.toUpperCase() })],
      ['a runId with a separator', held({ runId: 'a/b' })],
      ['an impossible timestamp', held({ startedAt: '2026-02-30T00:00:00Z' })],
    ])('leaves a lock holding %s exactly as found', async (_label, body) => {
      const c = control();
      writeFileSync(join(c.dir, 'run.lock'), body);
      const before = asFound(join(c.dir, 'run.lock'));
      expect((await release(c.dir)).result).toEqual({ kind: 'unrecognized', diagnostics: [] });
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    /**
     * Recursion depends on the interpreter: /usr/bin/python3 3.9.6 exhausts its parser at 1,100
     * levels while 3.14 parses them, so the shim makes the parser recurse on any version.
     */
    const RECURSING = [
      'import json',
      'real_loads = json.loads',
      'def recursing(text, **k):',
      '    raise RecursionError("maximum recursion depth exceeded")',
      'json.loads = recursing',
    ].join('\n');

    it('reports a lock whose parser exhausts itself, leaving it as found', async () => {
      const c = control();
      writeFileSync(join(c.dir, 'run.lock'), JSON.stringify(RECORDED));
      const before = asFound(join(c.dir, 'run.lock'));
      const shim = shimmed(c.base, 'python3-recursing-lock', RECURSING);
      // the stdin record is parsed first, so this shim refuses there: it proves the catch, not the kind
      expect((await release(c.dir, JSON.stringify(RECORD), shim)).result).toEqual(
        refused('arguments'),
      );
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    it('reports a lock the parser cannot take, once past the record it was given', async () => {
      const c = control();
      writeFileSync(join(c.dir, 'run.lock'), JSON.stringify(RECORDED));
      const before = asFound(join(c.dir, 'run.lock'));
      // recursion only for the lock's own bytes: the record on stdin still parses
      const patch = `${RECURSING.replace('def recursing(text, **k):', 'def recursing(text, **k):\n    if not text.startswith("{\\"version\\""): return real_loads(text, **k)')}`;
      const shim = shimmed(c.base, 'python3-recursing-record', patch);
      expect((await release(c.dir, JSON.stringify(RECORD), shim)).result).toEqual({
        kind: 'unrecognized',
        diagnostics: [],
      });
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    it('leaves a deeply nested lock exactly as found', async () => {
      const c = control();
      const nested = `${'['.repeat(1_100)}${']'.repeat(1_100)}`; // exhausts some parsers, not all
      writeFileSync(join(c.dir, 'run.lock'), nested);
      const before = asFound(join(c.dir, 'run.lock'));
      expect((await release(c.dir)).result).toEqual({ kind: 'unrecognized', diagnostics: [] });
      expect(asFound(join(c.dir, 'run.lock'))).toEqual(before);
    });

    it('leaves a lock of bytes that are not UTF-8 exactly as found', async () => {
      const c = control();
      writeFileSync(
        join(c.dir, 'run.lock'),
        Buffer.concat([Buffer.from('{"version":'), Buffer.from([0xff]), Buffer.from('}')]),
      );
      const before = lstatSync(join(c.dir, 'run.lock')).ino;
      expect((await release(c.dir)).result).toEqual({ kind: 'unrecognized', diagnostics: [] });
      expect(lstatSync(join(c.dir, 'run.lock')).ino).toBe(before);
    });
  });

  describe('and refusing to release what is not exactly its own', () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const release = (
      dir: string,
      input: string | Uint8Array = JSON.stringify(RECORD),
      python?: string,
    ) => acquire(dir, input, python, 'release');
    const asFound = (path: string) => {
      const info = lstatSync(path);
      return {
        ino: info.ino,
        type: info.mode & 0o170000,
        ...(info.isFile() ? { bytes: readFileSync(path, 'utf8') } : {}),
        ...(info.isSymbolicLink() ? { points: readlinkSync(path) } : {}),
      };
    };
    const lockPath = (c: Control) => join(c.dir, 'run.lock');

    it('reads no more than the cap allows, and releases a record padded to exactly it', async () => {
      const c = control();
      const body = JSON.stringify(RECORDED);
      writeFileSync(lockPath(c), body + ' '.repeat(4_096 - body.length));
      const counting = [
        'import json',
        'real_read = os.read',
        'def counted(fd, n):',
        '    sys.stderr.write(json.dumps(n) + "\\n")  # what it asked for, not what it got',
        '    return real_read(fd, n)',
        'os.read = counted',
      ].join('\n');
      const shim = shimmed(c.base, 'python3-counting-read', counting);
      const { result, stderr } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toEqual({ kind: 'released', diagnostics: [] });
      const asked = stderr.split('\n').flatMap((l) => (l === '' ? [] : [Number(l)]));
      expect(asked.length).toBeGreaterThan(0);
      expect(Math.max(...asked)).toBeLessThanOrEqual(4_097); // never asks past the cap + 1
    });

    it('refuses a lock one byte over the cap, leaving it as found', async () => {
      const c = control();
      const body = JSON.stringify(RECORDED);
      writeFileSync(lockPath(c), body + ' '.repeat(4_097 - body.length));
      const before = asFound(lockPath(c));
      expect((await release(c.dir)).result).toEqual(refused('too_large'));
      expect(asFound(lockPath(c))).toEqual(before);
    });

    it('releases through one-byte reads', async () => {
      const c = control();
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      const shim = shimmed(
        c.base,
        'python3-short-reads',
        'real_read = os.read\nos.read = lambda fd, n: real_read(fd, 1)',
      );
      expect((await release(c.dir, JSON.stringify(RECORD), shim)).result).toEqual({
        kind: 'released',
        diagnostics: [],
      });
      expect(entries(c.dir).lock).toBeUndefined();
    });

    it.each([
      ['a directory', (c: Control) => mkdirSync(lockPath(c))],
      ['a FIFO with no writer', (c: Control) => execFileSync('mkfifo', [lockPath(c)])],
    ])('refuses a lock that is %s, leaving it as found', async (_label, arrange) => {
      const c = control();
      arrange(c);
      const before = asFound(lockPath(c));
      const started = Date.now();
      expect((await release(c.dir)).result).toEqual(refused('not_regular'));
      expect(Date.now() - started).toBeLessThan(3_000); // the open never blocks on the FIFO
      expect(asFound(lockPath(c))).toEqual(before);
    });

    it('refuses a symlinked lock without reading through it', async () => {
      const c = control();
      const target = join(c.base, 'target');
      writeFileSync(target, JSON.stringify(RECORDED)); // a record it would accept, if it followed
      symlinkSync(target, lockPath(c));
      const [beforeLink, beforeTarget] = [asFound(lockPath(c)), asFound(target)];
      const { result } = await release(c.dir);
      expect(result).toMatchObject({ kind: 'refused', reason: 'lock_unusable' });
      expect(asFound(lockPath(c))).toEqual(beforeLink);
      expect(asFound(target)).toEqual(beforeTarget);
    });

    /** Replaces run.lock once its bytes have been read, before the recheck can run. */
    const swapAfterRead = (make: string) =>
      [
        'real_read = os.read',
        'swapped = []',
        'def reading(fd, n):',
        '    data = real_read(fd, n)',
        '    if data and not swapped:',
        '        swapped.append(True)',
        `        ${make}`,
        '    return data',
        'os.read = reading',
      ].join('\n');

    it('will not release a lock replaced after it was read', async () => {
      const c = control();
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      const intruder = join(c.base, 'intruder');
      writeFileSync(intruder, 'another run');
      const patch = swapAfterRead(
        `os.replace(${JSON.stringify(intruder)}, ${JSON.stringify(lockPath(c))})`,
      );
      const shim = shimmed(c.base, 'python3-swap-lock', patch);
      const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toEqual({ kind: 'replaced', diagnostics: [] });
      expect(asFound(lockPath(c))).toMatchObject({ bytes: 'another run' });
    });

    it('will not release a lock replaced by a symlink to its own inode', async () => {
      const c = control();
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      const kept = join(c.base, 'kept');
      // the very same inode, under another name: only a recheck that refuses to follow links refuses
      const patch = swapAfterRead(
        `os.link(${JSON.stringify(lockPath(c))}, ${JSON.stringify(kept)}); os.unlink(${JSON.stringify(lockPath(c))}); os.symlink(${JSON.stringify(kept)}, ${JSON.stringify(lockPath(c))})`,
      );
      const shim = shimmed(c.base, 'python3-swap-symlink', patch);
      const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toEqual({ kind: 'replaced', diagnostics: [] });
      expect(asFound(lockPath(c))).toMatchObject({ points: kept });
      expect(JSON.parse(readFileSync(kept, 'utf8'))).toEqual(RECORDED); // the record itself survives
    });

    const failing = (target: string, code: string, when = 'True') =>
      [
        `real_${target} = os.${target}`,
        `def failing_${target}(*a, **k):`,
        `    if ${when}: raise OSError(errno.${code}, os.strerror(errno.${code}))`,
        `    return real_${target}(*a, **k)`,
        `os.${target} = failing_${target}`,
        `if real_${target} in os.supports_dir_fd: os.supports_dir_fd.add(failing_${target})`,
        `if real_${target} in os.supports_follow_symlinks: os.supports_follow_symlinks.add(failing_${target})`,
      ].join('\n');

    it.each([
      ['fstat', failing('fstat', 'EIO'), refused('fstat_failed', 'EIO')],
      ['the read', failing('read', 'EIO', 'a[0] > 2'), refused('read_failed', 'EIO')],
      [
        'the recheck',
        failing('stat', 'EIO', 'k.get("dir_fd") is not None'),
        refused('stat_failed', 'EIO'),
      ],
      ['the unlink', failing('unlink', 'EACCES'), refused('unlink_failed', 'EACCES')],
    ])('refuses when %s fails, leaving the lock as found', async (_label, patch, expected) => {
      const c = control();
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      const before = asFound(lockPath(c));
      const shim = shimmed(c.base, `python3-${String(made.length)}-release-fail`, patch);
      expect((await release(c.dir, JSON.stringify(RECORD), shim)).result).toEqual(expected);
      expect(asFound(lockPath(c))).toEqual(before);
    });

    const TRACK_LOCK = [
      'locks = []',
      'real_open = os.open',
      'def tracking_open(path, flags, *a, **k):',
      '    fd = real_open(path, flags, *a, **k)',
      '    if k.get("dir_fd") is not None: locks.append(fd)',
      '    return fd',
      'os.open = tracking_open',
      'os.supports_dir_fd.add(tracking_open)',
    ].join('\n');
    const closeFails = (which: 'lock' | 'directory') =>
      [
        TRACK_LOCK,
        'real_close = os.close',
        'def failing_close(fd):',
        '    real_close(fd)',
        `    if ${which === 'lock' ? 'fd in locks' : 'fd not in locks'}: raise OSError(errno.EBADF, "bad")`,
        'os.close = failing_close',
      ].join('\n');

    it.each([
      ['its own lock', 'lock', JSON.stringify(RECORD), { kind: 'released' }, 'close_lock'],
      [
        'another run’s lock',
        'lock',
        JSON.stringify({ ...RECORD, token: OTHER, nonce: OTHER }),
        { kind: 'not_ours' },
        'close_lock',
      ],
      [
        'its own lock',
        'directory',
        JSON.stringify(RECORD),
        { kind: 'released' },
        'close_directory',
      ],
    ] as [string, 'lock' | 'directory', string, object, string][])(
      'keeps the outcome for %s when the %s descriptor will not close',
      async (_label, which, input, outcome, step) => {
        const c = control();
        expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
        const shim = shimmed(
          c.base,
          `python3-${String(made.length)}-close-${which}`,
          closeFails(which),
        );
        const { result } = await release(c.dir, input, shim);
        expect(result).toEqual({ ...outcome, diagnostics: [{ step, errno: 'EBADF' }] });
      },
    );

    it.each([
      ['a release', () => undefined, JSON.stringify(RECORD)],
      ['a missing lock', (c: Control) => rmSync(lockPath(c)), JSON.stringify(RECORD)],
      [
        'another run’s lock',
        () => undefined,
        JSON.stringify({ ...RECORD, token: OTHER, nonce: OTHER }),
      ],
      [
        'an unrecognized lock',
        (c: Control) => writeFileSync(lockPath(c), 'not a record'),
        JSON.stringify(RECORD),
      ],
    ])(
      'closes every descriptor it opened, and writes one line, after %s',
      async (_label, arrange, input) => {
        const c = control();
        expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
        arrange(c);
        const shim = shimmed(c.base, `python3-${String(made.length)}-release-log`, LOG);
        const { stderr } = await release(c.dir, input, shim);
        const events = logged(stderr);
        const opened = events.filter((e) => 'opened' in e).map((e) => e['opened']);
        expect(opened.length).toBeGreaterThan(0);
        expect(events.filter((e) => 'close' in e).map((e) => e['close'])).toEqual(
          [...opened].reverse(),
        );
      },
    );

    it('refuses a malformed token before opening anything, and a Python without a capability', async () => {
      const c = control();
      const shim = shimmed(c.base, 'python3-release-cap', `del os.O_NOFOLLOW\n${LOG}`);
      expect((await release(c.dir, JSON.stringify({ ...RECORD, token: 'nope' }))).result).toEqual(
        refused('arguments'),
      );
      const { result, stderr } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toEqual(refused('capability'));
      expect(logged(stderr)).toEqual([]);
    });
  });

  describe('and clearing up after itself', () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const release = (
      dir: string,
      input: string | Uint8Array = JSON.stringify(RECORD),
      python?: string,
    ) => acquire(dir, input, python, 'release');
    const asFound = (path: string) => {
      const info = lstatSync(path);
      return {
        ino: info.ino,
        type: info.mode & 0o170000,
        ...(info.isFile() ? { bytes: readFileSync(path, 'utf8') } : {}),
        ...(info.isSymbolicLink() ? { points: readlinkSync(path) } : {}),
      };
    };
    const tempPath = (c: Control) => join(c.dir, TEMP);
    /** A lock held by this run, and a leftover temporary file holding whatever is given. */
    const withLeftover = async (c: Control, contents?: string) => {
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      if (contents !== undefined) writeFileSync(tempPath(c), contents);
    };
    const OURS = JSON.stringify(RECORDED);
    const THEIRS = JSON.stringify({ ...RECORDED, runId: 'run-2', token: OTHER });

    it('removes a leftover file holding its own record', async () => {
      const c = control();
      await withLeftover(c, OURS);
      expect((await release(c.dir)).result).toEqual({ kind: 'released', diagnostics: [] });
      expect(entries(c.dir)).toEqual({ lock: undefined, temp: undefined });
    });

    it.each([
      ['another run’s record', THEIRS, 'temp_unrecognized'],
      ['a truncated record', OURS.slice(0, 40), 'temp_partial'],
      ['more than the cap', `${OURS}${' '.repeat(4_097 - OURS.length)}`, 'temp_too_large'],
    ])('leaves a leftover file holding %s, reporting it', async (_label, contents, step) => {
      const c = control();
      await withLeftover(c, contents);
      const before = asFound(tempPath(c));
      const { result } = await release(c.dir);
      expect(result).toEqual({ kind: 'released', diagnostics: [{ step, errno: null }] });
      expect(asFound(tempPath(c))).toEqual(before);
    });

    it('removes a leftover record padded to exactly the cap, through one-byte reads', async () => {
      const c = control();
      await withLeftover(c, `${OURS}${' '.repeat(4_096 - OURS.length)}`);
      const shim = shimmed(
        c.base,
        'python3-temp-short-reads',
        'real_read = os.read\nos.read = lambda fd, n: real_read(fd, 1)',
      );
      expect((await release(c.dir, JSON.stringify(RECORD), shim)).result).toEqual({
        kind: 'released',
        diagnostics: [],
      });
      expect(entries(c.dir).temp).toBeUndefined();
    });

    it('never follows a symlinked leftover name, nor reads its target', async () => {
      const c = control();
      await withLeftover(c);
      const target = join(c.base, 'temp-target');
      writeFileSync(target, OURS); // a record it would accept, if it followed the link
      symlinkSync(target, tempPath(c));
      const [beforeLink, beforeTarget] = [asFound(tempPath(c)), asFound(target)];
      const { result } = await release(c.dir);
      expect(result).toEqual({
        kind: 'released',
        diagnostics: [{ step: 'temp_unusable', errno: 'ELOOP' }],
      });
      expect(asFound(tempPath(c))).toEqual(beforeLink);
      expect(asFound(target)).toEqual(beforeTarget);
    });

    it.each([
      ['a directory', (c: Control) => mkdirSync(tempPath(c))],
      ['a FIFO with no writer', (c: Control) => execFileSync('mkfifo', [tempPath(c)])],
    ])('leaves a leftover name that is %s, reporting it', async (_label, arrange) => {
      const c = control();
      await withLeftover(c);
      arrange(c);
      const before = asFound(tempPath(c));
      const started = Date.now();
      const { result } = await release(c.dir);
      expect(result).toEqual({
        kind: 'released',
        diagnostics: [{ step: 'temp_unusable', errno: null }],
      });
      expect(Date.now() - started).toBeLessThan(3_000); // the open never blocks on the FIFO
      expect(asFound(tempPath(c))).toEqual(before);
    });

    it('will not remove a leftover file replaced after it was read', async () => {
      const c = control();
      await withLeftover(c, OURS);
      const intruder = join(c.base, 'intruder-temp');
      writeFileSync(intruder, 'another file');
      // swapped once the temporary file's own bytes have been read, before the recheck
      const patch = [
        'real_read = os.read',
        'reads = []',
        'def reading(fd, n):',
        '    data = real_read(fd, n)',
        '    if data: reads.append(fd)',
        '    if len(reads) == 2 and reads[0] != reads[1]:  # the lock first, then the leftover file',
        `        reads.append(fd); os.replace(${JSON.stringify(intruder)}, ${JSON.stringify(tempPath(c))})`,
        '    return data',
        'os.read = reading',
      ].join('\n');
      const shim = shimmed(c.base, 'python3-swap-temp-late', patch);
      const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toMatchObject({ diagnostics: [{ step: 'temp_replaced', errno: null }] });
      expect(asFound(tempPath(c))).toMatchObject({ bytes: 'another file' });
    });

    it('says nothing when there is no leftover file', async () => {
      const c = control();
      await withLeftover(c);
      expect((await release(c.dir)).result).toEqual({ kind: 'released', diagnostics: [] });
    });
  });

  describe('and reporting what it may not clear up', () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const release = (
      dir: string,
      input: string | Uint8Array = JSON.stringify(RECORD),
      python?: string,
    ) => acquire(dir, input, python, 'release');
    const asFound = (path: string) => {
      const info = lstatSync(path);
      return {
        ino: info.ino,
        type: info.mode & 0o170000,
        ...(info.isFile() ? { bytes: readFileSync(path, 'utf8') } : {}),
        ...(info.isSymbolicLink() ? { points: readlinkSync(path) } : {}),
      };
    };
    const tempPath = (c: Control) => join(c.dir, TEMP);
    const OURS = JSON.stringify(RECORDED);
    const leftover = async (c: Control, contents = OURS) => {
      expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
      writeFileSync(tempPath(c), contents);
    };
    /** Swaps the leftover file once its own bytes have been read, before the recheck. */
    const swapAfterTempRead = (make: string) =>
      [
        'real_read = os.read',
        'reads = []',
        'def reading(fd, n):',
        '    data = real_read(fd, n)',
        '    if data: reads.append(fd)',
        '    if len(reads) == 2 and reads[0] != reads[1]:  # the lock first, then the leftover file',
        `        reads.append(fd); ${make}`,
        '    return data',
        'os.read = reading',
      ].join('\n');

    it('will not remove a leftover replaced by a symlink to its own inode', async () => {
      const c = control();
      await leftover(c);
      const kept = join(c.base, 'kept-temp');
      // the same inode under another name: only a recheck that refuses to follow links refuses here
      const patch = swapAfterTempRead(
        `os.link(${JSON.stringify(tempPath(c))}, ${JSON.stringify(kept)}); os.unlink(${JSON.stringify(tempPath(c))}); os.symlink(${JSON.stringify(kept)}, ${JSON.stringify(tempPath(c))})`,
      );
      const shim = shimmed(c.base, 'python3-temp-symlink-swap', patch);
      const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
      expect(result).toEqual({
        kind: 'released',
        diagnostics: [{ step: 'temp_replaced', errno: null }],
      });
      expect(asFound(tempPath(c))).toMatchObject({ points: kept });
      expect(JSON.parse(readFileSync(kept, 'utf8'))).toEqual(RECORDED); // the record itself survives
    });

    const failing = (target: string, code: string, when = 'True') =>
      [
        `real_${target} = os.${target}`,
        `def failing_${target}(*a, **k):`,
        `    if ${when}: raise OSError(errno.${code}, os.strerror(errno.${code}))`,
        `    return real_${target}(*a, **k)`,
        `os.${target} = failing_${target}`,
        `if real_${target} in os.supports_dir_fd: os.supports_dir_fd.add(failing_${target})`,
        `if real_${target} in os.supports_follow_symlinks: os.supports_follow_symlinks.add(failing_${target})`,
      ].join('\n');
    /** By name: run.lock must still be released, so only the leftover file's own step may fail. */
    const NOT_THE_LOCK = 'a[0] != "run.lock"';
    /** Second file opened relative to the directory: the lock is first, the leftover second. */
    const ONLY_TEMP = [
      'opens = []',
      'real_open = os.open',
      'def counting_open(path, flags, *a, **k):',
      '    fd = real_open(path, flags, *a, **k)',
      '    if k.get("dir_fd") is not None: opens.append(fd)',
      '    return fd',
      'os.open = counting_open',
      'os.supports_dir_fd.add(counting_open)',
    ].join('\n');

    it.each([
      [
        'its fstat',
        `${ONLY_TEMP}\n${failing('fstat', 'EIO', 'len(opens) > 1')}`,
        'temp_fstat_failed',
        'EIO',
      ],
      [
        'its read',
        `${ONLY_TEMP}\n${failing('read', 'EIO', 'len(opens) > 1')}`,
        'temp_read_failed',
        'EIO',
      ],
      [
        'its recheck',
        `${ONLY_TEMP}\n${failing('stat', 'EIO', NOT_THE_LOCK)}`,
        'temp_stat_failed',
        'EIO',
      ],
      ['its unlink', failing('unlink', 'EACCES', NOT_THE_LOCK), 'temp_unlink_failed', 'EACCES'],
    ])(
      'reports a leftover it cannot clear because %s fails, leaving it as found',
      async (_label, patch, step, errno) => {
        const c = control();
        await leftover(c);
        const before = asFound(tempPath(c));
        const shim = shimmed(c.base, `python3-${String(made.length)}-temp-fail`, patch);
        const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
        // the lock itself is still released: only the leftover file's own step failed
        expect(result).toEqual({ kind: 'released', diagnostics: [{ step, errno }] });
        expect(entries(c.dir).lock).toBeUndefined();
        expect(asFound(tempPath(c))).toEqual(before);
      },
    );

    it('keeps an earlier leftover failure when its close then fails too', async () => {
      const c = control();
      await leftover(c, OURS.slice(0, 40)); // a partial record: reported, and never removed
      const patch = [
        ONLY_TEMP,
        'real_close = os.close',
        'def failing_close(fd):',
        '    real_close(fd)',
        '    if fd in opens[1:]: raise OSError(errno.EBADF, "bad")',
        'os.close = failing_close',
      ].join('\n');
      const shim = shimmed(c.base, 'python3-temp-close-fails', patch);
      const { result } = await release(c.dir, JSON.stringify(RECORD), shim);
      // neither report is dropped, and the lock's outcome is untouched
      expect(result).toEqual({
        kind: 'released',
        diagnostics: [
          { step: 'temp_partial', errno: null },
          { step: 'temp_close_failed', errno: 'EBADF' },
        ],
      });
      expect(entries(c.dir).temp).toBe(OURS.slice(0, 40));
    });

    it.each([
      [
        'another run’s lock',
        'not_ours',
        (c: Control) =>
          writeFileSync(
            join(c.dir, 'run.lock'),
            JSON.stringify({ ...RECORDED, runId: 'run-2', token: OTHER }),
          ),
        true,
      ],
      ['no lock at all', 'missing', (c: Control) => rmSync(join(c.dir, 'run.lock')), true],
      [
        'an unrecognized lock',
        'unrecognized',
        (c: Control) => writeFileSync(join(c.dir, 'run.lock'), 'not a record'),
        true,
      ],
    ])('clears its own leftover beside %s', async (_label, kind, arrange, removed) => {
      const c = control();
      await leftover(c);
      arrange(c);
      const { result } = await release(c.dir);
      expect(result).toEqual({ kind, diagnostics: [] });
      expect(entries(c.dir).temp === undefined).toBe(removed);
    });
  });

  describe('and touching nothing when it refuses early', () => {
    const release = (dir: string, input: string | Uint8Array, python?: string, cwd?: string) =>
      acquire(dir, input, python, 'release', cwd);
    const asFound = (path: string) => {
      const info = lstatSync(path);
      return { ino: info.ino, type: info.mode & 0o170000, bytes: readFileSync(path, 'utf8') };
    };
    /** Logs every open, read and unlink: a refusal must show none of them touching the sentinel. */
    const TOUCHES = [
      'import json',
      'real_open, real_read, real_unlink = os.open, os.read, os.unlink',
      'def logged_open(path, flags, *a, **k):',
      '    sys.stderr.write(json.dumps({"open": str(path), "dirFd": k.get("dir_fd") is not None}) + "\\n")',
      '    fd = real_open(path, flags, *a, **k)',
      '    sys.stderr.write(json.dumps({"opened": fd}) + "\\n")',
      '    return fd',
      'def logged_read(fd, n):',
      '    sys.stderr.write(json.dumps({"read": fd}) + "\\n")',
      '    return real_read(fd, n)',
      'def logged_unlink(path, **k):',
      '    sys.stderr.write(json.dumps({"unlink": str(path)}) + "\\n")',
      '    return real_unlink(path, **k)',
      'os.open, os.read, os.unlink = logged_open, logged_read, logged_unlink',
      'if real_open in os.supports_dir_fd: os.supports_dir_fd.add(logged_open)',
      'if real_unlink in os.supports_dir_fd: os.supports_dir_fd.add(logged_unlink)',
    ].join('\n');

    /**
     * A complete record carrying this run's own token, so a cleanup that resolved the control
     * directory anywhere but where it was told would remove it — and fail these tests.
     */
    const sentinel = (c: Control) => {
      writeFileSync(join(c.dir, TEMP), JSON.stringify(RECORDED));
      return asFound(join(c.dir, TEMP));
    };

    it.each([
      ['a malformed token', 'arguments', JSON.stringify({ ...RECORD, token: 'nope' }), '', 0],
      ['a missing capability', 'capability', JSON.stringify(RECORD), 'del os.O_NOFOLLOW', 0],
      ['a missing directory', 'directory_missing', JSON.stringify(RECORD), '', 1],
      ['a directory that is a file', 'directory_unusable', JSON.stringify(RECORD), '', 1],
    ] as [string, string, string, string, number][])(
      'refuses %s without touching the sentinel, from the sentinel’s own directory',
      async (_label, reason, input, patch, attemptedOpens) => {
        const c = control();
        const before = sentinel(c);
        const attempted =
          reason === 'directory_missing'
            ? join(c.dir, 'absent')
            : reason === 'directory_unusable'
              ? (writeFileSync(join(c.dir, 'plain'), ''), join(c.dir, 'plain'))
              : c.dir;
        const shim = shimmed(
          c.base,
          `python3-${String(made.length)}-early`,
          `${patch}\n${TOUCHES}`,
        );
        // the helper runs *in* the sentinel's directory: a path resolved against the process,
        // or one level up from the attempted path, would find it
        const { result, stderr } = await release(attempted, input, shim, c.dir);
        expect(result).toMatchObject({ kind: 'refused', reason });
        const events = logged(stderr);
        expect(events.filter((e) => 'opened' in e)).toHaveLength(0); // no descriptor was acquired
        expect(events.filter((e) => 'open' in e)).toHaveLength(attemptedOpens);
        expect(events.filter((e) => 'read' in e || 'unlink' in e)).toEqual([]);
        expect(asFound(join(c.dir, TEMP))).toEqual(before);
      },
    );

    it.each([
      ['the leftover is removed', JSON.stringify(RECORDED), undefined],
      [
        'the leftover is left as another run’s',
        JSON.stringify({ ...RECORDED, token: 'a'.repeat(32) }),
        'temp_unrecognized',
      ],
      ['there is no leftover', undefined, undefined],
    ])(
      'closes every descriptor it opened, and writes one line, when %s',
      async (_label, contents, step) => {
        const c = control();
        expect((await acquire(c.dir)).result).toMatchObject({ kind: 'acquired' });
        if (contents !== undefined) writeFileSync(join(c.dir, TEMP), contents);
        const shim = shimmed(c.base, `python3-${String(made.length)}-cleanup-log`, LOG);
        const { result, stderr } = await release(c.dir, JSON.stringify(RECORD), shim);
        expect(result).toEqual({
          kind: 'released',
          diagnostics: step === undefined ? [] : [{ step, errno: null }],
        });
        const events = logged(stderr);
        const opened = events.filter((e) => 'opened' in e).map((e) => e['opened']);
        expect(opened.length).toBeGreaterThan(1); // the directory, the lock, and any leftover file
        expect(
          events
            .filter((e) => 'close' in e)
            .map((e) => e['close'])
            .sort(),
        ).toEqual([...opened].sort());
      },
    );
  });
});
