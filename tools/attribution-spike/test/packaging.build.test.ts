import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type BuildOptions,
  type BuildOutcome,
  ownedBuild,
  type Presence,
  presence,
} from './owned-build.js';

/**
 * What the build owes `dist`: only what this build put there, and every helper the package has.
 *
 * Everything happens in a fixture package built by pointing the build script at it, so the real
 * `dist` is never rebuilt here — other tests are reading it. A fixture is removed only once the
 * build's whole process group is known to be gone; anything less keeps it, named.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const script = join(packageRoot, 'scripts', 'build.mjs');
const fixtures: { path: string; why?: string }[] = [];

/**
 * Removes what nothing can be writing to and keeps what was marked, reporting every kept path.
 * Called only once each build's process group is known to be gone.
 */
export const dispose = (entries: readonly { path: string; why?: string }[]): string[] => {
  const kept: string[] = [];
  for (const entry of entries) {
    if (entry.why === undefined) rmSync(entry.path, { recursive: true, force: true });
    else kept.push(`kept ${entry.path}: ${entry.why}`);
  }
  return kept;
};

afterEach(() => {
  const kept = dispose(fixtures.splice(0));
  if (kept.length > 0) throw new Error(kept.join('; '));
});

const scratch = (name: string) => {
  const path = mkdtempSync(join(tmpdir(), `pipeline-${name}-`));
  fixtures.push({ path });
  return path;
};
const keep = (path: string, why: string) => {
  const entry = fixtures.find((f) => f.path === path);
  if (entry !== undefined) entry.why = why;
};

/** Waits, bounded, for a group this test owned to be gone. Only `ESRCH` answers. */
const confirmGone = async (pid: number | undefined, within = 20_000) => {
  if (pid === undefined) return true;
  const limit = Date.now() + within;
  while (presence(pid) !== 'gone' && Date.now() < limit)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return presence(pid) === 'gone';
};

/**
 * Everything done with a build this test owned. The fixture is marked **before** any assertion
 * runs, so a failing assertion cannot lose it; the mark is cleared only once that group's absence
 * is confirmed, and a confirmation that fails never replaces the body's own error.
 */
const owned = async (
  root: string,
  built: BuildOutcome,
  body: () => void | Promise<void>,
  confirm: (pid: number | undefined) => Promise<boolean> = confirmGone,
) => {
  if (built.outstanding.length > 0) keep(root, built.outstanding.join('; '));
  try {
    await body();
  } finally {
    // a confirmation that fails establishes nothing, and must never speak over the body's error
    const confirmed = await confirm(built.pid).catch(() => false);
    if (confirmed) {
      const entry = fixtures.find((f) => f.path === root);
      if (entry !== undefined) delete entry.why;
    }
  }
};

