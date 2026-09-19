import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The built package, not the sources: the Python helper is not something tsc emits, so this checks
 * the build puts it beside the compiled module and that a lock can be taken and given back from a
 * working directory that has nothing to do with the repository.
 *
 * The Node process started here spawns helpers of its own, which its own exit does not end. So each
 * run is its own process group, owned by this test, recorded before anything is awaited; cleanup
 * signals the group and removes a directory only once that group is known to be gone.
 */
const built = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');

interface Owned {
  readonly pid: number;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}
/** What a probe can establish about a group. Only ESRCH proves it is gone. */
type Presence = 'gone' | 'alive' | 'unconfirmed';

let groups: Owned[] = [];
let dirs: string[] = [];

/** The signal-0 call itself, injectable so the mapping below can be exercised deterministically. */
type Ask = (target: number, signal: 0) => unknown;
/** The terminating signal, injectable for the same reason. */
type Kill = (target: number, signal: 'SIGKILL') => unknown;

const presence = (
  id: number,
  scope: 'group' | 'process' = 'group',
  ask: Ask = process.kill,
): Presence => {
  try {
    ask(scope === 'group' ? -id : id, 0);
    return 'alive';
  } catch (cause) {
    // EPERM, or anything else, says only that this test could not ask: never that the group ended
    return (cause as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unconfirmed';
  }
};

/**
 * Signals each owned group and waits, bounded, for proof that it is gone — even for a group whose
 * Node process has already exited, since its helpers outlive it. A group that cannot be confirmed
 * is reported, and one failure never skips the groups after it.
 */
const reap = async (
  owned: Owned[],
  probe: (pid: number) => Presence = presence,
  send: Kill = process.kill,
) => {
  const unconfirmed: string[] = [];
  for (const group of owned) {
    try {
      send(-group.pid, 'SIGKILL');
    } catch (cause) {
      // already gone is fine; anything else is reported once the probe has had its say
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') unconfirmed.push(`group ${String(group.pid)}: SIGKILL ${String(code)}`);
    }
    const limit = Date.now() + 2_000;
    let seen = probe(group.pid);
    while (seen !== 'gone' && Date.now() < limit) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = probe(group.pid);
    }
    if (seen !== 'gone') unconfirmed.push(`group ${String(group.pid)}: ${seen}`);
  }
  return unconfirmed;
};

/**
 * The teardown decision: a directory goes only once every process that could still be using it is
 * known to have ended. Anything left unconfirmed keeps every directory and says which and why.
 */
const settle = (unconfirmed: readonly string[], created: readonly string[]) => {
  if (unconfirmed.length > 0)
    throw new Error(
      `termination unconfirmed; kept ${created.join(', ')}: ${unconfirmed.join('; ')}`,
    );
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
};

/**
 * The whole teardown, in one place: claim what this test registered, end it, and decide what
 * happens to the directories. `afterEach` runs exactly this and nothing else, so the step that
 * carries an unconfirmed reap into settlement is somewhere a test can drive it.
 */
const teardown = async (probe?: (pid: number) => Presence, send?: Kill) => {
  const [owned, created] = [groups, dirs]; // claimed before the await: whatever registers while
  [groups, dirs] = [[], []]; // the reaping runs belongs to the next teardown, not to this one
  settle(await reap(owned, probe, send), created);
};

afterEach(() => teardown(), 30_000); // called, never passed: a hook argument is not a probe

/** A signal-0 stub that fails the way the operating system would. */
const errs =
  (code: string): Ask =>
  () => {
    throw Object.assign(new Error('probe'), { code });
  };

const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `pipeline-lock-build-${name}-`));
  dirs.push(dir);
  return dir;
};

/** Node, in its own group, running a script from an unrelated directory. */
const node = (script: string, cwd: string, watchdogMs = 30_000) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    detached: true, // its helpers join this group, so one signal reaches all of them
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('node did not start');
  const group: Owned = { pid };
  groups.push(group); // recorded before anything is awaited
  const stop = () => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* reaped by afterEach, which reports what it cannot confirm */
    }
  };
  const timer = setTimeout(stop, watchdogMs); // bounded: never waits forever
  const output = new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code, signal) => {
      group.exit = { code, signal };
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`node ended ${String(code)} ${String(signal)}`));
    });
    child.once('error', reject);
  });
  return { pid, output, fire: () => (clearTimeout(timer), stop()) };
};

