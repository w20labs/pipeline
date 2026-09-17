import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runChild } from '../src/child.js';

/**
 * The snapshot helper on its own, run through `runChild` so every invocation is bounded and its
 * termination awaited, on whatever platform the tests run on.
 */
const HELPER = fileURLToPath(new URL('../src/snapshot-tree.py', import.meta.url));
const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tree = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-snapshot-'));
  made.push(base);
  const root = join(base, 'root');
  mkdirSync(join(root, 'projects', 'slug'), { recursive: true });
  writeFileSync(join(root, 'projects', 'slug', 'a.jsonl'), 'abc');
  symlinkSync('/etc', join(root, 'link'));
  return { base, root };
};

type Line = Record<string, unknown>;
/** Run the helper, bounded, and return its parsed lines — insisting the protocol shape held. */
const snapshot = async (args: string[], python = 'python3') => {
  const outcome = await runChild(python, args, {
    deadline: Date.now() + 10_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn,
    now: Date.now,
    maxOutputBytes: 1_000_000,
  });
  expect(outcome).toMatchObject({ kind: 'closed', exitCode: 0 });
  const stdout = (outcome as { evidence: { stdout: string } }).evidence.stdout;
  expect(stdout.endsWith('\n')).toBe(true);
  const lines = stdout
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
  const done = lines.at(-1) as Line;
  // exactly one done, last, and its counts agree with what came before it
  expect(lines.filter((l) => l['type'] === 'done')).toHaveLength(1);
  expect(done['type']).toBe('done');
  const entries = lines.filter((l) => l['type'] === 'entry');
  const diagnostics = lines.filter((l) => l['type'] === 'diagnostic');
  expect([done['entries'], done['diagnostics']]).toEqual([entries.length, diagnostics.length]);
  return {
    entries,
    diagnostics,
    complete: done['complete'],
    stderr: (outcome as { evidence: { stderr: string } }).evidence.stderr,
  };
};
const run = (root: string, cap = 100) => snapshot([HELPER, '--root', root, '--cap', String(cap)]);

