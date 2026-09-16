import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaneId } from '../src/adapter.js';
import {
  DEFAULT_PROFILES,
  inspectAgent,
  launchAgent,
  type ProfileResolver,
} from '../src/herdr/agent.js';
import { HerdrError, type HerdrRunner } from '../src/herdr/cli.js';

const recorded = (group: string, name: string) => {
  const at = (ext: string) =>
    fileURLToPath(new URL(`./fixtures/herdr/${group}/${name}.${ext}`, import.meta.url));
  const meta = readFileSync(at('meta'), 'utf8');
  return {
    code: Number(/^exit: (\d+)$/m.exec(meta)?.[1]),
    stdout: readFileSync(at('stdout'), 'utf8'),
    stderr: readFileSync(at('stderr'), 'utf8'),
  };
};

/** Replays one recorded response per call, and records the argv it was given. */
const script = (...responses: { code: number; stdout: string; stderr: string }[]) => {
  const calls: (readonly string[])[] = [];
  let next = 0;
  const run: HerdrRunner = (_file, argv) => {
    calls.push(argv);
    const response = responses[next++];
    if (response === undefined) throw new Error(`unscripted call: ${argv.join(' ')}`);
    return Promise.resolve(response);
  };
  return { run, calls };
};

/** The pane every launch here targets, and the name this runtime derives from it. */
const PANE = 'w1:p2' as PaneId;
const NAME = 'pipeline_w1_p2';
const LATER = () => Date.now() + 90_000;
const flagOf = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1];

/**
 * The recorded success, made to answer about the agent the test actually asked for.
 *
 * The fixture is one real spike launch — agent `spike_impl`, kind claude, pane `w1:p2`. A positive
 * case that replayed it verbatim against a request for `pipeline_w1_p2` would be asserting that a
 * mismatched answer succeeds. So the identity fields are rewritten to the request, and everything
 * else is the recording; the mismatch cases below then change one of them back, on purpose.
 */
const started = (
  change: (agent: Record<string, unknown>, result: Record<string, unknown>) => void = () => {},
) => {
  const ok = recorded('agent-start', 'success-extra-args');
  const doc = JSON.parse(ok.stdout) as { result: Record<string, unknown> };
  const agent = doc.result['agent'] as Record<string, unknown>;
  agent['name'] = NAME;
  agent['pane_id'] = PANE;
  change(agent, doc.result);
  return { ...ok, stdout: JSON.stringify(doc) };
};

/**
 * The error a launch rejected with.
 *
 * Narrower than `.catch(cause => cause as HerdrError)`, which widens the awaited type to include
 * the LaunchResult, and stricter: a launch that *resolves* says so here rather than failing later
 * on a missing property. The same helper herdr-layout.test.ts keeps, for the same reason.
 */
const rejection = async (work: Promise<unknown>): Promise<HerdrError> =>
  work.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (cause: unknown) => cause as HerdrError,
  );

/** A run that must never happen: reaching it is the defect, not an error to handle. */
let dispatches = 0;
const refuseToRun: HerdrRunner = (_file, argv) => {
  dispatches += 1;
  throw new Error(`nothing should have been dispatched: ${argv.join(' ')}`);
};

