import { type ChildProcess, spawn } from 'node:child_process';

import { expect, it } from 'vitest';

import { identify, recordProcess } from '../src/process-identity.js';

/**
 * A real child and the real `ps`. Only this test's own child is ever queried or signalled, and it
 * is signalled through its own handle, never by pid.
 */

/** Resolves true once the child has actually exited, false if it has not by `withinMs`. */
const exited = (child: ChildProcess, ended: Promise<void>, withinMs: number): Promise<boolean> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(true)
    : Promise.race([
        ended.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs)),
      ]);

it('recognises an owned child while it lives, and as absent once it has gone', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  // registered at once, before anything is awaited, so neither event can be missed
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let spawnError: Error | undefined;
  child.once('error', (error) => (spawnError = error));

  const queried: string[] = [];
  const watching = ((command: string, args: string[], options: object) => {
    queried.push(args[3] as string);
    return spawn(command, args, options);
  }) as unknown as typeof spawn;
  const options = () => ({ deadline: Date.now() + 5_000, spawn: watching });

  let failure: unknown;
  try {
    expect(spawnError).toBeUndefined();
    const pid = child.pid as number;
    const recorded = await recordProcess(pid, options());
    if (!recorded.ok) throw new Error(`could not record the child: ${recorded.why}`);
    expect(await identify(recorded.record, options())).toEqual({ kind: 'leftover' });

    child.kill('SIGTERM');
    // a delivered signal is not an exit: wait for the exit itself, bounded
    if (!(await exited(child, ended, 3_000)))
      throw new Error('the child did not exit after SIGTERM');

    const after = await identify(recorded.record, options());
    if (after.kind === 'reused')
      throw new Error(`pid ${pid} was reused already: ${JSON.stringify(after.observed)}`);
    expect(after).toEqual({ kind: 'absent' });
    expect(new Set(queried)).toEqual(new Set([String(pid)])); // nothing but this child was queried
  } catch (cause) {
    failure = cause; // every error lands here, so the cleanup below always runs
  }

  const problems: string[] = [];
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    if (!(await exited(child, ended, 2_000)))
      problems.push(`cleanup: child ${String(child.pid)} did not exit after SIGKILL`);
  }
  // the test's own failure is kept, and any cleanup failure is reported beside it, not instead
  if (failure !== undefined || problems.length > 0)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...problems.map((p) => new Error(p))],
      [failure instanceof Error ? failure.message : undefined, ...problems]
        .filter((m) => m !== undefined)
        .join('; '),
    );
}, 20_000);
