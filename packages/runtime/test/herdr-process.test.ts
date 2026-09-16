import { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeadlineEpochMs, ExecutionId, ProcessObservation } from '../src/adapter.js';
import { createGateRunner, type GateRunnerOptions } from '../src/herdr/process.js';

const dir = mkdtempSync(join(tmpdir(), 'pipeline-gate-'));
/** A node script on disk, so the shell command stays readable and quoting stays honest. */
const script = (name: string, body: string) => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body, 'utf8');
  return `${process.execPath} ${path}`;
};

/** Bounded wait for a marker file, so a hung child fails the test instead of the suite. */
const waitFor = async (path: string, within = 5_000) => {
  const until = Date.now() + within;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const marker = (name: string) => {
  const path = join(dir, name);
  rmSync(path, { force: true });
  return path;
};

/**
 * Look again until the runtime holds a result.
 *
 * A shut-down runtime waits for nothing, so an observation of a gate that has not published yet is
 * answered `cancelled` at once. The result still arrives; finding it means asking again. The marker
 * a child writes says it is about to exit, not that its streams have closed.
 */
const eventually = async (look: () => Promise<ProcessObservation>, within = 5_000) => {
  const until = Date.now() + within;
  for (;;) {
    const observation = await look();
    if (observation.kind === 'completed') return observation;
    if (Date.now() > until) throw new Error(`still ${observation.kind} after ${within}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A dispatch that must never happen: reaching it is the defect, not an error to handle. */
let spawnAttempts = 0;
const refuseToSpawn = (() => {
  spawnAttempts += 1;
  throw new Error('nothing should have been dispatched');
}) as unknown as typeof spawn;

/** A deadline no test here should ever reach, for the cases that are not about deadlines. */
const LATER = () => Date.now() + 30_000;

const run = async (command: string, options: GateRunnerOptions = {}, deadline = LATER()) => {
  const runner = createGateRunner(options);
  const launch = runner.start({ node: 'test_gate', command, cwd: dir }, LATER());
  return {
    launch,
    started: await launch.started,
    observed: await runner.observe(launch.executionId, deadline),
    observeAgain: () => runner.observe(launch.executionId, LATER()),
    runner,
  };
};
const completed = (observation: ProcessObservation) => {
  if (observation.kind !== 'completed')
    throw new Error(`expected completed, got ${observation.kind}`);
  return observation;
};

describe('running a gate', () => {
  it('hands back an identity before any output, and accepts the launch', async () => {
    const runner = createGateRunner();
    const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir }, LATER());
    expect(launch.executionId).toBeTruthy(); // available synchronously
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
  });

  it('returns the handle before it dispatches anything', async () => {
    let dispatched = 0;
    const runner = createGateRunner({
      // `typeof spawn` is a set of overloads; a single arrow matching the general one is not
      // assignable to it, so the double is cast the way every other double here is.
      spawn: ((...args: Parameters<typeof spawn>) => {
        dispatched += 1;
        return spawn(...args);
      }) as unknown as typeof spawn,
    });
    const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir }, LATER());
    expect(launch.executionId).toBeTruthy();
    expect(dispatched).toBe(0); // nothing is started while the caller has no handle yet
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
    expect(dispatched).toBe(1); // and it is dispatched once, afterwards
  });

  it('completes a command that reads to end of input', async () => {
    // stdin is not inherited, so a gate that reads it sees EOF instead of waiting forever
    const { observed } = await run('cat; printf "read\n"');
    expect(completed(observed)).toMatchObject({ exitStatus: 0, output: 'read\n' });
  });

  it.each([
    ['a passing gate', 'printf "12 passing\\n"; exit 0', 0, '12 passing\n'],
    ['a failing gate', 'printf "1 failing\\n" >&2; exit 1', 1, '1 failing\n'],
    ['an unusual status', 'exit 42', 42, ''],
  ])('reports %s as a real result', async (_label, command, status, output) => {
    const { observed } = await run(command);
    expect(completed(observed)).toMatchObject({ exitStatus: status, output });
  });

  it('interprets the command as a shell string, quoting and pipelines intact', async () => {
    const { observed } = await run(`printf 'a b\\nc d\\n' | grep 'c d' | wc -l | tr -d ' '`);
    expect(completed(observed).output).toBe('1\n');
  });

  it('treats a missing inner command as a launch that happened and failed', async () => {
    const { started, observed } = await run('definitely-not-a-command; exit $?');
    expect(started).toEqual({ kind: 'accepted' }); // the shell started, so something ran
    const result = completed(observed);
    expect(result.exitStatus).toBe(127);
    expect(result.output).toMatch(/not found/);
  });

  it('keeps every byte the gate wrote, published after the streams close', async () => {
    // far more than a pipe buffer holds, so output is still in flight when the child exits:
    // publishing on `exit` rather than `close` would report a truncated result here
    const lines = 20_000;
    const { observed } = await run(
      script('bulk', `for (let i = 0; i < ${lines}; i++) process.stdout.write(\`line \${i}\\n\`);`),
    );
    const result = completed(observed);
    const expected = Array.from({ length: lines }, (_, i) => `line ${i}\n`).join('');
    expect(result.output).toHaveLength(expected.length);
    expect(result.output).toBe(expected);
  });

  it('waits for the streams to close, not merely for the shell to exit', async () => {
    // the shell exits immediately while a background job still holds its stdout: publishing on
    // `exit` would report only what had been written by then
    const { observed } = await run(`( sleep 0.3; printf 'late\n' ) & printf 'early\n'`);
    const result = completed(observed);
    expect(result.output).toContain('early');
    expect(result.output).toContain('late');
  });

  it('decodes each stream on its own, so an interleaved chunk cannot corrupt a character', async () => {
    // the halves of one 4-byte character arrive with a stderr write between them
    const { observed } = await run(
      script(
        'straddle',
        `const c = Buffer.from('🙂', 'utf8');
         process.stdout.write(c.subarray(0, 2));
         process.stderr.write('X');
         setTimeout(() => process.stdout.write(c.subarray(2)), 20);`,
      ),
    );
    const result = completed(observed);
    expect(result.output).toContain('🙂'); // not two replacement characters
    expect(result.output).toContain('X');
    expect(result.output).not.toContain('�');
  });

  it('replays the same result to a later observation', async () => {
    const { observed, observeAgain } = await run('printf "once\\n"');
    await expect(observeAgain()).resolves.toEqual(observed);
  });

  it('refuses an execution it never started', async () => {
    const runner = createGateRunner();
    await expect(runner.observe('gate-999' as ExecutionId, LATER())).resolves.toEqual({
      kind: 'unrecoverable',
      executionId: 'gate-999',
      reason: 'unknown_execution',
    });
  });
});