describe('resolving a profile to an agent kind', () => {
  it.each([
    ['claude-code', 'claude'],
    ['codex', 'codex'],
  ])('maps the pipeline profile %s to herdr kind %s', async (profile, kind) => {
    // the two vocabularies differ: the skeleton says claude-code, herdr says --kind claude
    const s = script(started((agent) => (agent['agent'] = kind)));
    const result = await launchAgent(PANE, profile, LATER(), { run: s.run });
    expect(flagOf(s.calls[0] as string[], '--kind')).toBe(kind);
    expect(result).toMatchObject({ kind: 'ready' });
  });

  it.each(['not-a-profile', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'refuses %s rather than resolving it to something',
    async (profile) => {
      // an object literal would answer for every one of these, and the launch would go out with
      // an undefined --kind instead of being refused
      const before = dispatches;
      const error = await rejection(launchAgent(PANE, profile, LATER(), { run: refuseToRun }));
      expect(error).toBeInstanceOf(HerdrError);
      expect(error.fault).toBe('usage'); // herdr classifies its own unknown --kind the same way
      expect(error.message).toContain(profile);
      expect(dispatches).toBe(before); // and it never reached the command line
    },
  );

  it('takes a resolver of the caller’s own, which step 22 will supply', async () => {
    const profiles: ProfileResolver = (name) =>
      name === 'house-style' ? { kind: 'claude', args: ['--verbose'] } : undefined;
    const s = script(started());
    await launchAgent(PANE, 'house-style', LATER(), { run: s.run, profiles });
    const argv = s.calls[0] as string[];
    expect(flagOf(argv, '--kind')).toBe('claude');
    // the agent's own arguments go after the separator, never merged with herdr's
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', '--verbose']);
  });

  it('keeps the default mapping to what the fixtures and herdr both attest', () => {
    expect(DEFAULT_PROFILES('claude-code')).toEqual({ kind: 'claude' });
    expect(DEFAULT_PROFILES('gemini')).toBeUndefined(); // a herdr kind, but no pipeline profile yet
  });
});

describe('launching an agent', () => {
  it('reports the agent herdr registered, in the pane it was asked for', async () => {
    const s = script(started());
    const result = await launchAgent(PANE, 'claude-code', LATER(), { run: s.run });
    expect(result).toEqual({ kind: 'ready', agent: { pane: PANE, name: NAME } });
    const argv = s.calls[0] as string[];
    expect(argv.slice(0, 3)).toEqual(['agent', 'start', NAME]); // named after its pane
    expect(flagOf(argv, '--pane')).toBe(PANE); // and the pane is named, never left to focus
  });

  it.each([
    ['another pane', (a: Record<string, unknown>) => (a['pane_id'] = 'w9:p9'), /w9:p9/],
    ['another agent', (a: Record<string, unknown>) => (a['name'] = 'someone_else'), /someone_else/],
    ['another kind', (a: Record<string, unknown>) => (a['agent'] = 'codex'), /kind claude/],
  ])('refuses a success that names %s', async (_label, change, expected) => {
    // exit 0 establishes that herdr accepted the command, not that it did what was asked
    const s = script(started(change));
    const error = await rejection(launchAgent(PANE, 'claude-code', LATER(), { run: s.run }));
    expect(error.fault).toBe('malformed');
    expect(error.message).toMatch(expected);
  });

  it.each([
    [
      'an answer of the wrong type',
      (_a: Record<string, unknown>, r: Record<string, unknown>) => (r['type'] = 'pane_info'),
      /agent_started/,
    ],
    [
      'an answer with no agent name',
      (a: Record<string, unknown>) => delete a['name'],
      /agent\.name/,
    ],
    [
      'an answer with no pane',
      (a: Record<string, unknown>) => delete a['pane_id'],
      /agent\.pane_id/,
    ],
    ['an answer with no kind', (a: Record<string, unknown>) => delete a['agent'], /agent\.agent/],
  ])('refuses %s', async (_label, change, expected) => {
    const s = script(started(change));
    const error = await rejection(launchAgent(PANE, 'claude-code', LATER(), { run: s.run }));
    expect(error.fault).toBe('malformed');
    expect(error.message).toMatch(expected);
  });

  it.each([
    ['blocked', (a: Record<string, unknown>) => (a['agent_status'] = 'blocked')],
    ['unknown', (a: Record<string, unknown>) => (a['agent_status'] = 'unknown')],
    ['working', (a: Record<string, unknown>) => (a['agent_status'] = 'working')],
    ['not interactive-ready', (a: Record<string, unknown>) => (a['interactive_ready'] = false)],
  ])('refuses to call a successful start ready when herdr reports %s', async (label, change) => {
    // a successful exit with a state that cannot take a prompt is not readiness; only `idle` or
    // `done` together with `interactive_ready` establishes that
    const s = script(started(change));
    const result = await launchAgent(PANE, 'claude-code', LATER(), { run: s.run });
    expect(result).toMatchObject({ kind: 'not_ready', agent: { pane: PANE, name: NAME } });
    expect((result as { detail: string }).detail).toContain(
      label === 'not interactive-ready' ? 'not interactive-ready' : label,
    );
  });

  it.each([
    [
      'a status that is a list, not a string',
      (a: Record<string, unknown>) => (a['agent_status'] = ['idle']),
      /agent_status/,
    ],
    [
      'a status that is a number',
      (a: Record<string, unknown>) => (a['agent_status'] = 1),
      /agent_status/,
    ],
    ['a missing status', (a: Record<string, unknown>) => delete a['agent_status'], /agent_status/],
    [
      'an interactive_ready that is a string',
      (a: Record<string, unknown>) => (a['interactive_ready'] = 'true'),
      /interactive_ready/,
    ],
    [
      'a missing interactive_ready',
      (a: Record<string, unknown>) => delete a['interactive_ready'],
      /interactive_ready/,
    ],
  ])('refuses %s rather than reading it as a state', async (_label, change, expected) => {
    // `String(['idle'])` is `'idle'`: coercing here would turn a malformed answer into a
    // promptable agent, which is the one reading that must never happen
    const s = script(started(change));
    const error = await rejection(launchAgent(PANE, 'claude-code', LATER(), { run: s.run }));
    expect(error.fault).toBe('malformed');
    expect(error.message).toMatch(expected);
  });

  it('accepts a start that settled as done rather than idle', async () => {
    // both are ordinary settled states for a started agent; neither alone is a defect
    const s = script(started((agent) => (agent['agent_status'] = 'done')));
    expect(await launchAgent(PANE, 'claude-code', LATER(), { run: s.run })).toMatchObject({
      kind: 'ready',
    });
  });

  it('reports an agent blocked at a startup dialog, and answers nothing', async () => {
    const s = script(recorded('agent-start', 'blocked-during-startup'));
    const result = await launchAgent(PANE, 'claude-code', LATER(), { run: s.run });
    expect(result).toMatchObject({ kind: 'not_ready', agent: { pane: PANE } });
    expect((result as { detail: string }).detail).toContain('blocked during startup');
    expect(s.calls).toHaveLength(1); // the dialog is the operator's to clear, not this runtime's
  });

  it('leaves a startup that did not conclude unconfirmed, addressed by pane alone', async () => {
    const s = script(recorded('agent-start', 'timeout'));
    const result = await launchAgent(PANE, 'claude-code', LATER(), { run: s.run });
    // an agent may appear moments later with its name never registered, so the pane is the handle
    expect(result).toMatchObject({ kind: 'startup_unconfirmed', pane: PANE });
    expect(result).not.toHaveProperty('agent');
    expect(s.calls).toHaveLength(1); // and nothing is relaunched
  });

  it.each([
    ['a pane herdr does not have', 'error-pane-not-found', 'api_error', 'agent_pane_not_found'],
    ['a timeout herdr refuses', 'error-invalid-timeout', 'api_error', 'invalid_agent_timeout'],
    ['a kind herdr does not support', 'error-invalid-kind', 'usage', undefined],
  ])('reports %s as the failure it is', async (_label, fixture, fault, code) => {
    const s = script(recorded('agent-start', fixture));
    const error = await rejection(launchAgent(PANE, 'claude-code', LATER(), { run: s.run }));
    // a refused timeout is herdr answering on stderr with exit 1, not a usage error: only the
    // unsupported kind exits 2, and conflating them would lose which input was wrong
    expect(error.fault).toBe(fault);
    expect(error.code).toBe(code);
  });
});

describe('bounding a startup', () => {
  /**
   * Controlled time, not wall-clock tolerances.
   *
   * These cases are about an exact instant, and a tolerance wide enough to absorb a slow machine
   * is also wide enough to absorb a deadline quietly lengthened by a couple of hundred
   * milliseconds. Both the clock the runtime reads and the timer it arms are the test's.
   */
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  /** A runner that never answers, so only the deadline can end the call. */
  const neverAnswers: HerdrRunner = (_file, _argv, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  const timeoutFor = async (budget: number) => {
    const s = script(started());
    await launchAgent(PANE, 'claude-code', Date.now() + budget, { run: s.run });
    return Number(flagOf(s.calls[0] as string[], '--timeout'));
  };

  it('asks herdr for exactly its own minimum when the budget is below it', async () => {
    // herdr refuses 3000 or less with invalid_agent_timeout, so 3001 is the whole of the range
    expect(await timeoutFor(1_000)).toBe(3_001);
  });

  it('asks herdr for exactly its own maximum when the budget is above it', async () => {
    // and refuses more than 300000, so asking for 300001 would turn a workable budget into an error
    expect(await timeoutFor(900_000)).toBe(300_000);
  });

  it('passes a budget inside the range through, to the millisecond', async () => {
    expect(await timeoutFor(5_000)).toBe(5_000);
  });

  it.each([120, 5_000, 400_000])(
    'stays pending until a deadline at +%dms, and settles exactly there',
    async (budget) => {
      // the first is below herdr's floor and the last above its ceiling, so neither is the number
      // this runtime asked herdr for: what settles the call is the caller's own deadline
      let settled: unknown;
      void launchAgent(PANE, 'claude-code', Date.now() + budget, { run: neverAnswers }).then(
        (result) => (settled = result),
      );
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(settled).toBeUndefined(); // not a millisecond early
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ kind: 'startup_unconfirmed', pane: PANE }); // nor one late
    },
  );

  it('dispatches nothing once the deadline has passed', async () => {
    const before = dispatches;
    const result = await launchAgent(PANE, 'claude-code', Date.now() - 1, { run: refuseToRun });
    expect(dispatches).toBe(before);
    // unconfirmed rather than "nothing is there": this call started nothing, which says nothing
    // about what the pane already holds
    expect(result).toMatchObject({ kind: 'startup_unconfirmed', pane: PANE });
    expect((result as { detail: string }).detail).toContain('deadline had already passed');
    // and a budget that is merely tiny, rather than gone, still dispatches
    const s = script(started());
    await launchAgent(PANE, 'claude-code', Date.now() + 5_000, { run: s.run });
    expect(s.calls).toHaveLength(1);
  });
});

