import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * A real process, because the defect is one no stub can show: an open pipe keeps a Node process's
 * event loop alive. The outcome can be returned on time while the caller still cannot exit, and only
 * a separate process's exit time reveals that. So this builds the package and drives the built
 * output from a child of its own.
 */
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const built = pathToFileURL(join(pkgRoot, 'dist', 'child.js')).href;
const run = promisify(execFile);
/**
 * A space in the directory name, on purpose: the pid file's path reaches a shell, and a path that
 * only works when it happens to contain no spaces is a path that was never quoted.
 */
const scratch = mkdtempSync(join(tmpdir(), 'pipeline child process '));
/** The descendant writes its own pid here, which is the only thing that identifies it as ours. */
const pidFile = join(scratch, 'descendant.pid');
/** Set once the fixture has been launched, so a missing pid file is then a failure, not a no-op. */
let launched = false;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

/** Resolves true once `pid` is gone, or false if it is still there at `withinMs`. */
const gone = async (pid: number, withinMs: number): Promise<boolean> => {
  const until = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

describe('a caller whose child left a descendant holding stdout', () => {
  afterAll(async () => {
    // Only the process this fixture started, identified by the pid it reported — never by a pattern,
    // which cannot establish ownership and can match an unrelated process or a concurrent run.
    const problems: string[] = [];
    try {
      let pid: number | undefined;
      try {
        pid = Number(readFileSync(pidFile, 'utf8').trim());
      } catch {
        // Before launch there is nothing to stop. After it, a missing file means a descendant may be
        // running that cleanup cannot identify — which is reported, never passed over in silence.
        pid = undefined;
        if (launched) problems.push(`the fixture launched but left no pid file at ${pidFile}`);
      }
      if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0))
        problems.push(`the recorded descendant pid is not a pid: ${String(pid)}`);
      else if (pid !== undefined && alive(pid)) {
        process.kill(pid, 'SIGTERM');
        if (!(await gone(pid, 2_000))) {
          process.kill(pid, 'SIGKILL');
          if (!(await gone(pid, 2_000)))
            problems.push(`descendant ${pid} survived SIGTERM and SIGKILL`);
        }
      }
    } catch (cause) {
      problems.push(`stopping the descendant failed: ${(cause as Error).message}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
  }, 10_000);

  it('exits once the outcome is reported, without waiting for the descendant', async () => {
    const script = `
      import { spawn } from 'node:child_process';
      const { runChild } = await import(${JSON.stringify(built)});
      const began = Date.now();
      // the path is the shell's $1, never spliced into the command text, so no character in it can
      // change what the shell does with it
      const command = 'echo parent; sleep 3 & echo $! > "$1"; exit 0';
      const outcome = await runChild('/bin/sh', ['-c', command, 'sh', ${JSON.stringify(pidFile)}], {
        deadline: began + 300, termGraceMs: 50, killGraceMs: 50, spawn, now: Date.now,
      });
      process.stdout.write(JSON.stringify({ outcome, reportedAfter: Date.now() - began }));
    `;
    expect(scratch).toContain(' '); // the regression: this only proves anything with a space present
    const began = Date.now();
    launched = true;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 10_000,
    });
    const callerExitedAfter = Date.now() - began;
    const { outcome, reportedAfter } = JSON.parse(stdout) as {
      outcome: {
        kind: string;
        exitCode: number;
        outputComplete: boolean;
        evidence: { stdout: string };
      };
      reportedAfter: number;
    };

    expect(outcome).toMatchObject({
      kind: 'exited',
      exitCode: 0,
      outputComplete: false, // released, not closed: no close is fabricated
      evidence: { stdout: 'parent\n' },
    });
    expect(reportedAfter).toBeLessThan(1_000);
    // the descendant holds stdout for 3s; a caller still bound to that pipe could not exit before it
    expect(callerExitedAfter).toBeLessThan(2_000);
    // and the fixture really did leave one running, so the timing above is measuring something
    expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(true);
  }, 30_000);
});
