import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFakeRuntime,
  type ExecutionId,
  type ScenarioInput,
  type TurnId,
} from '@pipeline/runtime';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { strictAjv } from './support/ajv.js';
import type { PipelineEvent } from '../src/runlog/events.js';
import { openRunLog, readEvents } from '../src/runlog/log.js';
import { replay } from '../src/runlog/state.js';
import { parseSkeletonConfig } from '../src/skeleton/config.js';
import { runSkeleton, UnsupportedPath } from '../src/skeleton/engine.js';

const spec = (name: string) => fileURLToPath(new URL(`../../../spec/${name}`, import.meta.url));
const golden = (name: string) =>
  parseYaml(readFileSync(spec(`scenarios/${name}.yaml`), 'utf8')) as {
    task: string;
    inputs: ScenarioInput[];
    expect: PipelineEvent[];
  };

const ajv = strictAjv();
const validEvent = ajv.compile(
  JSON.parse(readFileSync(spec('events.schema.json'), 'utf8')) as object,
);

const PANES = { 'w1:p1': 'implementer', 'w1:p2': 'reviewer' };
const config = (name = 'feature-loop', maxRounds = 5) =>
  parseSkeletonConfig(
    `version: 1\nname: ${name}\nlimits: { max_rounds: ${maxRounds}, turn_timeout: 60m }\n` +
      `nodes:\n  implementer: { profile: claude-code }\n` +
      `  test_gate: { run: npm test, timeout: 10m }\n  reviewer: { profile: codex }\n`,
    'test.yaml',
  );

/** `ts` and `run_id` are excluded from determinism comparison (SPEC R15); everything else is not. */
const comparable = (events: readonly PipelineEvent[]) =>
  events.map((event) => {
    const rest: Record<string, unknown> = { ...event };
    delete rest['ts'];
    delete rest['run_id'];
    return rest;
  });

const drive = async (inputs: ScenarioInput[], task = 'A task', extra: object = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
  const runtime = createFakeRuntime({ inputs, panes: PANES, ...extra });
  const log = openRunLog(dir, 'run-1');
  const outcome = await runSkeleton({ config: config(), runtime, log, task, cwd: '/repo' }).catch(
    (error: unknown) => error,
  );
  return { dir, runtime, log, outcome, events: readEvents(log.paths.events).events };
};

describe('a forward pass', () => {
  it('reproduces approve-round-1 exactly', async () => {
    const scenario = golden('approve-round-1');
    const { outcome, events } = await drive(scenario.inputs, scenario.task);
    expect(outcome).toEqual({ status: 'done' });
    expect(comparable(events)).toEqual(comparable(scenario.expect));
  });

  it('emits only events the schema accepts', async () => {
    const scenario = golden('approve-round-1');
    const { events } = await drive(scenario.inputs, scenario.task);
    for (const event of events) expect(validEvent(event) || validEvent.errors).toBe(true);
  });

  it.each([
    ['an absolute run folder', (dir: string) => dir],
    // the run folder may be given relatively; the reviewer's cwd is not this process's, so a
    // relative path in the prompt would name a file the reviewer cannot open
    ['a relative run folder', (dir: string) => relative(process.cwd(), dir)],
  ])('hands the reviewer a readable path to the gate output, given %s', async (_label, base) => {
    const scenario = golden('approve-round-1');
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
    const runtime = createFakeRuntime({ inputs: scenario.inputs, panes: PANES });
    const log = openRunLog(base(dir), 'run-1');

    // Observe from inside the reviewer's own promptAgent call. Checking after the run finished
    // would say nothing about whether the file and its event existed when the prompt was sent.
    let seen: { prompt: string; recorded?: string; contents?: string } | undefined;
    const watched = Object.create(runtime) as typeof runtime;
    watched.promptAgent = (agent, prompt, deadline, signal) => {
      if (prompt.includes('Review the current diff')) {
        const recorded = readEvents(log.paths.events).events.find(
          (e) => e.type === 'handoff_written',
        );
        seen = {
          prompt,
          ...(recorded === undefined
            ? {}
            : {
                recorded: recorded.path,
                contents: readFileSync(resolve(log.paths.root, recorded.path), 'utf8'),
              }),
        };
      }
      return runtime.promptAgent(agent, prompt, deadline, signal);
    };

    await runSkeleton({
      config: config(),
      runtime: watched,
      log,
      task: scenario.task,
      cwd: '/somewhere/else',
    });

    // recorded before the prompt, and stored run-relative whatever the base was
    expect(seen?.recorded).toBe('handoffs/r1-test_gate-1.txt');
    expect(seen?.contents).toBe('12 passing\n');
    // the prompt names an absolute path, so it opens from the reviewer's directory too
    const named = seen?.prompt.match(/output is in (\S+)\./)?.[1] ?? '';
    expect(isAbsolute(named)).toBe(true);
    expect(readFileSync(named, 'utf8')).toBe('12 passing\n');
  });

  it('prompts each agent once and launches the gate once', async () => {
    const scenario = golden('approve-round-1');
    const { runtime } = await drive(scenario.inputs, scenario.task);
    expect(runtime.history.filter((h) => h.call === 'promptAgent')).toHaveLength(2);
    expect(runtime.history.filter((h) => h.call === 'startProcess')).toHaveLength(1);
  });

  it('leaves the guard observation for the engine that owns it', async () => {
    const scenario = golden('approve-round-1');
    const { runtime } = await drive(scenario.inputs, scenario.task);
    expect(runtime.remaining()).toBe(1);
    expect(runtime.peek()).toMatchObject({ kind: 'guard_observation' });
  });

  it('leaves state.json equal to a fresh replay', async () => {
    const scenario = golden('approve-round-1');
    const { log, events } = await drive(scenario.inputs, scenario.task);
    expect(JSON.parse(readFileSync(log.paths.state, 'utf8'))).toEqual(replay(events));
  });

  it('takes its deadlines from the configuration', async () => {
    const scenario = golden('approve-round-1');
    const before = Date.now();
    const { runtime } = await drive(scenario.inputs, scenario.task);
    const prompt = runtime.history.find((h) => h.call === 'promptAgent');
    const gate = runtime.history.find((h) => h.call === 'startProcess');
    expect(prompt?.deadline).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(prompt?.deadline).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(gate?.deadline).toBeGreaterThanOrEqual(before + 600_000);
    expect(gate?.deadline).toBeLessThanOrEqual(Date.now() + 600_000);
  });
});

