import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type {
  ExecutionId,
  LayoutSpec,
  ProcessObservation,
  ProcessSpec,
  SubmissionOutcome,
} from '../src/adapter.js';
import type { HerdrError, HerdrRunner } from '../src/herdr/cli.js';
import { createHerdrRuntime, type HerdrRuntime, LayoutError } from '../src/herdr/index.js';

/**
 * A small local double rather than the harness in herdr-layout.test.ts. Sharing that one would mean
 * moving it to a support module, and a move counts in full as additions plus deletions.
 */
const recorded = (group: string, name: string) => {
  const at = (ext: string) =>
    fileURLToPath(new URL(`./fixtures/herdr/${group}/${name}.${ext}`, import.meta.url));
  return {
    code: Number(/^exit: (\d+)$/m.exec(readFileSync(at('meta'), 'utf8'))?.[1]),
    stdout: readFileSync(at('stdout'), 'utf8'),
    stderr: readFileSync(at('stderr'), 'utf8'),
  };
};

const renamed = (pane: string, label: string) => ({
  code: 0,
  stdout: JSON.stringify({
    id: 'cli:pane:rename',
    result: { type: 'pane_info', pane: { pane_id: pane, label } },
  }),
  stderr: '',
});

type Reply = { code: number; stdout: string; stderr: string } | 'parked' | 'lingering';

/**
 * Replays one reply per call, recording the executable and argv it was given.
 *
 * `parked` ends only when the invocation is cancelled. `lingering` also waits to be cancelled, and
 * then takes as long as the test likes to actually end — which is how a herdr child that is slow to
 * die becomes observable.
 */
const herdr = (...replies: Reply[]) => {
  const calls: (readonly string[])[] = [];
  const executables: string[] = [];
  let reached = (): void => undefined;
  let endCancellation = (): void => undefined;
  let aborted = (): void => undefined;
  let invoked = (): void => undefined;
  const run: HerdrRunner = (file, argv, signal) => {
    executables.push(file);
    calls.push(argv);
    reached();
    invoked();
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error(`unscripted call: ${argv.join(' ')}`);
    if (typeof reply !== 'string') return Promise.resolve(reply);
    return new Promise((_resolve, reject) => {
      const stop = () => {
        aborted();
        if (reply === 'parked') return reject(new Error('aborted'));
        endCancellation = () => reject(new Error('aborted'));
      };
      // Already cancelled before this call even began: a listener would never fire, and a runner
      // that waited for one would simply hang.
      if (signal?.aborted === true) return stop();
      signal?.addEventListener('abort', stop, { once: true });
    });
  };
  return {
    run,
    calls,
    executables,
    /** Let a `lingering` call finally end. */
    endCancellation: () => endCancellation(),
    /** Run something synchronously, inside the abort that shutdown fires. */
    whenAborted: (fn: () => void) => (aborted = fn),
    /** Run something synchronously, inside the invocation itself, before it returns anything. */
    whenInvoked: (fn: () => void) => (invoked = fn),
    /** The verbs invoked, past any `--session` prefix: what herdr was actually asked to do. */
    verbs: () =>
      calls.map((argv) =>
        (argv[0] === '--session' ? argv.slice(2, 4) : argv.slice(0, 2)).join(' '),
      ),
    /** Resolves once the nth call has been made, so a test need never guess at timing. */
    at: (n: number) =>
      new Promise<void>((resolve) => {
        if (calls.length >= n) return resolve();
        reached = () => {
          if (calls.length >= n) resolve();
        };
      }),
  };
};

const workspace: LayoutSpec = {
  destination: { kind: 'new_workspace' },
  cwd: '/tmp',
  label: 'pipeline-run',
};

/** A gate child this test drives: dispatched, but acknowledging only when told. */
const stubGate = () => {
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  const commands: { command: string; cwd: string | undefined }[] = [];
  const spawnDouble = ((_shell: string, argv: string[], options: { cwd?: string }) => {
    commands.push({ command: argv[1] as string, cwd: options.cwd });
    child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    return child;
  }) as unknown as typeof spawn;
  return {
    spawn: spawnDouble,
    commands,
    /** Dispatch is queued as a microtask, so the child exists only after yielding to it. */
    spawned: async () => {
      await Promise.resolve();
      child.emit('spawn');
    },
    close: () => child.emit('close', 0, null),
  };
};

const gateSpec: ProcessSpec = { node: 'gate', command: 'pnpm test', cwd: '/repo' };