/** A package the build script can be pointed at: its own sources, and a `dist` left over from before. */
const fixture = () => {
  const root = scratch('packaging');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  // a module package, so the compiler reads its sources the way this package's are read
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  writeFileSync(join(root, 'src', 'kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(root, 'src', 'existing.py'), '#!/usr/bin/env python3\nprint("existing")\n');
  // named in no build script anywhere: the build has to find it in src
  writeFileSync(join(root, 'src', 'added.py'), '#!/usr/bin/env python3\nprint("added")\n');
  // what an earlier build left: a helper whose source is gone, and a compiled file
  writeFileSync(join(root, 'dist', 'removed.py'), 'print("stale")\n');
  writeFileSync(join(root, 'dist', 'gone.js'), 'export const gone = 1;\n');
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: join(packageRoot, '..', '..', 'tsconfig.base.json'),
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  return root;
};

/** A build that spawns a grandchild in its own group, says so, and then blocks. */
const outliving = (started: string) =>
  [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import process from 'node:process';",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 600000)'], {",
    "  stdio: 'ignore',",
    '});',
    `writeFileSync(${JSON.stringify(started)}, String(child.pid));`,
    'await new Promise(() => undefined);',
    '',
  ].join('\n');
/** The same, but the parent exits normally with its grandchild still running. */
const leavesChild = (started: string) =>
  `${outliving(started).replace('await new Promise(() => undefined);', 'child.unref();\nprocess.exit(0);')}`;

describe('the build', () => {
  it('clears what it did not produce, and ships every helper the package has', async () => {
    const root = fixture();
    const built = await ownedBuild(script, root, { within: 120_000 });
    await owned(root, built, () => {
      expect([built.timedOut, built.exit?.code]).toEqual([false, 0]);
      expect(existsSync(join(root, 'dist', 'removed.py'))).toBe(false); // its source is gone
      expect(existsSync(join(root, 'dist', 'gone.js'))).toBe(false); // and so is its own
      for (const helper of ['existing.py', 'added.py'])
        expect(readFileSync(join(root, 'dist', helper))).toEqual(
          readFileSync(join(root, 'src', helper)),
        );
      expect(existsSync(join(root, 'dist', 'kept.js'))).toBe(true); // the compiler ran
    });
  }, 180_000);

  /**
   * Harness coverage, not a claim about the compiler: a stub stands in for the build so the bound
   * is reached deterministically, and what is checked is this harness's own kill-and-confirm path.
   */
  it('ends a build’s descendants when the bound is reached, and keeps what it cannot confirm', async () => {
    const root = scratch('timeout');
    const started = join(root, 'started');
    const stub = join(root, 'slow-build.mjs');
    writeFileSync(stub, outliving(started));

    // an injected probe that can never confirm: the decision must keep the fixture
    const built = await ownedBuild(stub, root, {
      within: 50,
      probe: () => 'unconfirmed',
      ready: () => existsSync(started),
      readyWithin: 20_000,
    });
    // marked before a single assertion runs: a failing one must not cost the fixture
    await owned(root, built, () => {
      expect(built.timedOut).toBe(true);
      expect(built.failure).toBeUndefined(); // the operation itself did not fail
      expect(built.outstanding).toEqual([`group ${String(built.pid)}: unconfirmed`]);
      expect(fixtures.find((f) => f.path === root)?.why).toContain('unconfirmed');
      expect(existsSync(root)).toBe(true); // kept, because nothing could be established
    });
    expect(presence(Number(readFileSync(started, 'utf8')), 'process')).toBe('gone');
  }, 120_000);

  it('ends a descendant its parent left behind, even when that parent exited normally', async () => {
    const root = scratch('normal-exit');
    const started = join(root, 'started');
    const stub = join(root, 'leaves-child.mjs');
    writeFileSync(stub, leavesChild(started));

    const built = await ownedBuild(stub, root, {
      within: 20_000,
      ready: () => existsSync(started),
      readyWithin: 20_000,
    });
    await owned(root, built, () => {
      expect([built.timedOut, built.exit?.code]).toEqual([false, 0]); // it ended by itself
      expect(built.outstanding).toEqual([]); // and its group was still confirmed gone
      expect(presence(Number(readFileSync(started, 'utf8')), 'process')).toBe('gone');
    });
  }, 120_000);

  it.each([
    ['answers', (() => undefined) as never, 'alive'],
    [
      'reports ESRCH',
      ((): never => {
        throw Object.assign(new Error('probe'), { code: 'ESRCH' });
      }) as never,
      'gone',
    ],
    [
      'reports EPERM',
      ((): never => {
        throw Object.assign(new Error('probe'), { code: 'EPERM' });
      }) as never,
      'unconfirmed',
    ],
    [
      'fails some other way',
      ((): never => {
        throw Object.assign(new Error('probe'), { code: 'EINVAL' });
      }) as never,
      'unconfirmed',
    ],
  ] as [string, (target: number, signal: 0) => unknown, Presence][])(
    'reads a group that %s',
    (_label, ask, expected) => {
      // the mapping itself, asked through a stub: no other process is signalled to establish this
      expect(presence(4_242, 'group', ask)).toBe(expected);
    },
  );

  it('keeps a marked fixture and names it, and removes one that is finished', () => {
    const kept = mkdtempSync(join(tmpdir(), 'pipeline-dispose-kept-'));
    const gone = mkdtempSync(join(tmpdir(), 'pipeline-dispose-gone-'));
    try {
      const report = dispose([{ path: kept, why: 'group 4242: unconfirmed' }, { path: gone }]);
      expect(existsSync(kept)).toBe(true); // something could still be writing there
      expect(existsSync(gone)).toBe(false);
      expect(report).toEqual([`kept ${kept}: group 4242: unconfirmed`]);
    } finally {
      for (const dir of [kept, gone]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arms the execution bound only once readiness holds', async () => {
    const root = scratch('readiness');
    const gate = join(root, 'gate');
    const stub = join(root, 'waits-for-gate.mjs');
    writeFileSync(
      stub,
      [
        "import { existsSync } from 'node:fs';",
        "import process from 'node:process';",
        `const gate = ${JSON.stringify(gate)};`,
        'const limit = Date.now() + 20_000;', // bounded: it cannot outlive the test
        'while (!existsSync(gate) && Date.now() < limit)',
        '  await new Promise((resolve) => setTimeout(resolve, 20));',
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    // what the hook saw: whether readiness was still false when the bound was registered
    const arms: boolean[] = [];

    const run = ownedBuild(stub, root, {
      within: 20_000,
      ready: () => existsSync(gate),
      readyWithin: 20_000,
      onArm: () => arms.push(!existsSync(gate)),
    });
    try {
      // a bounded pause at the barrier: an early registration would have happened by now
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(arms).toEqual([]);

      writeFileSync(gate, ''); // released
      const armed = Date.now() + 20_000;
      while (arms.length === 0 && Date.now() < armed)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(arms).toEqual([false]); // registered once, and only with readiness holding
    } finally {
      writeFileSync(gate, ''); // whatever happened, the stub is let go
      const built = await run;
      if (built.outstanding.length > 0) keep(root, built.outstanding.join('; '));
    }
  }, 120_000);

  it('reaps the group when readiness never arrives, and strands nothing by doing so', async () => {
    const root = scratch('no-readiness');
    const started = join(root, 'started');
    const stub = join(root, 'never-ready.mjs');
    writeFileSync(stub, outliving(started));

    const built = await ownedBuild(stub, root, {
      within: 20_000,
      ready: () => false, // never holds, so the barrier gives up
      readyWithin: 5_000,
    });

    await owned(root, built, () => {
      expect(existsSync(started)).toBe(true); // the owned grandchild really had started
      expect(built.failure).toBe('the build never reported readiness');
      expect(built.timedOut).toBe(false); // no execution deadline was ever created
      expect(built.outstanding).toEqual([]); // the group was still signalled and confirmed
      expect(presence(Number(readFileSync(started, 'utf8')), 'process')).toBe('gone');
      // a failed operation above a group confirmed gone strands nothing: no retention
      expect(fixtures.find((f) => f.path === root)?.why).toBeUndefined();
    });
  }, 120_000);

  it.each([
    [
      'ready throws',
      (started: string): Partial<BuildOptions> => ({
        ready: () => {
          if (!existsSync(started)) return false;
          throw new Error('SENTINEL-SECRET from readiness');
        },
        readyWithin: 5_000,
      }),
    ],
    [
      'onArm throws',
      (started: string): Partial<BuildOptions> => ({
        ready: () => existsSync(started),
        readyWithin: 5_000,
        onArm: () => {
          throw new Error('SENTINEL-SECRET from the arm hook');
        },
      }),
    ],
  ])(
    'reaps the group when %s after the build started',
    async (_label, options) => {
      const root = scratch('callback-throws');
      const started = join(root, 'started');
      const stub = join(root, 'blocks.mjs');
      writeFileSync(stub, outliving(started));

      const built = await ownedBuild(stub, root, { within: 20_000, ...options(started) });

      await owned(root, built, () => {
        expect(existsSync(started)).toBe(true); // the failure came after the group existed
        expect(built.failure).toBe('a callback supplied to the build failed');
        expect(built.timedOut).toBe(false); // the wait it would have run out of never began
        expect(JSON.stringify(built)).not.toContain('SENTINEL');
        expect(built.outstanding).toEqual([]);
        expect(presence(Number(readFileSync(started, 'utf8')), 'process')).toBe('gone');
        expect(fixtures.find((f) => f.path === root)?.why).toBeUndefined();
      });
    },
    120_000,
  );

  it('survives a probe that throws, and keeps the fixture it cannot vouch for', async () => {
    const root = scratch('probe-throws');
    const started = join(root, 'started');
    const stub = join(root, 'blocks.mjs');
    writeFileSync(stub, outliving(started));

    const built = await ownedBuild(stub, root, {
      within: 50,
      ready: () => existsSync(started),
      readyWithin: 5_000,
      probe: () => {
        throw new Error('SENTINEL-SECRET from the probe');
      },
    });
    await owned(root, built, () => {
      // the outcome survived the throw, and says what it could not establish
      expect(built.outstanding).toEqual([`group ${String(built.pid)}: unconfirmed`]);
      expect(JSON.stringify(built)).not.toContain('SENTINEL');
      expect(existsSync(root)).toBe(true); // the retention decision stands
    });
  }, 120_000);

  it('reports a command that cannot start, and leaves its error observed', async () => {
    const root = scratch('no-command');
    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', watch);
    const noisy: NodeJS.UncaughtExceptionListener = (error) => unhandled.push(error);
    process.on('uncaughtException', noisy);
    try {
      const built = await ownedBuild(join(root, 'never-read.mjs'), root, {
        within: 5_000,
        command: join(root, 'no-such-command'),
      });

      expect(built.failure).toBe('the build could not be started');
      expect(built.timedOut).toBe(false); // it never reached a wait to run out of
      expect(built.pid).toBeUndefined();
      expect(built.outstanding).toEqual([]); // there was no group to be uncertain about
      await new Promise((resolve) => setTimeout(resolve, 100)); // a turn for a stray error to land
      expect(unhandled).toEqual([]); // the spawn error was observed where it happened
    } finally {
      process.off('unhandledRejection', watch);
      process.off('uncaughtException', noisy);
    }
  }, 60_000);

  it('asks about a process by its pid, and about a group by the negative of it', () => {
    const asked: number[] = [];
    const ask = (target: number) => void asked.push(target);
    expect([presence(4_242, 'process', ask), presence(4_242, 'group', ask)]).toEqual([
      'alive',
      'alive',
    ]);
    expect(asked).toEqual([4_242, -4_242]); // the scope decides the sign, and nothing else
  });

  it.each([
    ['never confirms', async () => false],
    [
      'fails while confirming',
      async () => {
        throw new Error('the confirmer itself failed');
      },
    ],
  ] as [string, (pid: number | undefined) => Promise<boolean>][])(
    'keeps an unconfirmed fixture, and reports the body’s own error, when the confirmer %s',
    async (_label, confirm) => {
      const root = scratch('unconfirmed-body');
      // fabricated: nothing ran against this fixture, so no real group is ever involved
      const built: BuildOutcome = {
        timedOut: true,
        pid: 4_242,
        outstanding: ['group 4242: unconfirmed'],
      };
      const thrown = new Error('an assertion failed');

      const raised = await owned(
        root,
        built,
        () => {
          throw thrown;
        },
        confirm,
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(raised).toBe(thrown); // the very error the body threw, not one from teardown
      expect(fixtures.find((f) => f.path === root)?.why).toBe('group 4242: unconfirmed');
      expect(existsSync(root)).toBe(true); // marked before the body ran, and never cleared

      // inert: no process ever touched this path, so this test disposes of it itself
      const entry = fixtures.find((f) => f.path === root);
      if (entry !== undefined) delete entry.why;
      rmSync(root, { recursive: true, force: true });
    },
  );
});