/**
 * The scenarios place a guard observation between rounds, and the engine does not consume guards —
 * the read-only guard is a later step. A guard at the head blocks the next result, so the driver
 * drains it immediately before each observation: deterministic, with no reliance on scheduling.
 */
const driving = (runtime: ReturnType<typeof createFakeRuntime>, drained: boolean[]) => {
  const drain = () => {
    while (runtime.peek()?.kind === 'guard_observation') {
      const taken = runtime.nextGuardObservation();
      drained.push(taken?.changed ?? true);
      runtime.release();
    }
  };
  const driven = Object.create(runtime) as typeof runtime;
  driven.observeAgentTurn = (...args) => (drain(), runtime.observeAgentTurn(...args));
  driven.observeProcess = (...args) => (drain(), runtime.observeProcess(...args));
  return driven;
};

const loop = async (name: string, pipeline: string, maxRounds: number) => {
  const scenario = golden(name);
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
  const runtime = createFakeRuntime({ inputs: scenario.inputs, panes: PANES });
  const drained: boolean[] = [];
  const log = openRunLog(dir, 'run-1');
  const outcome = await runSkeleton({
    config: config(pipeline, maxRounds),
    runtime: driving(runtime, drained),
    log,
    task: scenario.task,
    cwd: '/repo',
  }).catch((error: unknown) => error);
  return { scenario, runtime, log, outcome, drained, events: readEvents(log.paths.events).events };
};