describe('the herdr runtime as an adapter', () => {
  it('is exactly the four methods it claims, and no more', () => {
    const runtime: HerdrRuntime = createHerdrRuntime();
    // the compile-time claim is the assignment above; this is the shape a caller actually gets
    expect(Object.keys(runtime).sort()).toEqual([
      'createLayout',
      'observeProcess',
      'shutdown',
      'startProcess',
    ]);
  });

  it('creates a layout through herdr, with the options it was built with', async () => {
    const script = herdr(recorded('workspace-create', 'success'), renamed('w2:p1', 'pipeline-run'));
    const runtime = createHerdrRuntime({
      herdr: { run: script.run, session: 'pipeline_test', executable: 'herdr-x' },
    });
    await expect(runtime.createLayout(workspace)).resolves.toBe('w2:p1');
    expect(script.verbs()).toEqual(['workspace create', 'pane rename']);
    // the session prefix and the spec both reached the command line, unaltered
    expect(script.executables).toEqual(['herdr-x', 'herdr-x']); // the one it was built with
    expect(script.calls[0]).toEqual([
      '--session',
      'pipeline_test',
      'workspace',
      'create',
      '--cwd',
      '/tmp',
      '--label',
      'pipeline-run',
    ]);
  });

  it.each([
    ['a deadline', { deadline: Date.now() - 60_000 }],
    ['a cancellation signal', { signal: AbortSignal.abort() }],
    ['both at once', { deadline: Date.now() - 60_000, signal: AbortSignal.abort() }],
  ])('cannot be given %s to hold for its whole life', async (_label, smuggled) => {
    // `Omit` is checked where a caller writes an object literal, and nowhere else. This is the
    // path it does not cover: a wider object, or a JavaScript caller, carrying the fields anyway.
    const script = herdr(recorded('workspace-create', 'success'), renamed('w2:p1', 'pipeline-run'));
    const wider = { run: script.run, session: 'pipeline_test', ...smuggled };
    // No cast: a variable is not a fresh literal, so structural typing accepts it as it stands.
    // That it compiles at all is the point — which is why the filtering has to be at runtime.
    const runtime = createHerdrRuntime({ herdr: wider });

    // A spent deadline or an aborted signal reaching the CLI would end this before it began; the
    // layout completing is what says neither did.
    await expect(runtime.createLayout(workspace)).resolves.toBe('w2:p1');
    expect(script.verbs()).toEqual(['workspace create', 'pane rename']);
  });

  it('refuses a layout after shutdown, before invoking anything', async () => {
    const script = herdr();
    const runtime = createHerdrRuntime({ herdr: { run: script.run } });
    await runtime.shutdown();
    await expect(runtime.createLayout(workspace)).rejects.toThrow('createLayout after shutdown');
    expect(script.calls).toHaveLength(0); // nothing was invoked, so nothing was created
  });

  it('cancels a layout in flight while keeping what it had already confirmed', async () => {
    // creation answered; the rename then parks, so shutdown lands between the two
    const script = herdr(recorded('workspace-create', 'success'), 'parked');
    const runtime = createHerdrRuntime({ herdr: { run: script.run } });
    const creating = runtime.createLayout(workspace);
    await script.at(2); // the rename is outstanding, and nothing is guessed about when

    await runtime.shutdown();
    const error = await creating.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LayoutError);
    const failure = error as LayoutError;
    // what herdr confirmed before the cancellation is still reported, and so is the reason
    expect(failure.remains).toEqual({ createdPane: 'w2:p1', ownedWorkspaceId: 'w2' });
    expect((failure.cause as HerdrError).fault).toBe('cancelled');
    // and nothing was torn down: the workspace and pane are left exactly where they are
    expect(script.verbs()).toEqual(['workspace create', 'pane rename']);
  });
});