/** A python3 that patches the named names before running the helper. */
const shimmed = (base: string, name: string, patch: string) => {
  const shim = join(base, name);
  writeFileSync(
    shim,
    `#!/bin/sh\nexec python3 -c '\nimport os, runpy, sys\n${patch}\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n' "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
};

describe('the snapshot helper', () => {
  it('records every entry’s metadata exactly, and records a symlink without following it', async () => {
    const t = tree();
    const s = await run(t.root);
    expect(s.complete).toBe(true);
    expect(s.entries.map((e) => [e['path'], e['kind']])).toEqual([
      ['link', 'symlink'],
      ['projects', 'dir'],
      ['projects/slug', 'dir'],
      ['projects/slug/a.jsonl', 'file'],
    ]); // nothing under link/: /etc was never enumerated
    for (const entry of s.entries) {
      // bigint lstat, compared as strings: device and inode survive JSON without precision loss
      const st = lstatSync(join(t.root, entry['path'] as string), { bigint: true });
      expect(entry).toEqual({
        type: 'entry',
        path: entry['path'],
        kind: entry['kind'],
        size: st.size.toString(),
        mtimeNs: st.mtimeNs.toString(),
        dev: st.dev.toString(),
        ino: st.ino.toString(),
      });
    }
  });

  it('opens only directories, anchored and without following links, and never a file', async () => {
    const t = tree();
    const shim = shimmed(
      t.base,
      'python3-log-opens',
      [
        'import builtins, json',
        'real_open, real_builtin = os.open, builtins.open',
        'def logged(path, flags, *a, **k):',
        '    sys.stderr.write(json.dumps({"os.open": str(path), "flags": flags, "required": os.O_DIRECTORY | os.O_NOFOLLOW, "dir_fd": "dir_fd" in k}) + "\\n")',
        '    return real_open(path, flags, *a, **k)',
        'def refused(*a, **k):',
        '    sys.stderr.write(json.dumps({"builtins.open": str(a[0])}) + "\\n")',
        '    return real_builtin(*a, **k)',
        'os.open, builtins.open = logged, refused',
        'os.supports_dir_fd.add(logged)  # the wrapper keeps the capability it wraps',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', t.root, '--cap', '100'], shim);
    const calls = s.stderr
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Line);
    expect(calls.some((c) => 'builtins.open' in c)).toBe(false);
    expect(calls.map((c) => c['os.open'])).toEqual([t.root, 'projects', 'slug']);
    expect(calls.slice(1).every((c) => c['dir_fd'] === true)).toBe(true); // each relative to its parent
    // this platform's own O_DIRECTORY|O_NOFOLLOW bits, reported by the same Python that opened
    for (const c of calls)
      expect((c['flags'] as number) & (c['required'] as number)).toBe(c['required']);
    expect(s.complete).toBe(true);
  });

  it.each([
    ['exactly the cap', 4, true, []],
    ['one fewer than the tree holds', 3, false, ['cap_reached: stopped after 3 entries']],
  ])('keeps entries of every type up to %s', async (_label, cap, complete, messages) => {
    const t = tree();
    const s = await run(t.root, cap);
    expect(s.entries).toHaveLength(cap);
    expect(s.complete).toBe(complete);
    expect(s.diagnostics.map((d) => d['message'])).toEqual(messages);
  });

  it.each([
    [
      'scandir on a descriptor',
      'os.supports_fd.discard(os.scandir)',
      'scandir on a file descriptor',
    ],
    ['stat with dir_fd', 'os.supports_dir_fd.discard(os.stat)', 'stat with dir_fd'],
    [
      'stat without following links',
      'os.supports_follow_symlinks.discard(os.stat)',
      'stat with follow_symlinks=False',
    ],
    ['open with dir_fd', 'os.supports_dir_fd.discard(os.open)', 'open with dir_fd'],
  ])('refuses a Python lacking %s, naming it', async (_label, patch, missing) => {
    const t = tree();
    const s = await snapshot(
      [HELPER, '--root', t.root, '--cap', '100'],
      shimmed(t.base, 'python3-missing', patch),
    );
    expect(s.entries).toEqual([]);
    expect(s.complete).toBe(false);
    expect(s.diagnostics.map((d) => d['message'])).toEqual([`this Python lacks: ${missing}`]);
  });

  it('reads no more of a large directory than the cap allows, not merely emits fewer', async () => {
    const t = tree();
    const big = join(t.root, 'big');
    mkdirSync(big);
    for (let i = 0; i < 101; i += 1) writeFileSync(join(big, `f${i}`), '');
    // counts what scandir actually yields, separately from the entries the helper emits
    const shim = shimmed(
      t.base,
      'python3-count-listing',
      [
        'real_scandir = os.scandir',
        'class Counted:',
        '    def __init__(self, fd): self.inner = real_scandir(fd)',
        '    def __enter__(self): return self',
        '    def __exit__(self, *a): self.inner.close()',
        '    def __iter__(self):',
        '        for entry in self.inner:',
        '            sys.stderr.write("yielded\\n")',
        '            yield entry',
        'os.scandir = Counted',
        'os.supports_fd.add(Counted)',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', big, '--cap', '1'], shim);
    const yielded = s.stderr.split('\n').filter((l) => l === 'yielded').length;
    expect(s.entries).toHaveLength(1);
    expect(yielded).toBe(2); // the cap, plus the one name that shows there are more
    expect(s.diagnostics.map((d) => d['message'])).toEqual([
      'cap_reached: stopped after 1 entries',
    ]);
  });

  it('reports a failed fstat of an opened directory, keeps cleanup diagnostics, and still ends with done', async () => {
    const t = tree();
    const shim = shimmed(
      t.base,
      'python3-fstat-fails',
      [
        'import errno',
        'real_close = os.close',
        'def failing_fstat(fd): raise OSError(errno.EIO, os.strerror(errno.EIO))',
        'def failing_close(fd):',
        '    real_close(fd)',
        '    raise OSError(errno.EBADF, os.strerror(errno.EBADF))',
        'os.fstat, os.close = failing_fstat, failing_close',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', t.root, '--cap', '100'], shim); // exit 0, one done
    expect(s.complete).toBe(false);
    expect(s.entries.map((e) => e['path'])).toEqual(['link', 'projects']); // not descended into
    expect(s.diagnostics.map((d) => d['message'])).toEqual([
      'projects: cannot stat the opened directory: Input/output error',
      'projects: close failed: Bad file descriptor',
      'root: close failed: Bad file descriptor',
    ]);
  });

  it('reports every close that failed, before done, and marks the snapshot incomplete', async () => {
    const t = tree();
    const shim = shimmed(
      t.base,
      'python3-close-fails',
      [
        'import errno',
        'real_close = os.close',
        'def failing(fd):',
        '    real_close(fd)',
        '    raise OSError(errno.EBADF, os.strerror(errno.EBADF))',
        'os.close = failing',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', t.root, '--cap', '100'], shim);
    expect(s.entries).toHaveLength(4); // the walk itself still completed its observations
    expect(s.complete).toBe(false);
    expect(s.diagnostics.map((d) => d['message'])).toEqual([
      'projects/slug: close failed: Bad file descriptor',
      'projects: close failed: Bad file descriptor',
      'root: close failed: Bad file descriptor',
    ]);
  });
});