type R = Record<string, unknown>;

describe('inspecting a pane', () => {
  /**
   * A `pane get` answer built from a real recording.
   *
   * The base is `agent-start/timeout-after-state` — an actual `herdr pane get w1:p2` taken right
   * after a startup timeout, which is exactly the recovery this inspection exists for. Anything a
   * case changes is a *synthetic* variation and is named as such in that case.
   */
  const paneGet = (
    change: (pane: Record<string, unknown>, result: Record<string, unknown>) => void = () => {},
  ) => {
    const ok = recorded('agent-start', 'timeout-after-state');
    const doc = JSON.parse(ok.stdout) as { result: Record<string, unknown> };
    change(doc.result['pane'] as Record<string, unknown>, doc.result);
    return { ...ok, stdout: JSON.stringify(doc) };
  };

  /** A `pane get` failure, adapted from the recorded `pane read` one: the code is what matters. */
  const paneNotFound = () => {
    const recordedRead = recorded('pane-read', 'error-bad-pane');
    return {
      ...recordedRead,
      stderr: recordedRead.stderr.replace('cli:pane:read', 'cli:pane:get'),
    };
  };

  it('adopts a pane holding a ready agent, with no registered name', async () => {
    // the recording as taken: a launch whose startup timed out, and the agent is there after all
    const s = script(paneGet());
    const result = await inspectAgent(PANE, LATER(), undefined, { run: s.run });
    expect(result).toEqual({ kind: 'ready', agent: { pane: PANE } });
    expect(result).not.toHaveProperty('agent.name'); // pane get reports a kind, not a name
    expect(s.calls[0]).toEqual(['pane', 'get', PANE]);
  });

  it.each([
    ['done', 'ready'],
    ['working', 'working'],
    ['blocked', 'not_ready'],
    ['unknown', 'state_unknown'],
  ])('reports a synthetic %s status as %s', async (status, kind) => {
    const s = script(paneGet((pane) => (pane['agent_status'] = status)));
    const result = await inspectAgent(PANE, LATER(), undefined, { run: s.run });
    expect(result).toMatchObject({ kind, agent: { pane: PANE } });
  });

  it('says only that herdr reports a blocked state, inventing no dialog text', async () => {
    // `pane get` carries no dialog content, so none is reported; reading it is a later concern
    const s = script(paneGet((pane) => (pane['agent_status'] = 'blocked')));
    const result = await inspectAgent(PANE, LATER(), undefined, { run: s.run });
    expect((result as { detail: string }).detail).toBe('herdr reports a blocked state');
  });

  it('tells an unrecognized process from an agent in an unknown state', async () => {
    // both recordings report agent_status "unknown"; only the `agent` key separates them
    const unrecognized = script(recorded('pane-get', 'unrecognized-cli'));
    const recognised = script(recorded('pane-get', 'known-agent-unknown'));
    const absent = await inspectAgent('w1:p3' as PaneId, LATER(), undefined, {
      run: unrecognized.run,
    });
    const present = await inspectAgent('w1:p4' as PaneId, LATER(), undefined, {
      run: recognised.run,
    });

    expect(absent).toEqual({ kind: 'no_agent', pane: 'w1:p3' });
    expect(present).toMatchObject({ kind: 'state_unknown', agent: { pane: 'w1:p4' } });
    // and `no_agent` is never a claim that the pane is idle or free: a node REPL produced it
    expect(absent).not.toMatchObject({ kind: 'ready' });
  });

  it('reports a pane herdr does not have as established absence', async () => {
    const s = script(paneNotFound());
    expect(await inspectAgent(PANE, LATER(), undefined, { run: s.run })).toEqual({
      kind: 'unknown_pane',
      pane: PANE,
    });
  });

  it.each([
    ['an answer of the wrong type', (_p: R, r: R) => (r['type'] = 'agent_info'), /pane_info/],
    ['an answer with no pane object', (_p: R, r: R) => delete r['pane'], /pane object/],
    ['an answer about another pane', (p: R) => (p['pane_id'] = 'w9:p9'), /w9:p9/],
    ['an agent that is null', (p: R) => (p['agent'] = null), /non-empty string/],
    ['an agent that is empty', (p: R) => (p['agent'] = ''), /non-empty string/],
    ['an agent that is a number', (p: R) => (p['agent'] = 7), /non-empty string/],
    ['an agent that is a list', (p: R) => (p['agent'] = ['claude']), /non-empty string/],
    ['a missing status', (p: R) => delete p['agent_status'], /agent_status string/],
    ['a status that is a list', (p: R) => (p['agent_status'] = ['idle']), /agent_status string/],
    ['a status herdr does not report', (p: R) => (p['agent_status'] = 'sleeping'), /sleeping/],
  ])('refuses %s rather than classifying it', async (_label, change, expected) => {
    // every one of these is synthetic, and each must be refused before any classification —
    // `no_agent` included, since that is a claim about this pane
    const s = script(paneGet(change));
    const error = await rejection(inspectAgent(PANE, LATER(), undefined, { run: s.run }));
    expect(error.fault).toBe('malformed');
    expect(error.message).toMatch(expected);
  });

  it.each([
    [
      'names another pane',
      (pane: R) => {
        delete pane['agent'];
        pane['pane_id'] = 'w9:p9';
      },
      /w9:p9/,
    ],
    [
      'carries no pane id at all',
      (pane: R) => {
        delete pane['agent'];
        delete pane['pane_id'];
      },
      /not the pane/,
    ],
    [
      'is not a pane_info',
      (pane: R, result: R) => {
        delete pane['agent'];
        result['type'] = 'agent_info';
      },
      /pane_info/,
    ],
  ])(
    'refuses an agent-less answer that %s, rather than reporting no_agent',
    async (_label, change, expected) => {
      // `no_agent` is a claim about *this* pane, so it may not be made from an answer never
      // established to be about it. Every validation runs first, absence included.
      const s = script(paneGet(change));
      const error = await rejection(inspectAgent(PANE, LATER(), undefined, { run: s.run }));
      expect(error.fault).toBe('malformed');
      expect(error.message).toMatch(expected);
    },
  );

  it('raises a failure that is not absence, rather than reporting the pane unknown', async () => {
    const s = script(recorded('agent-start', 'error-invalid-kind')); // exit 2, a usage error
    const error = await rejection(inspectAgent(PANE, LATER(), undefined, { run: s.run }));
    expect(error.fault).toBe('usage');
  });

  it('asks herdr nothing but pane get', async () => {
    // `agent explain` answers `idle` by default for a pane `pane get` calls unknown. Not asking is
    // what keeps that default out of readiness; this is the assertion that keeps it that way.
    const s = script(recorded('pane-get', 'known-agent-unknown'));
    await inspectAgent('w1:p4' as PaneId, LATER(), undefined, { run: s.run });
    expect(s.calls).toHaveLength(1);
    expect(s.calls.map((argv) => argv[0])).toEqual(['pane']);
  });
});