describe('ends that produce no exit status', () => {
  it.each([
    ['a command the runtime rejects outright', { command: 'echo \u0000 bad' }],
    ['a shell that cannot be named', { shell: '' }],
  ])('still hands back an identity when %s', async (_label, shape) => {
    const runner = createGateRunner('shell' in shape ? { shell: shape.shell as string } : {});
    const command = 'command' in shape ? (shape.command as string) : 'echo ok';
    // the handle exists before anything is dispatched, so there is always something to observe
    const launch = runner.start({ node: 'test_gate', command, cwd: dir }, LATER());
    expect(launch.executionId).toBeTruthy();
    const started = await launch.started;
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail.length).toBeGreaterThan(0);
    const observed = await runner.observe(launch.executionId, LATER());
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'spawn_failed' });
  });

  it('refuses an overflowing gate before that gate is able to finish', async () => {
    const release = marker('overflow-release');
    const finished = marker('overflow-finished');
    const runner = createGateRunner({ outputLimit: 1024 });
    const launch = runner.start(
      {
        node: 'test_gate',
        cwd: dir,
        // floods past the cap, then cannot finish until this test says so
        command: script(
          'barrier',
          `import { existsSync, writeFileSync } from 'node:fs';
         process.stdout.write('x'.repeat(64 * 1024));
         const until = Date.now() + 5000;
         const tick = () => {
           if (existsSync(RELEASE) || Date.now() > until) {
             writeFileSync(FINISHED, '1');
             process.exit(0);
           }
           setTimeout(tick, 10);
         };
         tick();`
            .replace('RELEASE', JSON.stringify(release))
            .replace('FINISHED', JSON.stringify(finished)),
        ),
      },
      LATER(),
    );

    const observed = await runner.observe(launch.executionId, LATER());
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    // the gate had not ended, so this refusal cannot have been published at close
    expect(existsSync(finished)).toBe(false);
    writeFileSync(release, '1', 'utf8');
    await waitFor(finished);
    await expect(runner.observe(launch.executionId, LATER())).resolves.toEqual(observed); // retained
  });

  it('keeps draining after the refusal, so the gate is never stuck on a full pipe', async () => {
    const wrote = marker('drain-wrote');
    const runner = createGateRunner({ outputLimit: 1024 });
    const launch = runner.start(
      {
        node: 'test_gate',
        cwd: dir,
        // far more than any pipe buffer: these writes only complete if the parent keeps reading
        command: script(
          'backpressure',
          `import { writeFileSync } from 'node:fs';
         const chunk = 'y'.repeat(64 * 1024);
         for (let i = 0; i < 40; i++) process.stdout.write(chunk);
         process.stdout.end(() => {
           writeFileSync(WROTE, '1');
           process.exit(0);
         });`.replace('WROTE', JSON.stringify(wrote)),
        ),
      },
      LATER(),
    );

    const observed = await runner.observe(launch.executionId, LATER());
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    expect(existsSync(wrote)).toBe(false); // 2.5 MB cannot already be through
    await waitFor(wrote); // progress continued after the refusal: the pipes were still read
    await expect(runner.observe(launch.executionId, LATER())).resolves.toEqual(observed); // survives close
  });

  it('reports a shell that could not start, and retains that', async () => {
    const { started, observed, observeAgain } = await run('echo ok', {
      shell: '/nonexistent/sh',
    });
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail).toContain('ENOENT');
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'spawn_failed' });
    expect((observed as { detail: string }).detail).toContain('ENOENT');
    await expect(observeAgain()).resolves.toEqual(observed); // retained, not recomputed
  });

  it('names the signal that ended the gate itself, and invents no exit status', async () => {
    // `exec` so the shell *becomes* the node process. Without it the shell forks, survives the
    // signal and reports a numeric status of its own — a different fact, covered just below.
    const { started, observed } = await run(
      `exec ${script('killed', 'process.stdout.write("started\\n"); process.kill(process.pid, "SIGKILL");')}`,
    );
    expect(started).toEqual({ kind: 'accepted' }); // it ran; it just did not finish
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'signal_terminated' });
    expect((observed as { detail: string }).detail).toContain('SIGKILL');
    expect(observed).not.toHaveProperty('exitStatus');
  });

  it('keeps a numeric status when the shell outlives a signalled child', async () => {
    // the shell waits for the killed child and exits 128+9 itself: a real status, so a real result
    const { observed } = await run(
      `${script('killed-child', 'process.kill(process.pid, "SIGKILL");')}; exit $?`,
    );
    expect(completed(observed).exitStatus).toBe(137);
  });

  it('refuses a result it could not hold whole, even when the gate then exits zero', async () => {
    const { observed, observeAgain } = await run(
      script(
        'flood',
        'for (let i = 0; i < 400; i++) process.stdout.write("x".repeat(1024));\nprocess.exit(0);',
      ),
      { outputLimit: 1024 },
    );
    // the child exited rather than blocking on a full pipe, so the pipes were still drained
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
    expect((observed as { detail: string }).detail).toContain('1024');
    expect(observed).not.toHaveProperty('output'); // refused whole, never truncated
    await expect(observeAgain()).resolves.toEqual(observed);
  });

  it('counts the cap across both streams together', async () => {
    const { observed } = await run(
      script(
        'both',
        'process.stdout.write("a".repeat(600)); process.stderr.write("b".repeat(600));',
      ),
      { outputLimit: 1000 },
    );
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'output_limit_exceeded' });
  });
});

