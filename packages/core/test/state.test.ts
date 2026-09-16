import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { PipelineEvent } from '../src/runlog/events.js';
import { replay, ReplayError, type RunState } from '../src/runlog/state.js';

const dir = fileURLToPath(new URL('../../../spec/scenarios/', import.meta.url));
const golden = (name: string): PipelineEvent[] =>
  (parseYaml(readFileSync(`${dir}${name}.yaml`, 'utf8')) as { expect: PipelineEvent[] }).expect;
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => f.replace(/\.yaml$/, ''))
  .sort();

/** An event stream written here rather than taken from a fixture, for shapes no golden covers. */
const stream = (...events: Partial<PipelineEvent>[]): PipelineEvent[] =>
  events.map((e, i) => ({
    run_id: 'r1',
    seq: i + 1,
    ts: `2026-09-13T09:00:0${i}Z`,
    ...e,
  })) as PipelineEvent[];
const started = { type: 'run_started', pipeline: 'feature-loop', task: 'A task' } as const;

/**
 * Written out from the fixtures by hand, not produced by `replay`: comparing the implementation
 * with itself would establish nothing. Handoff counts and last seq come from the files.
 */
// `handoffs` here is a *count*, not the records themselves, so it replaces the field rather than
// intersecting with it — `readonly HandoffRecord[] & number` is a type nothing can satisfy.
const expected: Record<string, Omit<Partial<RunState>, 'handoffs'> & { handoffs: number }> = {
  'approve-round-1': { status: 'done', round: 1, lastSeq: 10, handoffs: 1 },
  blocked: {
    status: 'paused',
    round: 1,
    openEntry: { node: 'reviewer', round: 1 },
    escalation: { node: 'reviewer', round: 1, reason: 'blocked' },
    lastSeq: 8,
    handoffs: 1,
  },
  'gate-fail-then-pass': { status: 'done', round: 2, lastSeq: 15, handoffs: 2 },
  'guard-violation': {
    status: 'paused',
    round: 1,
    openEntry: { node: 'reviewer', round: 1 },
    escalation: { node: 'reviewer', round: 1, reason: 'guard_violation' },
    lastSeq: 8,
    handoffs: 1,
  },
  // the refused max-round entry escalates without a node_started, so nothing is left open
  'max-rounds': {
    status: 'paused',
    round: 2,
    escalation: { node: 'implementer', round: 2, reason: 'max_rounds' },
    lastSeq: 18,
    handoffs: 4,
  },
  'missing-verdict': {
    status: 'paused',
    round: 1,
    openEntry: { node: 'reviewer', round: 1 },
    escalation: { node: 'reviewer', round: 1, reason: 'missing_verdict' },
    lastSeq: 8,
    handoffs: 1,
  },
  'resume-after-blocked': { status: 'done', round: 1, lastSeq: 12, handoffs: 1 },
  'resume-with-extra-rounds': {
    status: 'done',
    round: 3,
    extraRoundsGranted: 1,
    lastSeq: 28,
    handoffs: 5,
  },
  'revise-twice': { status: 'done', round: 3, lastSeq: 26, handoffs: 5 },
  'stop-mid-turn': { status: 'stopped', round: 1, lastSeq: 3, handoffs: 0 },
  timeout: {
    status: 'paused',
    round: 1,
    openEntry: { node: 'implementer', round: 1 },
    escalation: { node: 'implementer', round: 1, reason: 'timeout' },
    lastSeq: 3,
    handoffs: 0,
  },
  // routing failed after the outcome was produced, so the entry finished before escalating
  'unrouted-port': {
    status: 'paused',
    round: 1,
    escalation: { node: 'reviewer', round: 1, reason: 'unrouted' },
    lastSeq: 9,
    handoffs: 1,
  },
};

describe('the empty log', () => {
  it('establishes no run lifecycle state at all', () => {
    expect(replay([])).toEqual({ lastSeq: 0, eventCount: 0, extraRoundsGranted: 0, handoffs: [] });
  });
});