describe('going round again', () => {
  it.each([
    ['gate-fail-then-pass', 'feature-loop', 5, { status: 'done' }, 0],
    ['revise-twice', 'feature-loop', 5, { status: 'done' }, 2],
    [
      'max-rounds',
      'feature-loop-tight',
      2,
      { status: 'paused', pendingEntry: { node: 'implementer', round: 3 } },
      1,
    ],
  ] as const)('reproduces %s exactly', async (name, pipeline, maxRounds, expected, guards) => {
    const run = await loop(name, pipeline, maxRounds);
    expect(run.outcome).toEqual(expected);
    expect(comparable(run.events)).toEqual(comparable(run.scenario.expect));
    for (const event of run.events) expect(validEvent(event) || validEvent.errors).toBe(true);
    // the intermediate guards were drained in order, each reporting no change; the last is left
    expect(run.drained).toEqual(Array.from({ length: guards }, () => false));
    expect(run.runtime.remaining()).toBe(1);
    expect(run.runtime.peek()).toMatchObject({ kind: 'guard_observation' });
  });

  it('advances the round only on re-entry to the implementer', async () => {
    const { events } = await loop('revise-twice', 'feature-loop', 5);
    const entries = events
      .filter((e) => e.type === 'node_started')
      .map((e) => `${e.node}:${e.round}`);
    expect(entries).toEqual([
      'implementer:1',
      'test_gate:1',
      'reviewer:1',
      'implementer:2',
      'test_gate:2',
      'reviewer:2',
      'implementer:3',
      'test_gate:3',
      'reviewer:3',
      'done:3',
    ]);
  });

  it('gives each round its own turn and execution, and replays them without relaunching', async () => {
    const { runtime } = await loop('revise-twice', 'feature-loop', 5);
    const prompts = runtime.history.filter((h) => h.call === 'promptAgent');
    const launches = runtime.history.filter((h) => h.call === 'startProcess');
    expect(prompts).toHaveLength(6); // three rounds, implementer and reviewer each
    expect(launches).toHaveLength(3); // one gate execution per round
    expect(new Set(prompts.map((h) => h.turnId)).size).toBe(6);
    expect(new Set(launches.map((h) => h.executionId)).size).toBe(3);

    // Now actually look again at work that has already settled, against the underlying fake so
    // the driver does not drain the guard still sitting at the head.
    const remaining = runtime.remaining();
    const turnId = prompts[0]?.turnId as TurnId;
    const executionId = launches[0]?.executionId as ExecutionId;
    const turnAgain = await runtime.observeAgentTurn(turnId, Date.now() + 1000);
    const turnOnceMore = await runtime.observeAgentTurn(turnId, Date.now() + 1000);
    const ranAgain = await runtime.observeProcess(executionId, Date.now() + 1000);
    const ranOnceMore = await runtime.observeProcess(executionId, Date.now() + 1000);

    expect(turnAgain).toMatchObject({ kind: 'settled', turnId });
    expect(turnOnceMore).toEqual(turnAgain); // the same answer, for the same turn
    expect(ranAgain).toMatchObject({ kind: 'completed', executionId, exitStatus: 0 });
    expect(ranOnceMore).toEqual(ranAgain);
    // nothing was submitted or launched again, and no scripted input was spent
    expect(runtime.history.filter((h) => h.call === 'promptAgent')).toHaveLength(6);
    expect(runtime.history.filter((h) => h.call === 'startProcess')).toHaveLength(3);
    expect(runtime.remaining()).toBe(remaining);
    expect(runtime.peek()).toMatchObject({ kind: 'guard_observation' });
  });

  it('numbers handoffs within each round, and keeps their contents', async () => {
    const { events, log } = await loop('revise-twice', 'feature-loop', 5);
    const handoffs = events.filter((e) => e.type === 'handoff_written');
    expect(handoffs.map((h) => h.path)).toEqual([
      'handoffs/r1-test_gate-1.txt',
      'handoffs/r1-reviewer-1.txt',
      'handoffs/r2-test_gate-1.txt',
      'handoffs/r2-reviewer-1.txt',
      'handoffs/r3-test_gate-1.txt',
    ]);
    expect(readFileSync(resolve(log.paths.root, handoffs[0]?.path ?? ''), 'utf8')).toBe(
      '12 passing\n',
    );
    expect(readFileSync(resolve(log.paths.root, handoffs[1]?.path ?? ''), 'utf8')).toContain(
      'VERDICT: REVISE',
    );
  });

  it('leaves state.json equal to a replay of the paused run', async () => {
    const { events, log } = await loop('max-rounds', 'feature-loop-tight', 2);
    const state = replay(events);
    expect(JSON.parse(readFileSync(log.paths.state, 'utf8'))).toEqual(state);
    // the log keeps the stored round; only the returned pendingEntry names the refused one
    expect(state).toMatchObject({
      status: 'paused',
      round: 2,
      escalation: { node: 'implementer', round: 2, reason: 'max_rounds' },
    });
  });
});