/**
 * A gate that runs until the test releases it. Deadlines, aborts and competing observers all need
 * a child that is demonstrably still alive while the waiting around it ends.
 */
const lingering = (name: string) => {
  const release = marker(`${name}-release`);
  const finished = marker(`${name}-finished`);
  return {
    release: () => writeFileSync(release, '1', 'utf8'),
    finished,
    command: script(
      name,
      `import { existsSync, writeFileSync } from 'node:fs';
       const until = Date.now() + 10000;
       const tick = () => {
         if (existsSync(RELEASE) || Date.now() > until) {
           process.stdout.write('done\\n');
           return writeFileSync(FINISHED, '1');
         }
         setTimeout(tick, 10);
       };
       tick();`
        .replace('RELEASE', JSON.stringify(release))
        .replace('FINISHED', JSON.stringify(finished)),
    ),
  };
};

/** Starts a lingering gate and waits for its launch to be acknowledged. */
const startLingering = async (name: string, options: GateRunnerOptions = {}) => {
  const gate = lingering(name);
  const runner = createGateRunner(options);
  const launch = runner.start({ node: 'test_gate', command: gate.command, cwd: dir }, LATER());
  expect(await launch.started).toEqual({ kind: 'accepted' });
  return { ...gate, runner, id: launch.executionId };
};