describe('golden event streams', () => {
  it('covers every scenario', () => {
    expect(names).toEqual(Object.keys(expected).sort());
  });

  it.each(names)('projects %s to its specified state', (name) => {
    const want = expected[name] as Partial<RunState> & { handoffs: number };
    const state = replay(golden(name));
    expect(state.status).toBe(want.status);
    expect(state.round).toBe(want.round);
    expect(state.openEntry).toEqual(want.openEntry);
    expect(state.escalation).toEqual(want.escalation);
    expect(state.extraRoundsGranted).toBe(want.extraRoundsGranted ?? 0);
    expect(state.lastSeq).toBe(want.lastSeq);
    expect(state.eventCount).toBe(want.lastSeq);
    expect(state.handoffs).toHaveLength(want.handoffs);
    // identity and task are copied from run_started, and updatedAt is the last event's own ts
    const events = golden(name);
    const opened = events[0] as Extract<PipelineEvent, { type: 'run_started' }>;
    expect(state.runId).toBe(opened.run_id);
    expect(state.pipeline).toBe(opened.pipeline);
    expect(state.task).toBe(opened.task);
    expect(state.updatedAt).toBe(events.at(-1)?.ts);
  });

  it('projects blocked with its exact identity, written out here', () => {
    expect(replay(golden('blocked'))).toMatchObject({
      runId: 'run-5',
      pipeline: 'feature-loop',
      task: 'Add rate limiting to /api/upload',
      updatedAt: '2026-09-13T09:08:00Z',
    });
  });

  it('takes updatedAt from the end of the prefix, not the end of the stream', () => {
    const events = golden('blocked');
    const stamps = new Set(events.map((e) => e.ts));
    expect(stamps.size).toBeGreaterThan(2); // the fixture really does vary its timestamps
    expect(replay(events.slice(0, 3)).updatedAt).toBe(events[2]?.ts);
    expect(replay(events.slice(0, 3)).updatedAt).not.toBe(events.at(-1)?.ts);
  });

  it('records handoffs in emission order, with the producing node', () => {
    const { handoffs } = replay(golden('gate-fail-then-pass'));
    expect(handoffs).toEqual([
      { node: 'test_gate', round: 1, path: 'handoffs/r1-test_gate-1.txt' },
      { node: 'test_gate', round: 2, path: 'handoffs/r2-test_gate-1.txt' },
    ]);
  });
});

describe('unfinished prefixes', () => {
  const prefix = (name: string, upTo: number) => replay(golden(name).slice(0, upTo));

  it('keeps an escalated entry open while the run is paused', () => {
    const paused = prefix('resume-after-blocked', 8); // through escalated(blocked)
    expect(paused.status).toBe('paused');
    expect(paused.openEntry).toEqual({ node: 'reviewer', round: 1 });
    expect(paused.escalation).toMatchObject({ reason: 'blocked' });
  });

  it('clears the escalation on resume and keeps the same entry open', () => {
    const resumed = prefix('resume-after-blocked', 9); // through resumed
    expect(resumed.status).toBe('running');
    expect(resumed.escalation).toBeUndefined();
    expect(resumed.openEntry).toEqual({ node: 'reviewer', round: 1 }); // the entry it reopened
  });

  it('takes the granted round from resumed, before its node_started', () => {
    const granted = prefix('resume-with-extra-rounds', 19); // through resumed(implementer, 3, +1)
    expect(granted.round).toBe(3); // the newly accepted round, not the stored 2
    expect(granted.extraRoundsGranted).toBe(1);
    expect(granted.openEntry).toBeUndefined(); // the refused entry never opened one
    expect(granted.status).toBe('running');
    const refused = prefix('resume-with-extra-rounds', 18); // through escalated(max_rounds)
    expect(refused.round).toBe(2); // the stored round, not the refused candidate
    expect(refused.openEntry).toBeUndefined();
  });

  it('leaves the entry finished when only routing failed', () => {
    const unrouted = prefix('unrouted-port', 9);
    expect(unrouted.openEntry).toBeUndefined(); // node_finished ended it before the escalation
    expect(unrouted.escalation).toMatchObject({ reason: 'unrouted' });
  });

  it('ends an end-node entry without a node_finished', () => {
    const open = prefix('approve-round-1', 9); // through node_started(done, 1)
    expect(open.openEntry).toEqual({ node: 'done', round: 1 });
    const finished = replay(golden('approve-round-1'));
    expect(finished.openEntry).toBeUndefined(); // run_finished closed it
    expect(finished.status).toBe('done');
  });

  it('projects a run that has only started', () => {
    const state = replay(golden('timeout').slice(0, 1));
    expect(state).toMatchObject({ status: 'running', lastSeq: 1, eventCount: 1 });
    expect(state.round).toBeUndefined(); // no round-bearing event yet
    expect(state.openEntry).toBeUndefined();
  });
});