describe('shutdown and layout children', () => {
  /** A layout whose creation is answered and whose rename then parks, slow to die once cancelled. */
  const midRename = async () => {
    const script = herdr(recorded('workspace-create', 'success'), 'lingering');
    const runtime = createHerdrRuntime({ herdr: { run: script.run } });
    const creating = runtime.createLayout(workspace);
    await script.at(2);
    return { script, runtime, creating };
  };

  it('stays pending until its layout children have finished being cancelled', async () => {
    const { script, runtime, creating } = await midRename();
    let done = false;
    const closing = runtime.shutdown().then(() => (done = true));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false); // the rename child was told to stop, and has not stopped yet

    script.endCancellation();
    await closing;
    expect(done).toBe(true);
    // and following the call to know when it ended did not take the caller's error from them
    const error = await creating.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LayoutError);
    expect((error as LayoutError).remains).toEqual({
      createdPane: 'w2:p1',
      ownedWorkspaceId: 'w2',
    });
  });

  it('tracks a layout from before its very first invocation', async () => {
    // shutdown called from *inside* the invocation, before the call has returned anything at all
    const script = herdr('lingering');
    const runtime = createHerdrRuntime({ herdr: { run: script.run } });
    let closing: Promise<void> | undefined;
    script.whenInvoked(() => (closing = runtime.shutdown()));
    const creating = runtime.createLayout(workspace);

    let done = false;
    void (closing as Promise<void>).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false); // the layout it never got to register is still ending

    script.endCancellation();
    await closing;
    expect(done).toBe(true);
    const error = await creating.catch((cause: unknown) => cause);
    expect((error as HerdrError).fault).toBe('cancelled');
  });

  it('hands a re-entrant shutdown the very same cleanup', async () => {
    const { script, runtime, creating } = await midRename();
    // abort listeners run synchronously, so this second call happens while the first is still on
    // the stack — exactly when a half-assigned memo would hand out a different promise
    let reentrant: Promise<void> | undefined;
    script.whenAborted(() => (reentrant = runtime.shutdown()));

    const first = runtime.shutdown();
    expect(reentrant).toBe(first);
    script.endCancellation();
    await first;
    await expect(creating).rejects.toBeInstanceOf(LayoutError);
  });
});

describe('forwarding gate work', () => {
  it('hands back a handle while the acknowledgement is still outstanding', async () => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    expect(launch.executionId).toBeTruthy(); // synchronously, before any dispatch

    let settled = false;
    void launch.started.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gate.commands).toEqual([{ command: 'pnpm test', cwd: '/repo' }]); // the spec, verbatim
    expect(settled).toBe(false); // dispatched, not yet acknowledged

    await gate.spawned();
    await expect(launch.started).resolves.toEqual({ kind: 'accepted' });
  });

  it('cancels a launch on a signal that aborts after the waiting has started', async () => {
    // a snapshot of the signal's initial state would never see this abort
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const controller = new AbortController();
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000, controller.signal);
    await Promise.resolve();
    expect(gate.commands).toHaveLength(1); // dispatched, and its acknowledgement outstanding

    controller.abort();
    expect(await launch.started).toEqual({ kind: 'cancelled' });
  });

  it('cancels an observation on a signal that aborts after the waiting has started', async () => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await launch.started;
    const controller = new AbortController();
    const watching = runtime.observeProcess(
      launch.executionId,
      Date.now() + 30_000,
      controller.signal,
    );

    controller.abort();
    expect(await watching).toEqual({ kind: 'cancelled', executionId: launch.executionId });
  });

  it('settles a launch and an observation at the budget it was handed, to the millisecond', async () => {
    // Both clocks are the test's: the timer wheel, and the clock the runtime measures against. A
    // budget quietly lengthened anywhere along the way misses this boundary in both directions.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let clock = 1_000_000;
      const gate = stubGate();
      const runtime = createHerdrRuntime({ spawn: gate.spawn, now: () => clock });

      const launch = runtime.startProcess(gateSpec, clock + 100);
      await Promise.resolve(); // dispatched, and its acknowledgement deliberately withheld
      let started: SubmissionOutcome | undefined;
      void launch.started.then((outcome) => (started = outcome));
      await vi.advanceTimersByTimeAsync(99);
      expect(started).toBeUndefined(); // not a millisecond early
      clock += 100;
      await vi.advanceTimersByTimeAsync(1);
      expect(started).toMatchObject({ kind: 'unconfirmed' }); // nor a millisecond late

      await gate.spawned();
      let observed: ProcessObservation | undefined;
      void runtime
        .observeProcess(launch.executionId, clock + 100)
        .then((observation) => (observed = observation));
      await vi.advanceTimersByTimeAsync(99);
      expect(observed).toBeUndefined();
      clock += 100;
      await vi.advanceTimersByTimeAsync(1);
      expect(observed).toEqual({ kind: 'timed_out', executionId: launch.executionId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures that budget on the wall clock too, when no clock is supplied', async () => {
    // The case above moves an injected clock, so a defect that lengthens only deadlines it judges
    // future by `Date.now()` would slip past it. This one is on the real clock, and settles well
    // inside its own wait rather than relying on a test-runner timeout to notice.
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 60);
    let started: SubmissionOutcome | undefined;
    void launch.started.then((outcome) => (started = outcome));

    // deliberately left unacknowledged, so the launch's own budget is what settles it
    let observed: ProcessObservation | undefined;
    void runtime
      .observeProcess(launch.executionId, Date.now() + 60)
      .then((observation) => (observed = observation));

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(started).toMatchObject({ kind: 'unconfirmed' }); // long since due, on its own budget
    expect(observed).toEqual({ kind: 'timed_out', executionId: launch.executionId });
  });

  it.each([
    ['a deadline that is already spent', () => ({ deadline: Date.now() - 1 }), { kind: 'failed' }],
    [
      'a caller that already aborted',
      () => ({ deadline: Date.now() + 30_000, signal: AbortSignal.abort() }),
      { kind: 'cancelled' },
    ],
  ])('passes %s through to the gate runner', async (_label, shape, expected) => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const { deadline, signal } = shape() as { deadline: number; signal?: AbortSignal };
    const launch = runtime.startProcess(gateSpec, deadline, signal);
    expect(await launch.started).toMatchObject(expected);
    expect(gate.commands).toHaveLength(0); // neither one reached a shell
  });

  it.each([
    [
      'an identity it never issued',
      () => ({ id: 'gate-404' as ExecutionId, deadline: Date.now() + 30_000 }),
      { kind: 'unrecoverable', reason: 'unknown_execution' },
    ],
    [
      'a deadline that is already spent',
      (id: ExecutionId) => ({ id, deadline: Date.now() - 1 }),
      { kind: 'timed_out' },
    ],
    [
      'a caller that already aborted',
      (id: ExecutionId) => ({ id, deadline: Date.now() + 30_000, signal: AbortSignal.abort() }),
      { kind: 'cancelled' },
    ],
  ])('passes %s through when observing', async (_label, shape, expected) => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await launch.started;
    const { id, deadline, signal } = shape(launch.executionId);
    expect(await runtime.observeProcess(id, deadline, signal)).toMatchObject(expected);
  });

  it('answers an aborted caller before replaying a result it holds', async () => {
    // the same precedence FakeRuntime keeps: a caller that aborted asked to stop, not to collect
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await launch.started;
    gate.close();
    expect(await runtime.observeProcess(launch.executionId, Date.now() + 30_000)).toMatchObject({
      kind: 'completed',
    });
    expect(
      await runtime.observeProcess(launch.executionId, Date.now() + 30_000, AbortSignal.abort()),
    ).toEqual({ kind: 'cancelled', executionId: launch.executionId });
  });
});