describe('bounding an observation', () => {
  it('ends the waiting at the deadline and leaves the gate running', async () => {
    const gate = await startLingering('deadline');
    expect(await gate.runner.observe(gate.id, Date.now() + 150)).toEqual({
      kind: 'timed_out',
      executionId: gate.id,
    });
    expect(existsSync(gate.finished)).toBe(false); // the deadline ended waiting, not the child
    gate.release();
    await waitFor(gate.finished);
    // and the result the gate went on to produce is still the runtime's to hand back
    expect(completed(await gate.runner.observe(gate.id, LATER()))).toMatchObject({
      exitStatus: 0,
      output: 'done\n',
    });
  });

  it('answers a deadline that has already passed without waiting for the gate', async () => {
    const gate = await startLingering('spent-deadline');
    expect(await gate.runner.observe(gate.id, Date.now() - 1)).toEqual({
      kind: 'timed_out',
      executionId: gate.id,
    });
    expect(existsSync(gate.finished)).toBe(false); // it cannot have waited: the gate is still going
    gate.release();
    await waitFor(gate.finished);
    expect(await gate.runner.observe(gate.id, LATER())).toMatchObject({ kind: 'completed' });
  });

  it('does not expire a deadline further off than one timer can reach', async () => {
    // setTimeout fires on the next tick for anything past 2^31-1 ms, so scheduling this in a single
    // hop would time the observation out long before `printf` could run
    const warnings: string[] = [];
    const watch = (warning: Error) => warnings.push(warning.name);
    process.on('warning', watch);
    try {
      const { observed } = await run('printf "ok\\n"', {}, Date.now() + 2 ** 33);
      expect(completed(observed).output).toBe('ok\n');
    } finally {
      process.off('warning', watch);
    }
    // and it is reached in steps the host can hold, rather than by handing it an interval that
    // overflows and silently becomes one millisecond
    expect(warnings).not.toContain('TimeoutOverflowWarning');
  });

  it('replays a result the runtime already holds even when the deadline is spent', async () => {
    const gate = await startLingering('retained-beats-deadline');
    gate.release();
    await waitFor(gate.finished);
    await expect(gate.runner.observe(gate.id, LATER())).resolves.toMatchObject({
      kind: 'completed',
    });
    // the answer exists; a spent deadline is no reason to withhold it
    expect(completed(await gate.runner.observe(gate.id, Date.now() - 1_000))).toMatchObject({
      exitStatus: 0,
      output: 'done\n',
    });
  });

  it('refuses to hand a spent waiter a late success', async () => {
    // A timer callback can run after its due time. The clock, not the timer, decides whether the
    // budget is gone, so the result arriving here lands on an observation that is already over.
    let clock = Date.now();
    const gate = await startLingering('overdue', { now: () => clock });
    const deadline = clock + 10_000; // the real timer is nowhere near firing
    const observation = gate.runner.observe(gate.id, deadline);
    clock = deadline + 1; // ... but the budget is spent
    gate.release();
    expect(await observation).toEqual({ kind: 'timed_out', executionId: gate.id });
    // the execution's own outcome is untouched by that waiter's fate
    expect(completed(await gate.runner.observe(gate.id, clock + 10_000))).toMatchObject({
      exitStatus: 0,
      output: 'done\n',
    });
  });
});

