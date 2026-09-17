import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runChild, type ChildOutcome } from '../src/child.js';
import { takeSnapshot } from '../src/snapshot.js';

/**
 * The snapshot helper on its own, run through `runChild` so every invocation is bounded and its
 * termination awaited, on whatever platform the tests run on.
 */
const HELPER = fileURLToPath(new URL('../src/snapshot-tree.py', import.meta.url));
const made: string[] = [];
const locked: string[] = [];
const running: Promise<unknown>[] = [];
afterEach(async () => {
  // a failed assertion can leave a helper walking the tree: let it end (bounded) before deleting it
  await Promise.allSettled(running.splice(0));
  locked.splice(0).forEach((d) => chmodSync(d, 0o755));
  made.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
}, 15_000);
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
  const pending = runChild(python, args, {
    deadline: Date.now() + 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn,
    now: Date.now,
    maxOutputBytes: 1_000_000,
  });
  running.push(pending);
  const outcome: ChildOutcome = await pending;
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

/**
 * Patch for a shim: before the real `os.<fn>` of `name`, write `<dir>/reached` and wait (bounded)
 * for `<dir>/go`, so the test can change the tree at exactly that point. SIGTERM, if `onSigterm`,
 * ends the wait instead of killing the helper, which then walks on and writes during termination.
 */
const barrier = (fn: 'stat' | 'open', name: string, dir: string, onSigterm = false) =>
  [
    'import signal, time',
    'stop = []',
    onSigterm ? 'signal.signal(signal.SIGTERM, lambda *a: stop.append(1))' : '',
    `real, touch = os.${fn}, os.open`,
    'def gated(path, *a, **k):',
    `    if path == ${JSON.stringify(name)}:`,
    `        os.close(touch(${JSON.stringify(join(dir, 'reached'))}, os.O_CREAT | os.O_WRONLY))`,
    '        until = time.monotonic() + 5',
    `        while not stop and not os.access(${JSON.stringify(join(dir, 'go'))}, os.F_OK) and time.monotonic() < until:`,
    '            time.sleep(0.005)',
    '    return real(path, *a, **k)',
    `os.${fn} = gated`,
    'os.supports_dir_fd.add(gated)',
    'os.supports_follow_symlinks.add(gated)',
  ].join('\n');

