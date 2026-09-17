import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runChild } from '../src/child.js';

/** The control-file helper on its own, on a real filesystem, bounded through `runChild`. */
const HELPER = fileURLToPath(new URL('../src/read-control-file.py', import.meta.url));
const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const control = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-control-'));
  made.push(base);
  const dir = join(base, 'control');
  mkdirSync(dir);
  return { base, dir };
};

/** A python3 that runs `patch` first; every shim logs to stderr, never stdout. */
const shimmed = (base: string, patch: string) => {
  const shim = join(base, `python3-${String(made.length)}-${String(Math.random()).slice(2)}`);
  writeFileSync(
    shim,
    `#!/bin/sh\nexec python3 -c '\nimport os, runpy, sys\n${patch}\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n' "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
};

const run = async (args: string[], python = 'python3') => {
  const started = Date.now();
  const outcome = await runChild(python, [HELPER, ...args], {
    deadline: Date.now() + 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn,
    now: Date.now,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
  const { stdout, stderr } = (outcome as { evidence: { stdout: string; stderr: string } }).evidence;
  expect(stdout.endsWith('\n') && stdout.indexOf('\n') === stdout.length - 1).toBe(true); // one line
  return {
    result: JSON.parse(stdout) as Record<string, unknown>,
    stderr,
    ms: Date.now() - started,
  };
};
const read = (dir: string, name: string, cap: number, python?: string) =>
  run(['--dir', dir, '--name', name, '--cap', String(cap)], python);
const refused = (reason: string, errno: string | null = null, diagnostics: unknown[] = []) => ({
  kind: 'refused',
  reason,
  errno,
  diagnostics,
});
const b64 = (text: string) => Buffer.from(text).toString('base64');
const readOf = (body: string) => ({ kind: 'read', base64: b64(body), diagnostics: [] });

type Control = ReturnType<typeof control>;
const aFile = (c: Control) => writeFileSync(join(c.dir, 'f'), 'x');
const aDirectory = (c: Control) => mkdirSync(join(c.dir, 'f'));
const aSymlink = (c: Control) => symlinkSync('/etc/hosts', join(c.dir, 'f'));
const nothing = () => undefined;

/** Logs each open attempt (flags, descriptor-relative or not), each descriptor it returned, and each close. */
const LOG_DESCRIPTORS = [
  'import json',
  'real_open, real_close = os.open, os.close',
  'def logged_open(path, flags, *a, **k):',
  '    sys.stderr.write(json.dumps({"open": str(path), "nofollow": bool(flags & os.O_NOFOLLOW), "dirFd": isinstance(k.get("dir_fd"), int)}) + "\\n")',
  '    fd = real_open(path, flags, *a, **k)  # logged first, so a refused open is still seen',
  '    sys.stderr.write(json.dumps({"opened": fd}) + "\\n")',
  '    return fd',
  'def logged_close(fd):',
  '    sys.stderr.write(json.dumps({"close": fd}) + "\\n")',
  '    real_close(fd)',
  'os.open, os.close = logged_open, logged_close',
  'if real_open in os.supports_dir_fd: os.supports_dir_fd.add(logged_open)  # never grant a missing capability',
].join('\n');
/** The JSON lines a shim wrote to stderr. */
const logged = <T = Record<string, unknown>>(stderr: string) =>
  stderr.split('\n').flatMap((l) => (l === '' ? [] : [JSON.parse(l) as T]));

/** Makes `os.<target>` raise `code` whenever `when` holds, and behave normally otherwise. */
const raising = (target: string, code: string, when = 'True') =>
  [
    'import errno',
    `real_${target} = os.${target}`,
    'def failing(*a, **k):',
    `    if ${when}: raise OSError(errno.${code}, os.strerror(errno.${code}))`,
    `    return real_${target}(*a, **k)`,
    `os.${target} = failing`,
    'os.supports_dir_fd.add(failing)',
  ].join('\n');

describe('the control-file helper', () => {
  it.each([
    ['under the cap', 'abc', 8, ''],
    ['exactly at the cap', 'abcd', 4, ''],
    ['at the maximum cap', 'abc', 2 ** 20, ''],
    [
      'through one-byte short reads',
      'short reads',
      64,
      'real = os.read\nos.read = lambda fd, n: real(fd, 1)',
    ],
  ])('reads a regular file %s, exactly', async (_label, body, cap, patch) => {
    const c = control();
    writeFileSync(join(c.dir, 'f'), body);
    expect((await read(c.dir, 'f', cap, shimmed(c.base, patch))).result).toEqual(readOf(body));
  });

  // Both modes are needed: whole reads catch an unbounded request; one-byte reads catch a loop that
  // stops at the cap and would accept a larger file as a truncated read.
  it.each([
    ['whole', 'n'],
    ['one-byte', '1'],
  ])(
    'refuses a file over the cap with %s reads, having read exactly cap + 1 bytes',
    async (_mode, size) => {
      const c = control();
      writeFileSync(join(c.dir, 'f'), 'x'.repeat(10_000));
      const counting = [
        'import json',
        'real = os.read',
        `def counted(fd, n):\n    data = real(fd, ${size})\n    sys.stderr.write(json.dumps(len(data)) + "\\n")\n    return data`,
        'os.read = counted',
      ].join('\n');
      const { result, stderr } = await read(c.dir, 'f', 4, shimmed(c.base, counting));
      expect(result).toEqual(refused('too_large'));
      expect(logged<number>(stderr).reduce((a, b) => a + b, 0)).toBe(5);
    },
  );

  it('refuses a symlink through a descriptor-relative O_NOFOLLOW open, never touching its target', async () => {
    const c = control();
    writeFileSync(join(c.base, 'target'), 'SECRET');
    symlinkSync(join(c.base, 'target'), join(c.dir, 'f'));
    const { result, stderr } = await read(c.dir, 'f', 64, shimmed(c.base, LOG_DESCRIPTORS));
    expect(result).toEqual(refused('symlink', 'ELOOP'));
    // the kernel refused an open relative to the directory descriptor, with O_NOFOLLOW set
    expect(logged(stderr).filter((e) => 'open' in e)).toEqual([
      { open: c.dir, nofollow: true, dirFd: false },
      { open: 'f', nofollow: true, dirFd: true },
    ]);
    expect(JSON.stringify(result)).not.toContain(b64('SECRET'));
  });

  it('refuses a FIFO without blocking on it', async () => {
    const c = control();
    execFileSync('mkfifo', [join(c.dir, 'f')]);
    const { result, ms } = await read(c.dir, 'f', 64);
    expect(result).toEqual(refused('not_regular'));
    expect(ms).toBeLessThan(3_000); // no writer ever opens it
  });

  it.each([
    ['a directory named like the file', aDirectory, 'dir', refused('not_regular')],
    ['a missing file', nothing, 'dir', { kind: 'missing', diagnostics: [] }],
    ['a missing control directory', nothing, 'absent', refused('directory_missing', 'ENOENT')],
    [
      'a control directory that is a file',
      (c: Control) => writeFileSync(join(c.base, 'plain'), ''),
      'plain',
      refused('directory_unusable', 'ENOTDIR'),
    ],
    [
      'a control directory that is a symlink', // refused on the directory: nothing under it is opened
      (c: Control) => (aFile(c), symlinkSync(c.dir, join(c.base, 'link'))),
      'link',
      // ENOTDIR on both platforms: CI's Ubuntu gave the same for the snapshot helper's identical flags
      refused('directory_unusable', 'ENOTDIR'),
    ],
  ])('tells %s apart', async (_label, arrange, where, expected) => {
    const c = control();
    arrange(c);
    const dir = where === 'dir' ? c.dir : join(c.base, where);
    expect((await read(dir, 'f', 64)).result).toEqual(expected);
  });

  it.each([
    ['open', raising('open', 'EACCES', '"dir_fd" in k'), refused('open_failed', 'EACCES')],
    ['fstat', raising('fstat', 'EIO'), refused('fstat_failed', 'EIO')],
    ['read', raising('read', 'EIO'), refused('read_failed', 'EIO')],
  ])('refuses when %s fails, naming only the errno', async (_label, patch, expected) => {
    const c = control();
    writeFileSync(join(c.dir, 'f'), 'x');
    expect((await read(c.dir, 'f', 64, shimmed(c.base, patch))).result).toEqual(expected);
  });

  /** Closes normally, then raises for the descriptor that was opened `index`-th (0: directory, 1: file). */
  const closeFails = (index: number) =>
    [
      'import errno',
      'opened = []',
      'real_open, real_close = os.open, os.close',
      'def tracked(*a, **k):\n    fd = real_open(*a, **k)\n    opened.append(fd)\n    return fd',
      'def failing(fd):\n    real_close(fd)',
      `    if opened.index(fd) == ${String(index)}: raise OSError(errno.EBADF, "bad")`,
      'os.open, os.close = tracked, failing',
      'os.supports_dir_fd.add(tracked)',
    ].join('\n');
  it.each([
    ['the file', true, 1, 'close_file'],
    ['the directory', true, 0, 'close_directory'],
    ['the directory, when the file is missing', false, 0, 'close_directory'],
  ])('discards the result when closing %s fails', async (_label, present, index, step) => {
    const c = control();
    if (present) writeFileSync(join(c.dir, 'f'), 'KEEP OUT');
    const { result } = await read(c.dir, 'f', 64, shimmed(c.base, closeFails(index)));
    expect(result).toEqual(refused('close_failed', null, [{ step, errno: 'EBADF' }]));
    expect(JSON.stringify(result)).not.toContain(b64('KEEP OUT'));
  });

  it.each([
    ['the name .', ['--name', '.', '--cap', '64']],
    ['the name ..', ['--name', '..', '--cap', '64']],
    ['a name with /', ['--name', 'a/b', '--cap', '64']],
    ['a name with \\', ['--name', 'a\\b', '--cap', '64']],
    ['an empty name', ['--name', '', '--cap', '64']],
    ['a zero cap', ['--name', 'f', '--cap', '0']],
    ['a negative cap', ['--name', 'f', '--cap', '-1']],
    ['a fractional cap', ['--name', 'f', '--cap', '1.5']],
    ['a cap over 1 MiB', ['--name', 'f', '--cap', String(2 ** 20 + 1)]],
    ['a 5,000-digit cap', ['--name', 'f', '--cap', '9'.repeat(5_000)]],
    ['a relative directory', ['--name', 'f', '--cap', '8'], 'control'],
    ['a missing flag', ['--name', 'f']],
  ])('refuses %s before opening anything', async (_label, args, dir?: string) => {
    const c = control();
    const { result, stderr } = await run(
      ['--dir', dir ?? c.dir, ...args],
      shimmed(c.base, LOG_DESCRIPTORS),
    );
    expect(result).toEqual(refused('arguments'));
    expect(logged(stderr)).toEqual([]);
  });

  // O_NOFOLLOW guards only the final component: each of these would resolve through a link first
  it.each([
    ['a link with a trailing slash', 'link/'],
    ['a link followed by .', 'link/.'],
    ['a directory with a trailing slash', 'control/'],
    ['a path through ..', 'control/../control'],
  ])('refuses %s as the control directory, opening nothing', async (_label, suffix) => {
    const c = control();
    writeFileSync(join(c.dir, 'f'), 'BEHIND THE LINK');
    symlinkSync(c.dir, join(c.base, 'link'));
    const { result, stderr } = await run(
      ['--dir', `${c.base}/${suffix}`, '--name', 'f', '--cap', '64'],
      shimmed(c.base, LOG_DESCRIPTORS),
    );
    expect(result).toEqual(refused('arguments'));
    expect(logged(stderr)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(b64('BEHIND THE LINK'));
  });

  it('rejects a NUL in the name, checked in-process because argv cannot carry one', () => {
    const script = `import runpy; m = runpy.run_path(${JSON.stringify(HELPER)}); print(m["valid_name"]("a\\0b"))`;
    expect(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim()).toBe('False');
  });

  it.each([
    'os.supports_dir_fd.discard(os.open)',
    'del os.O_NOFOLLOW',
    'del os.O_NONBLOCK',
    'del os.O_DIRECTORY',
    'del os.O_CLOEXEC',
  ])('refuses without the capability removed by %s, opening nothing', async (patch) => {
    const c = control();
    writeFileSync(join(c.dir, 'f'), 'x');
    // the capability is removed first; the logger then records any open that still happens
    const { result, stderr } = await read(
      c.dir,
      'f',
      64,
      shimmed(c.base, `${patch}\n${LOG_DESCRIPTORS}`),
    );
    expect(result).toEqual(refused('capability'));
    expect(logged(stderr)).toEqual([]);
  });

  it.each([
    ['a read', aFile, ''],
    ['a missing file', nothing, ''],
    ['a symlink', aSymlink, ''],
    ['a non-regular file', aDirectory, ''],
    ['a failed fstat', aFile, raising('fstat', 'EIO')],
  ])('closes every descriptor it opened after %s', async (_label, arrange, failure) => {
    const c = control();
    arrange(c);
    const { stderr } = await read(
      c.dir,
      'f',
      64,
      shimmed(c.base, `${LOG_DESCRIPTORS}\n${failure}`),
    );
    const events = logged(stderr);
    const opened = events.filter((e) => 'opened' in e).map((e) => e['opened']);
    const closed = events.filter((e) => 'close' in e).map((e) => e['close']);
    expect(opened.length).toBeGreaterThan(0);
    expect(closed).toEqual([...opened].reverse()); // each exactly once, file before directory
  });
});