describe('shutting the runtime down', () => {
  it('releases an observation that was already waiting, and repeats the same cleanup', async () => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await launch.started;
    // waiting *before* shutdown begins: an observation made afterwards would never show a failure
    // to release the waiters that were already registered
    const waiting = runtime.observeProcess(launch.executionId, Date.now() + 30_000);

    const first = runtime.shutdown();
    expect(runtime.shutdown()).toBe(first); // the same cleanup, awaited again
    await first;
    expect(await waiting).toEqual({ kind: 'cancelled', executionId: launch.executionId });
  });

  it('still replays a result it holds, and cancels one it does not', async () => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    const finished = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await finished.started;
    gate.close();
    await runtime.observeProcess(finished.executionId, Date.now() + 30_000);

    const unfinished = runtime.startProcess(gateSpec, Date.now() + 30_000);
    await gate.spawned();
    await unfinished.started;
    await runtime.shutdown();

    expect(await runtime.observeProcess(finished.executionId, Date.now() + 30_000)).toMatchObject({
      kind: 'completed',
      exitStatus: 0,
    });
    expect(await runtime.observeProcess(unfinished.executionId, Date.now() + 30_000)).toEqual({
      kind: 'cancelled',
      executionId: unfinished.executionId,
    });
  });

  it('starts nothing once it is closed', async () => {
    const gate = stubGate();
    const runtime = createHerdrRuntime({ spawn: gate.spawn });
    await runtime.shutdown();
    const launch = runtime.startProcess(gateSpec, Date.now() + 30_000);
    expect(await launch.started).toEqual({ kind: 'cancelled' });
    expect(gate.commands).toHaveLength(0);
  });
});