const until = async (ready: () => boolean, within: number) => {
  const limit = Date.now() + within;
  while (!ready()) {
    if (Date.now() >= limit) throw new Error(`not reached within ${String(within)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Node that starts a helper of its own, says so, and then blocks: the helper outlives it. */
const outliving = (marker: string) => `
  const { spawn } = await import('node:child_process');
  spawn('python3', ['-c', 'import os, sys, time; open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(120)', ${JSON.stringify(marker)}], { stdio: 'ignore' });
  await new Promise(() => {});
`;

describe('the built package', () => {
  it('ships the lock helper beside the compiled module', () => {
    expect(existsSync(join(built, 'lock-file.py'))).toBe(true);
  });

  it('takes and gives back a lock from an unrelated working directory', async () => {
    const base = scratch('run');
    const control = join(base, 'control');
    mkdirSync(control);
    const elsewhere = scratch('cwd');
    const script = `
      const { acquireLockBounded, releaseLockBounded, LOCK_HELPER } = await import(${JSON.stringify(pathToFileURL(join(built, 'lock.js')).href)});
      const { readdirSync } = await import('node:fs');
      const owner = { runId: 'run-built', pid: process.pid, startedAt: '2026-09-17T08:30:00Z' };
      const taken = await acquireLockBounded(${JSON.stringify(control)}, owner, { deadline: Date.now() + 20000 });
      const published = readdirSync(${JSON.stringify(control)});
      const given = taken.kind === 'acquired' ? await releaseLockBounded(taken.handle, { deadline: Date.now() + 20000 }) : { kind: 'no handle' };
      process.stdout.write(JSON.stringify({ helper: LOCK_HELPER, taken: taken.kind, published, given: given.kind, left: readdirSync(${JSON.stringify(control)}) }));
    `;
    const run = node(script, elsewhere);
    expect(JSON.parse(await run.output)).toEqual({
      helper: join(built, 'lock-file.py'), // resolved from dist, not from the sources
      taken: 'acquired',
      published: ['run.lock'],
      given: 'released',
      left: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.exit).toEqual({ code: 0, signal: null });
  }, 60_000);

  it('ends the helpers a killed run left behind, and keeps the directory until it can tell', async () => {
    const base = scratch('watchdog');
    const marker = join(base, 'grandchild.pid');
    const run = node(outliving(marker), base, 600_000);
    await until(() => existsSync(marker), 20_000); // the grandchild is up before the watchdog fires
    const grandchild = Number(readFileSync(marker, 'utf8'));
    expect(presence(grandchild, 'process')).toBe('alive');
    run.fire();
    await expect(run.output).rejects.toThrow(); // Node is gone; its helper need not be
    // the watchdog signalled the whole group, so the helper is already gone before any cleanup runs
    await until(() => presence(grandchild, 'process') === 'gone', 5_000);

    // the group stays registered throughout: if any assertion below throws, afterEach still owns
    // it, so nothing deletes a directory whose processes have not been confirmed gone
    // while nothing can be confirmed, the directory stays: a probe that cannot tell is not proof
    expect(await reap(groups, () => 'unconfirmed')).toEqual([
      `group ${String(run.pid)}: unconfirmed`,
    ]);
    expect(existsSync(base)).toBe(true);

    expect(await reap(groups)).toEqual([]); // the owned group, terminated and confirmed gone
    expect(presence(grandchild, 'process')).toBe('gone'); // the helper Node left behind, too
    expect(groups.map((g) => g.pid)).toEqual([run.pid]); // still owned; afterEach removes the rest
  }, 60_000);

  it('ends a helper left behind when only Node was killed', async () => {
    const base = scratch('reap');
    const marker = join(base, 'grandchild.pid');
    const run = node(outliving(marker), base, 600_000);
    await until(() => existsSync(marker), 20_000);
    const grandchild = Number(readFileSync(marker, 'utf8'));

    process.kill(run.pid, 'SIGKILL'); // only Node: nothing has signalled its helper
    await expect(run.output).rejects.toThrow();
    expect(presence(grandchild, 'process')).toBe('alive');

    // registered until confirmation succeeds, so a failure here cannot strand a live helper
    expect(await reap(groups)).toEqual([]); // cleanup itself must end the group, not just Node
    expect(presence(grandchild, 'process')).toBe('gone');
    expect(groups.map((g) => g.pid)).toEqual([run.pid]);
  }, 60_000);

  it.each([
    ['answers', (() => undefined) as Ask, 'alive'],
    ['reports ESRCH', errs('ESRCH'), 'gone'],
    ['reports EPERM', errs('EPERM'), 'unconfirmed'],
    ['fails some other way', errs('EINVAL'), 'unconfirmed'],
  ] as [string, Ask, Presence][])('reads a group that %s', (_label, ask, expected) => {
    // the real mapping, asked through a stub: no other process is signalled to establish this
    expect(presence(4_242, 'group', ask)).toBe(expected);
  });

  it('keeps a directory whenever anything is unconfirmed, and removes it when nothing is', () => {
    const kept = mkdtempSync(join(tmpdir(), 'pipeline-lock-build-teardown-'));
    try {
      // a real directory, and a failure list that cannot be explained away
      expect(() => settle(['group 4242: unconfirmed'], [kept])).toThrow(/termination unconfirmed/);
      expect(existsSync(kept)).toBe(true);
      settle([], [kept]); // nothing unconfirmed: removal is what the policy allows
      expect(existsSync(kept)).toBe(false);
    } finally {
      rmSync(kept, { recursive: true, force: true }); // this fixture is the test's own to clean up
    }
  });

  it('goes on to the next group when one cannot be confirmed', async () => {
    const signalled: number[] = [];
    const send: Kill = (target) => signalled.push(target);
    // neither call touches anything real: the groups here are numbers, not processes
    const probe = (pid: number): Presence => (pid === 4_242 ? 'unconfirmed' : 'gone');
    const unconfirmed = await reap([{ pid: 4_242 }, { pid: 4_243 }], probe, send);
    expect(signalled).toEqual([-4_242, -4_243]); // the second group was signalled all the same
    expect(unconfirmed).toEqual(['group 4242: unconfirmed']); // and the first is still reported
  }, 30_000);

  /**
   * The registries hold fabricated pids for the two tests below. Both remove theirs in `finally`,
   * whatever the assertions did: `afterEach` signals what it finds, and a number that belongs to no
   * process of this test's must never be what it finds.
   */
  const forget = (...fabricated: number[]) => {
    groups = groups.filter((group) => !fabricated.includes(group.pid));
  };

  it('carries an unconfirmed reap into settlement, keeping and naming the directory', async () => {
    const kept = scratch('wiring-kept');
    groups.push({ pid: 4_242 }); // a number, not a process: the injected send reaches nothing real
    const signalled: number[] = [];
    const send: Kill = (target) => {
      signalled.push(target);
      // registered while the reaping runs, so where it lands says which registry teardown claimed
      if (!groups.some((group) => group.pid === 4_244)) groups.push({ pid: 4_244 });
    };
    try {
      await expect(teardown(() => 'unconfirmed', send)).rejects.toThrow(
        `termination unconfirmed; kept ${kept}: group 4242: unconfirmed`,
      );
      expect(existsSync(kept)).toBe(true); // what the failure named is still there to look at
      expect(signalled).toEqual([-4_242]); // the owned group, and only it, reached the real reap
      expect(dirs).toEqual([]); // the originals were claimed before the await, and the marker
      expect(groups.map((group) => group.pid)).toEqual([4_244]); // went to the registry left behind
    } finally {
      forget(4_242, 4_244);
      rmSync(kept, { recursive: true, force: true }); // this fixture is the test's own to clean up
    }
  }, 30_000);

  it('removes the registered directory once the reap confirms there is nothing left', async () => {
    const gone = scratch('wiring-gone');
    groups.push({ pid: 4_243 });
    const signalled: number[] = [];
    try {
      await teardown(
        () => 'gone',
        (target) => void signalled.push(target),
      );
      expect(existsSync(gone)).toBe(false); // settle was given the registry, not an empty list
      expect(signalled).toEqual([-4_243]);
      expect([groups, dirs]).toEqual([[], []]); // nothing registered after the claim, so both empty
    } finally {
      forget(4_243);
      rmSync(gone, { recursive: true, force: true }); // already gone above; kept if an assertion threw
    }
  }, 30_000);
});