describe('what the next round is told', () => {
  /** Every implementer prompt, with the handoff it names and that file's full contents. */
  const entryPrompts = async (name: string) => {
    const scenario = golden(name);
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
    const runtime = createFakeRuntime({ inputs: scenario.inputs, panes: PANES });
    const log = openRunLog(dir, 'run-1');
    const seen: { named?: string; recorded: string[]; contents?: string }[] = [];
    const driven = driving(runtime, []);
    const watched = Object.create(driven) as typeof driven;
    watched.promptAgent = (agent, prompt, deadline, signal) => {
      if (prompt.includes('Implement this') || prompt.includes('Address the findings')) {
        const named = prompt.match(/findings in (\S+)\./)?.[1];
        seen.push({
          recorded: readEvents(log.paths.events)
            .events.filter((e) => e.type === 'handoff_written')
            .map((e) => e.path),
          ...(named === undefined ? {} : { named, contents: readFileSync(named, 'utf8') }),
        });
      }
      return driven.promptAgent(agent, prompt, deadline, signal);
    };
    await runSkeleton({
      config: config('feature-loop', 5),
      runtime: watched,
      log,
      task: scenario.task,
      cwd: '/somewhere/else',
    });
    return { seen, root: log.paths.root, scenario };
  };
  /** What the runtime actually produced, straight from the fixture. */
  const produced = (scenario: { inputs: ScenarioInput[] }, node: string) =>
    scenario.inputs.flatMap((input) =>
      input.kind === 'agent_result' && input.node === node && input.result === 'settled'
        ? [input.text]
        : input.kind === 'gate_result' && input.node === node
          ? [input.output]
          : [],
    );

  it("points each revise entry at that round's own review, in full", async () => {
    const { seen, root, scenario } = await entryPrompts('revise-twice');
    const reviews = produced(scenario, 'reviewer');
    expect(seen).toHaveLength(3);
    expect(seen[0]?.named).toBeUndefined(); // the first entry has nothing to address
    for (const [index, round] of [1, 2].entries()) {
      const path = `handoffs/r${round}-reviewer-1.txt`;
      expect(seen[index + 1]?.recorded).toContain(path); // recorded before the prompt names it
      expect(seen[index + 1]?.named).toBe(resolve(root, path)); // that round's review, not another
      expect(seen[index + 1]?.contents).toBe(reviews[index]); // complete, not just the verdict line
    }
  });

  it('points a gate-failure entry at that gate run, in full', async () => {
    const { seen, root, scenario } = await entryPrompts('gate-fail-then-pass');
    const outputs = produced(scenario, 'test_gate');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.named).toBe(resolve(root, 'handoffs/r1-test_gate-1.txt'));
    expect(seen[1]?.contents).toBe(outputs[0]);
    expect(seen[1]?.contents).not.toBe(outputs[1]); // the failing run, not the later passing one
  });

  it('refuses the round a failing gate asks for, when the limit is reached', async () => {
    const scenario = golden('gate-fail-then-pass');
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-skeleton-'));
    const runtime = createFakeRuntime({ inputs: scenario.inputs, panes: PANES });
    const log = openRunLog(dir, 'run-1');
    const outcome = await runSkeleton({
      config: config('feature-loop', 1), // one round only: the gate's failure asks for a second
      runtime: driving(runtime, []),
      log,
      task: scenario.task,
      cwd: '/repo',
    });
    expect(outcome).toEqual({
      status: 'paused',
      pendingEntry: { node: 'implementer', round: 2 },
    });
    const events = readEvents(log.paths.events).events;
    // the refusal is the last thing recorded, carrying the stored round, not the refused one
    expect(events.at(-1)).toMatchObject({
      type: 'escalated',
      node: 'implementer',
      round: 1,
      reason: 'max_rounds',
    });
    expect(events.filter((e) => e.type === 'node_started' && e.round === 2)).toHaveLength(0);
    // and nothing was prompted for the entry that was refused
    expect(runtime.history.filter((h) => h.call === 'promptAgent')).toHaveLength(1);
  });
});

describe('paths this engine does not take', () => {
  const lastTypes = (events: readonly PipelineEvent[]) => events.map((e) => e.type);

  it.each([
    [
      'an observation that never settles',
      [{ kind: 'agent_result', node: 'implementer', result: 'blocked' }] as ScenarioInput[],
      'observation',
    ],
    [
      'a reviewer that returned no verdict',
      [
        { kind: 'agent_result', node: 'implementer', result: 'settled', text: 'done\n' },
        { kind: 'gate_result', node: 'test_gate', exit_status: 0, output: 'ok\n' },
        { kind: 'agent_result', node: 'reviewer', result: 'settled', text: 'Looks fine to me.\n' },
      ] as ScenarioInput[],
      'missing_verdict',
    ],
  ])('stops on %s without recording an outcome', async (_label, inputs, reason) => {
    const { outcome, events } = await drive(inputs);
    expect(outcome).toBeInstanceOf(UnsupportedPath);
    expect(outcome).toMatchObject({ reason });
    // whatever entry was open stays open: no outcome was produced, so none is invented
    expect(events.at(-1)?.type).toBe('node_started');
    expect(lastTypes(events)).not.toContain('run_finished');
  });

  it('stops before any node entry when an agent will not start', async () => {
    const { outcome, events } = await drive([], 'A task', {
      launches: { 'w1:p1': { kind: 'not_ready', detail: 'trust prompt' } },
    });
    expect(outcome).toBeInstanceOf(UnsupportedPath);
    expect(outcome).toMatchObject({ node: 'implementer', reason: 'observation' });
    expect(lastTypes(events)).toEqual(['run_started']); // the run opened and went no further
  });
});