describe('bounding an inspection', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  /** Never answers, so only the deadline or the signal can end the call. */
  const neverAnswers: HerdrRunner = (_file, _argv, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  it('stays pending until its deadline, and times out exactly there', async () => {
    let settled: unknown;
    void inspectAgent(PANE, Date.now() + 2_000, undefined, { run: neverAnswers }).then(
      (result) => (settled = result),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // a timeout says nothing about what the pane holds — it is not `no_agent` and not `unknown_pane`
    expect(settled).toEqual({ kind: 'timed_out', pane: PANE });
  });

  it('is cancelled by a signal that aborts after dispatch, distinctly from a timeout', async () => {
    const controller = new AbortController();
    let settled: unknown;
    void inspectAgent(PANE, Date.now() + 60_000, controller.signal, { run: neverAnswers }).then(
      (result) => (settled = result),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBeUndefined(); // dispatched, and waiting

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ kind: 'cancelled', pane: PANE });
  });

  it.each([
    [
      'a caller that already aborted',
      () => ({ deadline: Date.now() + 60_000, signal: AbortSignal.abort() }),
      'cancelled',
    ],
    [
      'a deadline already spent',
      () => ({ deadline: Date.now() - 1, signal: undefined }),
      'timed_out',
    ],
    [
      'a caller that aborted with its deadline already spent',
      () => ({ deadline: Date.now() - 1, signal: AbortSignal.abort() }),
      // the caller gave up first, and that is the more specific fact: a timeout would say the
      // inspection ran out of time when nobody was waiting on it any longer
      'cancelled',
    ],
  ])('dispatches nothing for %s', async (_label, shape, kind) => {
    const before = dispatches;
    const { deadline, signal } = shape() as { deadline: number; signal?: AbortSignal };
    expect(await inspectAgent(PANE, deadline, signal, { run: refuseToRun })).toEqual({
      kind,
      pane: PANE,
    });
    expect(dispatches).toBe(before);
  });
});