describe('cancelling an observation', () => {
  it('cancels the waiting and leaves the gate running', async () => {
    const gate = await startLingering('abort');
    const controller = new AbortController();
    const observation = gate.runner.observe(gate.id, LATER(), controller.signal);
    controller.abort();
    expect(await observation).toEqual({ kind: 'cancelled', executionId: gate.id });
    expect(existsSync(gate.finished)).toBe(false);
    gate.release();
    await waitFor(gate.finished);
    expect(await gate.runner.observe(gate.id, LATER())).toMatchObject({ kind: 'completed' });
  });

  it('starts no waiting for a caller that has already given up', async () => {
    const gate = await startLingering('pre-aborted');
    expect(await gate.runner.observe(gate.id, LATER(), AbortSignal.abort())).toEqual({
      kind: 'cancelled',
      executionId: gate.id,
    });
    expect(existsSync(gate.finished)).toBe(false);
  });

  it.each([
    ['an aborted caller', () => ({ deadline: LATER(), signal: AbortSignal.abort() })],
    ['a spent deadline', () => ({ deadline: Date.now() - 1, signal: undefined })],
  ])('refuses an execution it never started, ahead of %s', async (_label, shape) => {
    const runner = createGateRunner();
    const { deadline, signal } = shape();
    // identity is decided first: neither of these can make an unknown id look like a live one
    await expect(runner.observe('gate-404' as ExecutionId, deadline, signal)).resolves.toEqual({
      kind: 'unrecoverable',
      executionId: 'gate-404',
      reason: 'unknown_execution',
    });
  });
});