describe('stop composes with any non-terminal prefix', () => {
  const stopped = { type: 'run_finished', status: 'stopped' } as const;
  const entry = { type: 'node_started', node: 'implementer', round: 1 } as const;
  const escalated = {
    type: 'escalated',
    node: 'implementer',
    round: 1,
    reason: 'blocked',
  } as const;

  it('stops before any entry has begun', () => {
    const state = replay(stream(started, stopped));
    expect(state).toMatchObject({ status: 'stopped', lastSeq: 2 });
    expect(state.round).toBeUndefined();
    expect(state.openEntry).toBeUndefined();
  });

  it('stops while the run is paused, clearing the escalation', () => {
    const state = replay(stream(started, entry, escalated, stopped));
    expect(state.status).toBe('stopped');
    expect(state.escalation).toBeUndefined();
    expect(state.openEntry).toBeUndefined();
    expect(state.round).toBe(1); // the round stays recorded
  });

  it('stops after a resume', () => {
    const resumed = { type: 'resumed', node: 'implementer', round: 1 } as const;
    const state = replay(stream(started, entry, escalated, resumed, stopped));
    expect(state).toMatchObject({ status: 'stopped', lastSeq: 5 });
    expect(state.escalation).toBeUndefined();
  });
});

describe('cumulative grants', () => {
  it('adds every grant in the log, and ignores a resume that granted none', () => {
    const refused = (round: number) =>
      ({ type: 'escalated', node: 'a', round, reason: 'max_rounds' }) as const;
    const state = replay(
      stream(
        started,
        refused(1),
        { type: 'resumed', node: 'a', round: 2, extra_rounds: 2 },
        refused(2),
        { type: 'resumed', node: 'a', round: 3, extra_rounds: 2 },
        // the no-grant resume follows an ordinary resumable escalation, since a max-round resume
        // without a grant is itself refused
        { type: 'node_started', node: 'a', round: 3 },
        { type: 'escalated', node: 'a', round: 3, reason: 'blocked' },
        { type: 'resumed', node: 'a', round: 3 },
      ),
    );
    expect(state.extraRoundsGranted).toBe(4); // never reset, never replaced
    expect(state.round).toBe(3);
    expect(state.openEntry).toEqual({ node: 'a', round: 3 }); // the resumed entry stays open
  });
});

describe('the round follows the events, not a reconstruction', () => {
  it('takes an escalation at its word when it names a different round', () => {
    // In every golden stream an escalation repeats the round already recorded, so this shape is
    // deliberately unusual. It pins the rule the projection actually follows: the latest round an
    // event states, rather than a round inferred by re-applying R3.
    const state = replay(
      stream(
        started,
        { type: 'node_started', node: 'a', round: 1 },
        { type: 'node_finished', node: 'a', round: 1, outcome: 'done' },
        { type: 'escalated', node: 'a', round: 5, reason: 'max_rounds' },
      ),
    );
    expect(state.round).toBe(5);
    expect(state.escalation).toEqual({ node: 'a', round: 5, reason: 'max_rounds' });
  });
});

