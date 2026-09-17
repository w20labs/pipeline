import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROL_HELPER,
  type ControlReadOptions,
  MAX_CAP,
  readControlFile,
} from '../src/control-file.js';

/** The real helper through the wrapper. Every process here is the test's own child. */

interface Ended {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
}
interface Tracked {
  readonly child: ChildProcess;
  readonly kills: { signal: string; at: number }[];
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
  child.once('exit', (code, signal) => (t.exit = { code, signal, at: Date.now() }));
  child.once('close', (code, signal) => (t.close = { code, signal, at: Date.now() }));
  child.once('error', (error) => (t.error = error));
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    t.kills.push({ signal: String(signal), at: Date.now() });
    return kill(signal);
  };
  return child;
}) as unknown as typeof spawn;

const read = (dir: string, name: string, over: Partial<ControlReadOptions> = {}) => {
  const result = readControlFile(dir, name, {
    deadline: Date.now() + 10_000,
    cap: 64,
    spawn: trackingSpawn,
    ...over,
  });
  pending.push(result);
  return result;
};

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

const control = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-control-process-'));
  dirs.push(base);
  const dir = join(base, 'control');
  mkdirSync(dir);
  return { base, dir };
};
const ended = (t: Tracked | undefined) => ({
  code: t?.exit?.code,
  signal: t?.exit?.signal,
  kills: t?.kills.map((k) => k.signal),
});

describe('the control-file helper, run for real through the wrapper', () => {
  it.each([
    [
      'a file under the cap',
      (c: { dir: string }) => (writeFileSync(join(c.dir, 'f'), 'abc'), c.dir),
      64,
      { kind: 'read', bytes: Buffer.from('abc') },
    ],
    ['a missing file', (c: { dir: string }) => c.dir, 64, { kind: 'missing' }],
    [
      'a symlinked file',
      (c: { base: string; dir: string }) => (
        writeFileSync(join(c.base, 't'), 'x'),
        symlinkSync(join(c.base, 't'), join(c.dir, 'f')),
        c.dir
      ),
      64,
      { kind: 'refused', reason: 'symlink', errno: 'ELOOP', diagnostics: [] },
    ],
    [
      'a directory given with a trailing slash',
      (c: { dir: string }) => `${c.dir}/`,
      64,
      { kind: 'refused', reason: 'arguments', errno: null, diagnostics: [] },
    ],
    [
      'a file over the cap',
      (c: { dir: string }) => (writeFileSync(join(c.dir, 'f'), 'abcdefgh'), c.dir),
      4,
      { kind: 'refused', reason: 'too_large', errno: null, diagnostics: [] },
    ],
  ])(
    'reports %s exactly, from a clean exit with no signal sent',
    async (_label, arrange, cap, expected) => {
      const dir = arrange(control());
      expect(await read(dir, 'f', { cap })).toEqual(expected);
      expect(ended(tracked[0])).toEqual({ code: 0, signal: null, kills: [] });
    },
  );

  it('agrees with the helper on MAX_CAP', () => {
    const script = `import runpy; print(runpy.run_path(${JSON.stringify(CONTROL_HELPER)})["MAX_CAP"])`;
    const python = execFileSync('python3', ['-c', script], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(Number(python.trim())).toBe(MAX_CAP);
  });

  it('abandons a helper held at its open barrier, and proves it exited', async () => {
    const c = control();
    writeFileSync(join(c.dir, 'f'), 'never read');
    const [reached, afterOpen] = [join(c.base, 'reached'), join(c.base, 'after-open')];
    const shim = join(c.base, 'python3-barrier');
    const patch = [
      'import time',
      'real_open = os.open',
      'def gated(path, flags, *a, **k):',
      '    if "dir_fd" in k:',
      `        open(${JSON.stringify(reached)}, "w").close()`,
      '        until = time.monotonic() + 10  # bounded even if no signal ever arrives',
      '        while time.monotonic() < until: time.sleep(0.05)',
      `        open(${JSON.stringify(afterOpen)}, "w").close()`,
      '    return real_open(path, flags, *a, **k)',
      'os.open = gated',
      'os.supports_dir_fd.add(gated)',
    ].join('\n');
    writeFileSync(
      shim,
      `#!/bin/sh\nexec python3 -c '\nimport os, runpy, sys\n${patch}\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")\n' "$@"\n`,
      { mode: 0o755 },
    );

    // SIGTERM is due 400 ms before the deadline; the barrier must be reached before anything is signalled
    const result = read(c.dir, 'f', { deadline: Date.now() + 3_000, python: shim });
    const waitUntil = Date.now() + 2_500;
    while (!existsSync(reached) && Date.now() < waitUntil)
      await new Promise((r) => setTimeout(r, 20));
    const child = tracked[0];
    expect(existsSync(reached)).toBe(true);
    expect(child?.kills).toEqual([]);

    const r = await result;
    const settledAt = Date.now();
    expect(r).toEqual({
      kind: 'unusable',
      problems: [
        'the helper was killed by SIGTERM',
        'the helper exited null',
        'the helper was signalled to stop',
        'the output is not exactly one line',
      ],
    });
    // primary evidence: the child's own exit event, before the result settled; not the deadline, not a signal sent
    expect(ended(child)).toEqual({ code: null, signal: 'SIGTERM', kills: ['SIGTERM'] });
    expect(child?.exit?.at).toBeLessThanOrEqual(settledAt);

    const settled = structuredClone(r);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(r).toEqual(settled);
    expect(Object.isFrozen(r)).toBe(true);
    // no progress past the barrier during the observation; the observed exit means none can come later
    expect(existsSync(afterOpen)).toBe(false);
  }, 15_000);
});