describe('several observers of one gate', () => {
  it('gives every concurrent observer the same result', async () => {
    const gate = await startLingering('concurrent');
    const observations = Promise.all([
      gate.runner.observe(gate.id, LATER()),
      gate.runner.observe(gate.id, LATER()),
      gate.runner.observe(gate.id, LATER()),
    ]);
    gate.release();
    const [first, second, third] = await observations;
    expect(completed(first!)).toMatchObject({ exitStatus: 0, output: 'done\n' });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('lets one observer time out while another keeps waiting', async () => {
    const gate = await startLingering('mixed-deadlines');
    const brief = gate.runner.observe(gate.id, Date.now() + 150);
    const patient = gate.runner.observe(gate.id, LATER());
    expect(await brief).toEqual({ kind: 'timed_out', executionId: gate.id });
    expect(existsSync(gate.finished)).toBe(false); // the patient observer is still waiting on it
    gate.release();
    expect(completed(await patient)).toMatchObject({ exitStatus: 0, output: 'done\n' });
  });

  it('leaves the other observers working when one is cancelled', async () => {
    const gate = await startLingering('one-cancelled');
    const controller = new AbortController();
    const cancelled = gate.runner.observe(gate.id, LATER(), controller.signal);
    const other = new AbortController(); // a signal of its own: cancelling one must not reach it
    const kept = gate.runner.observe(gate.id, LATER(), other.signal);
    const unsignalled = gate.runner.observe(gate.id, LATER());

    controller.abort();
    expect(await cancelled).toEqual({ kind: 'cancelled', executionId: gate.id });
    expect(other.signal.aborted).toBe(false);
    expect(existsSync(gate.finished)).toBe(false); // nothing about the gate changed either

    gate.release();
    expect(completed(await kept)).toMatchObject({ exitStatus: 0, output: 'done\n' });
    expect(await unsignalled).toEqual(await kept);
  });

  it('leaves no abort listener behind on a signal its caller may keep using', async () => {
    const gate = await startLingering('teardown');
    const controller = new AbortController();
    const observation = gate.runner.observe(gate.id, LATER(), controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    gate.release();
    expect(await observation).toMatchObject({ kind: 'completed' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

/**
 * A gate whose child and clock this test drives directly.
 *
 * Real children need real time, and the cases below are about a timer wheel turning past intervals
 * no test can wait out and a clock moving between two statements. So the child is a stub, the
 * endings are emitted by hand, and the clock is a variable.
 */
interface StubLaunch {
  deadline?: DeadlineEpochMs;
  signal?: AbortSignal;
  /** Emit `spawn` at once. Withheld when a test needs the acknowledgement left outstanding. */
  acknowledge?: boolean;
  /** Let the dispatch itself fail, the way an unusable shell does. */
  fail?: boolean;
}

const stubbed = async (options: GateRunnerOptions, how: StubLaunch = {}) => {
  const acknowledge = how.acknowledge ?? how.fail !== true;
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  let spawns = 0;
  const runner = createGateRunner({
    ...options,
    spawn: (() => {
      spawns += 1;
      if (how.fail === true) throw new Error('a shell that cannot be named');
      child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      if (acknowledge) queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as unknown as typeof spawn,
  });
  const launch = runner.start(
    { node: 'test_gate', command: 'a test double', cwd: dir },
    how.deadline ?? LATER(),
    how.signal,
  );
  if (acknowledge) expect(await launch.started).toEqual({ kind: 'accepted' });
  else await Promise.resolve(); // let the queued dispatch run, without acknowledging it
  return {
    runner,
    launch,
    id: launch.executionId,
    spawns: () => spawns,
    spawned: () => child.emit('spawn'),
    close: () => child.emit('close', 0, null),
  };
};

describe('a deadline the test moves the clock to', () => {
  /** Only the timer wheel: the runner's own clock is injected, so the two move independently. */
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  const MAX_TIMEOUT = 2_147_483_647;

  it('keeps waiting across capped hops until the deadline itself arrives', async () => {
    let clock = 1_000_000;
    const gate = await stubbed({ now: () => clock });
    const deadline = clock + 3 * MAX_TIMEOUT; // further off than any one timer can be set for
    let settled: ProcessObservation | undefined;
    void gate.runner.observe(gate.id, deadline).then((value) => (settled = value));

    // each hop is a full cap, and each one must re-arm rather than expire: a timer that fired the
    // expiry directly would end this observation weeks early, at the first interval
    for (let hop = 0; hop < 2; hop++) {
      clock += MAX_TIMEOUT;
      await vi.advanceTimersByTimeAsync(MAX_TIMEOUT);
      expect(settled).toBeUndefined();
    }
    clock += MAX_TIMEOUT;
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT);
    expect(settled).toEqual({ kind: 'timed_out', executionId: gate.id });
  });

  it('expires a deadline reached while the observation is still being set up', async () => {
    // The clock passes the deadline between the entry check and the arming. Reached is reached: the
    // arming expires at once and tears down the abort listener installed just before it, so the
    // abort arriving immediately afterwards has nothing left to cancel.
    const deadline = 1_000_000;
    // The launch reads the clock several times of its own, so the crossing sequence is armed only
    // once the launch is acknowledged — otherwise observation would begin already past the
    // deadline and take the early refusal, never reaching the setup being tested.
    let reads = 0;
    let clock = () => deadline - 1_000;
    const gate = await stubbed({ now: () => clock() });
    clock = () => (++reads === 1 ? deadline - 1 : deadline);
    const controller = new AbortController();
    const observation = gate.runner.observe(gate.id, deadline, controller.signal);
    controller.abort();
    expect(await observation).toEqual({ kind: 'timed_out', executionId: gate.id });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each([
    ['abort', { kind: 'cancelled' }],
    ['the deadline', { kind: 'timed_out' }],
    ['a result', { kind: 'completed' }],
  ] as const)(
    'releases waiter, timer and listener when an observation ends by %s',
    async (ending, expected) => {
      let clock = 1_000_000;
      let reads = 0;
      const gate = await stubbed({
        now: () => {
          reads += 1;
          return clock;
        },
      });
      const controller = new AbortController();
      const deadline = clock + 60_000;
      const observation = gate.runner.observe(gate.id, deadline, controller.signal);
      expect(vi.getTimerCount()).toBe(1);

      if (ending === 'abort') controller.abort();
      else if (ending === 'a result') gate.close();
      else {
        clock = deadline;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(await observation).toMatchObject(expected);

      expect(vi.getTimerCount()).toBe(0); // no timer outlives the observation it was bounding
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

      // A live waiter consults the clock to decide whether its budget is spent. An observation that
      // is over must no longer be registered at all, so the execution's result cannot reach it —
      // which the clock, untouched by the publication, is what shows.
      reads = 0;
      if (ending !== 'a result') gate.close();
      expect(reads).toBe(0);
    },
  );

  it('answers an acknowledgement the deadline outran, and keeps collecting the gate', async () => {
    let clock = 1_000_000;
    const deadline = clock + 60_000;
    const gate = await stubbed({ now: () => clock }, { deadline, acknowledge: false });
    clock = deadline;
    await vi.advanceTimersByTimeAsync(60_000);

    const started = await gate.launch.started;
    // not `failed`: a shell was handed the command, so nobody may claim nothing ran
    expect(started).toMatchObject({ kind: 'unconfirmed' });
    expect((started as { detail: string }).detail).toMatch(/a shell may be running/);

    gate.spawned(); // the acknowledgement arriving late changes nothing about the answer given
    expect(await gate.launch.started).toBe(started);
    gate.close();
    expect(await gate.runner.observe(gate.id, clock + 60_000)).toMatchObject({ kind: 'completed' });
  });

  it('will not let an overdue acknowledgement come back as accepted', async () => {
    // the clock is past the deadline while the timer that would have said so has not run
    let clock = 1_000_000;
    const deadline = clock + 60_000;
    const gate = await stubbed({ now: () => clock }, { deadline, acknowledge: false });
    clock = deadline + 1;
    gate.spawned();
    const started = await gate.launch.started;
    expect(started).toMatchObject({ kind: 'unconfirmed' });
    expect((started as { detail: string }).detail).toMatch(/acknowledged only after the deadline/);
  });

  it.each([
    ['acceptance', { kind: 'accepted' }],
    ['a shell that will not start', { kind: 'failed' }],
    ['the deadline', { kind: 'unconfirmed' }],
    ['abort', { kind: 'cancelled' }],
    ['shutdown', { kind: 'cancelled' }],
  ] as const)('releases the acknowledgement timer and listener on %s', async (ending, expected) => {
    let clock = 1_000_000;
    const deadline = clock + 60_000;
    const controller = new AbortController();
    const gate = await stubbed(
      { now: () => clock },
      {
        deadline,
        signal: controller.signal,
        fail: ending === 'a shell that will not start',
        acknowledge: ending === 'acceptance',
      },
    );

    if (ending === 'the deadline') {
      clock = deadline;
      await vi.advanceTimersByTimeAsync(60_000);
    } else if (ending === 'abort') controller.abort();
    else if (ending === 'shutdown') await gate.runner.shutdown();
    expect(await gate.launch.started).toMatchObject(expected);

    // the launch's own deadline and its own abort listener, which the observation cases above
    // never install: an acknowledgement that has been given owns neither any more
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cancels an unfinished execution, and sets up no waiting, once shut down', async () => {
    const clock = 1_000_000;
    const gate = await stubbed({ now: () => clock });
    await gate.runner.shutdown();
    // and a spent deadline is the one answer this must not give: nothing here ran out of time
    expect(await gate.runner.observe(gate.id, clock - 1_000)).toEqual({
      kind: 'cancelled',
      executionId: gate.id,
    });
    expect(vi.getTimerCount()).toBe(0); // nothing was armed, so nothing has to be torn down
  });
});

describe('shutting the runner down', () => {
  it('settles the observations outstanding at the time, and keeps them settled', async () => {
    const gate = await startLingering('shutdown-observers');
    const first = gate.runner.observe(gate.id, LATER());
    const second = gate.runner.observe(gate.id, LATER());
    await gate.runner.shutdown();
    expect(await first).toEqual({ kind: 'cancelled', executionId: gate.id });
    expect(await second).toEqual({ kind: 'cancelled', executionId: gate.id });

    // the gate goes on to finish; a waiter already cancelled stays cancelled, and the result it
    // never received is still the runtime's to hand back
    gate.release();
    await waitFor(gate.finished);
    expect(await first).toEqual({ kind: 'cancelled', executionId: gate.id });
    const later = await eventually(() => gate.runner.observe(gate.id, LATER()));
    expect(later).toMatchObject({ exitStatus: 0 });
  });

  it('leaves running gates alone, and replays what they produce afterwards', async () => {
    const gate = await startLingering('shutdown-children');
    await gate.runner.shutdown();
    expect(existsSync(gate.finished)).toBe(false); // still running after shutdown resolved
    gate.release();
    await waitFor(gate.finished); // and it got to finish, on its own terms
    expect(await eventually(() => gate.runner.observe(gate.id, LATER()))).toMatchObject({
      exitStatus: 0,
      output: 'done\n',
    });
  });

  it('is idempotent', async () => {
    const gate = await startLingering('shutdown-twice');
    await gate.runner.shutdown();
    await expect(gate.runner.shutdown()).resolves.toBeUndefined();
    expect(await gate.runner.observe(gate.id, LATER())).toMatchObject({ kind: 'cancelled' });
    gate.release();
  });

  it('settles a pending acknowledgement, which a late spawn cannot then replace', async () => {
    const gate = await stubbed({}, { acknowledge: false });
    expect(gate.spawns()).toBe(1); // dispatched: a child of some sort exists
    await gate.runner.shutdown();
    expect(await gate.launch.started).toEqual({ kind: 'cancelled' });

    gate.spawned(); // the shell reports itself after the fact; the caller was already told
    expect(await gate.launch.started).toEqual({ kind: 'cancelled' });
    gate.close(); // and the child was never touched, so its result is still collected
    expect(await gate.runner.observe(gate.id, LATER())).toMatchObject({ kind: 'completed' });
  });

  it.each(['before its queued dispatch runs', 'after shutdown'] as const)(
    'starts no shell for a launch %s',
    async (when) => {
      const runner = createGateRunner({ spawn: refuseToSpawn });
      if (when === 'after shutdown') await runner.shutdown();
      const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir }, LATER());
      if (when !== 'after shutdown') await runner.shutdown();

      expect(await launch.started).toEqual({ kind: 'cancelled' });
      expect(spawnAttempts).toBe(0);
      // the identity was issued, so it has to mean something rather than wait for ever
      expect(await runner.observe(launch.executionId, LATER())).toEqual({
        kind: 'cancelled',
        executionId: launch.executionId,
      });
    },
  );
});

describe('bounding a launch', () => {
  it('refuses to dispatch a launch whose deadline is already gone', async () => {
    const runner = createGateRunner({ spawn: refuseToSpawn });
    const launch = runner.start(
      { node: 'test_gate', command: 'echo ok', cwd: dir },
      Date.now() - 1,
    );
    const started = await launch.started;
    // `failed`, not `unconfirmed`: nothing was handed to a shell, and that is not in doubt
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail).toMatch(/deadline passed before dispatch/);
    expect(spawnAttempts).toBe(0);

    const observed = await runner.observe(launch.executionId, LATER());
    expect(observed).toMatchObject({ kind: 'unrecoverable', reason: 'spawn_failed' });
    expect((observed as { detail: string }).detail).toMatch(/no shell was started/);
  });

  it('refuses to dispatch when the deadline passes after the handle is returned', async () => {
    // start() answers synchronously and dispatch runs a microtask later. The check that matters is
    // the one made *then*: an answer cached at start() would still have found time on the clock.
    let clock = 1_000_000;
    const deadline = clock + 1_000;
    const runner = createGateRunner({ spawn: refuseToSpawn, now: () => clock });
    const launch = runner.start({ node: 'test_gate', command: 'echo ok', cwd: dir }, deadline);
    clock = deadline;

    const started = await launch.started;
    expect(started).toMatchObject({ kind: 'failed' });
    expect((started as { detail: string }).detail).toMatch(/deadline passed before dispatch/);
    expect(spawnAttempts).toBe(0);
    expect(await runner.observe(launch.executionId, deadline + 10_000)).toMatchObject({
      kind: 'unrecoverable',
      reason: 'spawn_failed',
    });
  });

  it('dispatches nothing for a caller who aborted first', async () => {
    const runner = createGateRunner({ spawn: refuseToSpawn });
    const launch = runner.start(
      { node: 'test_gate', command: 'echo ok', cwd: dir },
      LATER(),
      AbortSignal.abort(),
    );
    expect(await launch.started).toEqual({ kind: 'cancelled' });
    expect(spawnAttempts).toBe(0);
    expect(await runner.observe(launch.executionId, LATER())).toEqual({
      kind: 'cancelled',
      executionId: launch.executionId,
    });
  });

  it('cancels a pending acknowledgement on abort, and leaves the gate collecting', async () => {
    const controller = new AbortController();
    const gate = await stubbed({}, { acknowledge: false, signal: controller.signal });
    expect(gate.spawns()).toBe(1);
    controller.abort();
    expect(await gate.launch.started).toEqual({ kind: 'cancelled' });
    // the signal bounded the submission; the command it started is none of its business
    gate.spawned();
    gate.close();
    expect(await gate.runner.observe(gate.id, LATER())).toMatchObject({ kind: 'completed' });
  });
});