/** Wait, bounded, until the helper has reached its barrier. */
const reached = async (dir: string) => {
  const until = Date.now() + 5_000;
  while (!existsSync(join(dir, 'reached'))) {
    if (Date.now() > until) throw new Error('the helper never reached its barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Directories `d/d/…` nested `levels` deep under `root`; returns the deepest path, relative. */
const nest = (root: string, levels: number) => {
  const relative = Array.from({ length: levels }, () => 'd').join('/');
  mkdirSync(join(root, relative), { recursive: true });
  return relative;
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

describe('the snapshot helper while the tree changes under it', () => {
  it.each([
    [
      'removed between listing and stat',
      'stat',
      (root: string) => rmSync(join(root, 'projects'), { recursive: true }),
      ['link'],
      'projects: cannot stat: No such file or directory',
    ],
    [
      'removed between stat and open',
      'open',
      (root: string) => rmSync(join(root, 'projects'), { recursive: true }),
      ['link', 'projects'],
      'projects: cannot open directory: No such file or directory',
    ],
    [
      'swapped for a symlink between stat and open',
      'open',
      (root: string, base: string) => {
        renameSync(join(root, 'projects'), join(base, 'moved'));
        symlinkSync(join(base, 'moved'), join(root, 'projects'));
      },
      ['link', 'projects'],
      'projects: cannot open directory: Not a directory',
    ],
    [
      'swapped for another directory between stat and open',
      'open',
      (root: string, base: string) => {
        renameSync(join(root, 'projects'), join(base, 'moved')); // kept, so its inode is not reused
        mkdirSync(join(root, 'projects'));
      },
      ['link', 'projects'],
      'projects: changed between stat and open',
    ],
  ] as const)('never lists a directory %s', async (_label, fn, change, paths, message) => {
    const t = tree();
    const pending = snapshot(
      [HELPER, '--root', t.root, '--cap', '100'],
      shimmed(t.base, 'python3-barrier', barrier(fn, 'projects', t.base)),
    );
    pending.catch(() => undefined); // awaited below; a failure before then is reported there
    await reached(t.base);
    change(t.root, t.base);
    writeFileSync(join(t.base, 'go'), '');
    const s = await pending;
    expect(s.entries.map((e) => e['path'])).toEqual(paths);
    expect(s.diagnostics.map((d) => d['message'])).toEqual([message]);
    expect(s.complete).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0).each([
    [
      'a directory',
      'projects',
      ['link', 'projects'],
      'projects: cannot open directory: Permission denied',
    ],
    ['the root', '', [], 'cannot open root: Permission denied'],
  ])('reports %s it may not read, without listing it', async (_label, relative, paths, message) => {
    const t = tree();
    const target = join(t.root, relative);
    chmodSync(target, 0o000);
    locked.push(target); // restored before the tree is deleted, even if an assertion fails
    const s = await run(t.root);
    expect(s.entries.map((e) => e['path'])).toEqual(paths);
    expect(s.diagnostics.map((d) => d['message'])).toEqual([message]);
    expect(s.complete).toBe(false);
  });

  it('reports a listing that fails', async () => {
    const t = tree();
    const shim = shimmed(
      t.base,
      'python3-list-fails',
      [
        'import errno',
        'def failing(fd): raise OSError(errno.EIO, os.strerror(errno.EIO))',
        'os.scandir = failing',
        'os.supports_fd.add(failing)',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', t.root, '--cap', '100'], shim);
    expect(s.entries).toEqual([]);
    expect(s.diagnostics.map((d) => d['message'])).toEqual(['.: cannot list: Input/output error']);
    expect(s.complete).toBe(false);
  });

  it.each([
    ['the deepest allowed tree', 64, true],
    ['one level beyond it', 65, false],
  ])('opens %s only down to depth 64', async (_label, levels, complete) => {
    const t = tree();
    const deep = mkdtempSync(join(t.base, 'deep-'));
    const deepest = nest(deep, levels);
    const shim = shimmed(
      t.base,
      'python3-count-opens',
      [
        'real_open = os.open',
        'def counted(path, *a, **k):',
        '    sys.stderr.write("opened\\n")',
        '    return real_open(path, *a, **k)',
        'os.open = counted',
        'os.supports_dir_fd.add(counted)',
      ].join('\n'),
    );
    const s = await snapshot([HELPER, '--root', deep, '--cap', '100'], shim);
    expect(s.entries.map((e) => e['path'])).toEqual(
      Array.from({ length: levels }, (_, i) => deepest.slice(0, 2 * i + 1)),
    );
    // the root and the 64 directories below it; a 65th is recorded but refused before any open
    expect(s.stderr.split('\n').filter((l) => l === 'opened')).toHaveLength(65);
    expect(s.diagnostics.map((d) => d['message'])).toEqual(
      complete ? [] : [`${deepest}: depth_reached: not opened beyond depth 64`],
    );
    expect(s.complete).toBe(complete);
  });
});

describe('a real helper bounded by takeSnapshot', () => {
  const take = (root: string, python: string, withinMs: number, maxLineBytes = 4_096) => {
    const pending = takeSnapshot(root, {
      deadline: Date.now() + withinMs,
      cap: 100,
      maxOutputBytes: 1_000_000,
      maxLineBytes,
      python,
    });
    running.push(pending);
    let settled = false;
    void pending.then(() => (settled = true));
    return { pending, settled: () => settled };
  };

  it('keeps what streamed before a deadline that stopped the walk at its barrier', async () => {
    const t = tree();
    const run = take(
      t.root,
      shimmed(t.base, 'python3-stuck', barrier('stat', 'projects', t.base)),
      1_500,
    );
    await reached(t.base);
    expect(run.settled()).toBe(false); // reached mid-walk before termination, not a slow start
    const s = await run.pending;
    expect(s.entries.map((e) => e.path)).toEqual(['link']);
    expect(s.problems).toEqual([
      'the helper was killed by SIGTERM',
      'the helper exited null',
      'the helper was signalled to stop',
      'the stream has no done',
    ]);
    expect(s.complete).toBe(false);
  });

  it('retains output written during termination, which cannot make the snapshot complete', async () => {
    const t = tree();
    const shim = shimmed(
      t.base,
      'python3-finishes-on-sigterm',
      barrier('stat', 'projects', t.base, true),
    );
    const run = take(t.root, shim, 1_500);
    await reached(t.base);
    expect(run.settled()).toBe(false);
    const s = await run.pending;
    // everything past link was observed only after SIGTERM released the barrier
    expect(s.entries.map((e) => e.path)).toEqual([
      'link',
      'projects',
      'projects/slug',
      'projects/slug/a.jsonl',
    ]);
    expect(s.problems).toEqual(['the helper was signalled to stop']);
    expect(s.complete).toBe(false);
    const settled = structuredClone(s);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s).toEqual(settled);
  });

  it('refuses a real entry line longer than the line bound', async () => {
    const t = tree();
    const root = mkdtempSync(join(t.base, 'long-'));
    writeFileSync(join(root, 'n'.repeat(255)), '');
    const s = await take(root, 'python3', 5_000, 256).pending;
    expect(s.entries).toEqual([]);
    expect(s.problems).toEqual([
      'line 1: longer than 256 bytes',
      'done.entries does not match the entries sent',
    ]);
    expect(s.complete).toBe(false);
  });
});