describe('streams that cannot be projected', () => {
  const entry = { type: 'node_started', node: 'a', round: 1 } as const;
  const escalatedA = { type: 'escalated', node: 'a', round: 1, reason: 'blocked' } as const;
  it.each([
    ['a log not opened by run_started', stream(entry)],
    ['a second run_started', stream(started, started)],
    [
      'an event after run_finished',
      stream(started, { type: 'run_finished', status: 'done' }, entry),
    ],
    [
      'a resumed with nothing to resume',
      stream(started, entry, { type: 'resumed', node: 'a', round: 1 }),
    ],
    [
      'a handoff outside an entry',
      stream(started, { type: 'handoff_written', node: 'a', round: 1, path: 'handoffs/x.txt' }),
    ],
    [
      'a node_finished with no entry open',
      stream(started, { type: 'node_finished', node: 'a', round: 1, outcome: 'done' }),
    ],
  ])('rejects %s', (_label, events) => {
    expect(() => replay(events)).toThrow(ReplayError);
  });

  it.each([
    [
      'a second entry opened over an unfinished one',
      stream(started, entry, { type: 'node_started', node: 'b', round: 1 }),
    ],
    [
      'a node_finished naming a different entry',
      stream(started, entry, { type: 'node_finished', node: 'b', round: 1, outcome: 'done' }),
    ],
    [
      'a node_finished naming a different round',
      stream(started, entry, { type: 'node_finished', node: 'a', round: 2, outcome: 'done' }),
    ],
    [
      'a handoff naming a different entry',
      stream(started, entry, { type: 'handoff_written', node: 'b', round: 1, path: 'h/x.txt' }),
    ],
    [
      'an entry started while the run is paused',
      stream(started, entry, escalatedA, { type: 'node_started', node: 'b', round: 2 }),
    ],
    [
      'an escalation while the run is already paused',
      stream(started, entry, escalatedA, { ...escalatedA, reason: 'timeout' }),
    ],
    [
      'a resume of a different node',
      stream(started, entry, escalatedA, { type: 'resumed', node: 'b', round: 1 }),
    ],
    [
      'a resume at a different round, where no grant explains it',
      stream(started, entry, escalatedA, { type: 'resumed', node: 'a', round: 2 }),
    ],
    [
      'a max_rounds refusal while an entry is open',
      stream(started, entry, { type: 'escalated', node: 'a', round: 1, reason: 'max_rounds' }),
    ],
    [
      'an unrouted escalation that follows no node_finished',
      stream(started, entry, { type: 'escalated', node: 'a', round: 1, reason: 'unrouted' }),
    ],
    [
      'an unrouted escalation reusing a finish from earlier in the run',
      stream(
        started,
        entry,
        { type: 'node_finished', node: 'a', round: 1, outcome: 'done' },
        { type: 'node_started', node: 'b', round: 1 },
        { type: 'escalated', node: 'a', round: 1, reason: 'unrouted' },
      ),
    ],
    [
      'an unrouted escalation reusing a finish from before a max-round grant',
      stream(
        started,
        entry,
        { type: 'node_finished', node: 'a', round: 1, outcome: 'done' },
        { type: 'escalated', node: 'a', round: 1, reason: 'max_rounds' },
        { type: 'resumed', node: 'a', round: 2, extra_rounds: 1 },
        { type: 'escalated', node: 'a', round: 1, reason: 'unrouted' },
      ),
    ],
    [
      'a max-round resume carrying no grant',
      stream(
        started,
        entry,
        { type: 'node_finished', node: 'a', round: 1, outcome: 'done' },
        { type: 'escalated', node: 'a', round: 1, reason: 'max_rounds' },
        { type: 'resumed', node: 'a', round: 2 },
      ),
    ],
    [
      'a resume of an unrouted run, which R12 makes non-resumable',
      stream(
        started,
        entry,
        { type: 'node_finished', node: 'a', round: 1, outcome: 'revise' },
        { type: 'escalated', node: 'a', round: 1, reason: 'unrouted' },
        { type: 'resumed', node: 'a', round: 1 },
      ),
    ],
    [
      'an escalation naming an entry that is not the open one',
      stream(started, entry, { type: 'escalated', node: 'b', round: 1, reason: 'blocked' }),
    ],
  ])('rejects %s', (_label, events) => {
    expect(() => replay(events)).toThrow(ReplayError);
  });

  it('still accepts the shapes those checks must not catch', () => {
    // a granted max-round resume legitimately changes the round, and unrouted follows a finish
    const grant = stream(
      started,
      entry,
      { type: 'node_finished', node: 'a', round: 1, outcome: 'done' },
      { type: 'escalated', node: 'a', round: 1, reason: 'max_rounds' },
      { type: 'resumed', node: 'a', round: 2, extra_rounds: 1 },
      { type: 'node_started', node: 'a', round: 2 },
    );
    expect(replay(grant)).toMatchObject({ round: 2, extraRoundsGranted: 1, status: 'running' });
    const unrouted = stream(
      started,
      entry,
      { type: 'node_finished', node: 'a', round: 1, outcome: 'revise' },
      { type: 'escalated', node: 'a', round: 1, reason: 'unrouted' },
    );
    expect(replay(unrouted).escalation).toMatchObject({ reason: 'unrouted' });
  });

  it('rejects a broken sequence and a second run, naming the position', () => {
    const gap = golden('timeout').map((e, i) => (i === 2 ? { ...e, seq: 9 } : e));
    expect(() => replay(gap)).toThrow(/event 3 \(seq 9\)/);
    const foreign = golden('timeout').map((e, i) => (i === 1 ? { ...e, run_id: 'other' } : e));
    expect(() => replay(foreign)).toThrow(/does not match/);
  });
});
