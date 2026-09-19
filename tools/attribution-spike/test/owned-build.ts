import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * Running a build as a process group this test owns.
 *
 * A build spawns a compiler of its own, so the outer process exiting — normally, on a bound, or not
 * at all — establishes nothing about what it started. The group is recorded before any callback can
 * run, and **every** path ends in the same bounded signal-and-probe: readiness refused, a callback
 * that threw, a command that could not start, or an ordinary finish.
 *
 * Two facts are kept apart. `failure` is what went wrong with the operation. `outstanding` is only
 * what could not be established about the group — and a caller keeps a workspace on that alone,
 * because a readiness error above a group confirmed gone strands nothing.
 *
 * Only `ESRCH` means absent: a permission error, another failure, or a probe that throws leaves the
 * group unconfirmed.
 */
export type Presence = 'gone' | 'alive' | 'unconfirmed';

export const presence = (
  pid: number,
  scope: 'group' | 'process' = 'group',
  ask: (target: number, signal: 0) => unknown = process.kill,
): Presence => {
  try {
    ask(scope === 'group' ? -pid : pid, 0);
    return 'alive';
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unconfirmed';
  }
};

export interface BuildOutcome {
  /** The group this build owned, once it had one. */
  readonly pid?: number;
  readonly exit?: { code: number | null; signal: NodeJS.Signals | null };
  /** True only when the execution wait ran out; a failure before it ever began is not a timeout. */
  readonly timedOut: boolean;
  /** What went wrong with the operation itself, in fixed words. */
  readonly failure?: string;
  /** What could not be established about the group. Retention follows this, and nothing else. */
  readonly outstanding: readonly string[];
}

export interface BuildOptions {
  readonly within: number;
  readonly probe?: (pid: number) => Presence;
  /** Waited for, bounded, before the bound below begins: a bound spent waiting to start says nothing. */
  readonly ready?: () => boolean;
  readonly readyWithin?: number;
  /** Called once, when the execution bound is registered: never before readiness holds. */
  readonly onArm?: () => void;
  /** The command to run, so a test can point at one that cannot start. */
  readonly command?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signals the group and waits, bounded, for proof it is gone. A probe that throws tells us nothing. */
const reap = async (pid: number, probe: (pid: number) => Presence): Promise<string[]> => {
  const outstanding: string[] = [];
  const ask = (): Presence => {
    try {
      return probe(pid);
    } catch {
      return 'unconfirmed';
    }
  };
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') outstanding.push(`group ${String(pid)}: SIGKILL ${String(code)}`);
  }
  const limit = Date.now() + 5_000;
  let seen = ask();
  while (seen !== 'gone' && Date.now() < limit) {
    await sleep(20);
    seen = ask();
  }
  if (seen !== 'gone') outstanding.push(`group ${String(pid)}: ${seen}`);
  return outstanding;
};

export const ownedBuild = async (
  script: string,
  root: string,
  options: BuildOptions = { within: 120_000 },
): Promise<BuildOutcome> => {
  const probe = options.probe ?? ((pid: number) => presence(pid));
  const child = spawn(options.command ?? process.execPath, [script, root], {
    detached: true,
    stdio: 'ignore',
  });
  // observed before anything can return: a command that cannot start emits this afterwards
  let startup: string | undefined;
  child.once('error', () => (startup ??= 'the build could not be started'));
  let exit: BuildOutcome['exit'];
  child.once('exit', (code, signal) => (exit = { code, signal }));
  const pid = child.pid; // held before a callback can throw, so teardown still has it

  const attempt = async (): Promise<string | undefined> => {
    if (pid === undefined) return startup ?? 'the build could not be started';
    if (options.ready !== undefined) {
      const readyBy = Date.now() + (options.readyWithin ?? 20_000);
      while (
        !options.ready() &&
        exit === undefined &&
        startup === undefined &&
        Date.now() < readyBy
      )
        await sleep(20);
      if (!options.ready()) return startup ?? 'the build never reported readiness';
    }
    options.onArm?.();
    const limit = Date.now() + options.within;
    while (exit === undefined && startup === undefined && Date.now() < limit) await sleep(20);
    // recorded where it happens: a wait that ran out, not an absence of events observed later
    timedOut = exit === undefined && startup === undefined;
    return startup;
  };

  let timedOut = false;
  let failure: string | undefined;
  try {
    failure = await attempt();
  } catch {
    // a caller's own code, said in fixed words: nothing it wrote is repeated
    failure = 'a callback supplied to the build failed';
  }
  // whatever happened above, the group this build owned is signalled and probed
  const outstanding = pid === undefined ? [] : await reap(pid, probe);
  return {
    timedOut,
    outstanding,
    ...(pid === undefined ? {} : { pid }),
    ...(exit === undefined ? {} : { exit }),
    ...(failure === undefined ? {} : { failure }),
  };
};
