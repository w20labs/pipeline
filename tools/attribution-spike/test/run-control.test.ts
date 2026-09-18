import { describe, expect, it } from 'vitest';

import { promptGate, recordThenDispatch, withCleanup } from '../src/run-control.js';

describe('cleanup around a run', () => {
  it('runs every cleanup after a failed run, keeping the run’s own failure', async () => {
    const done: string[] = [];
    const result = await withCleanup(
      () => Promise.reject(new Error('the run failed')),
      [() => void done.push('first'), () => void done.push('second')],
    );
    expect(result).toEqual({ ok: false, failure: 'the run failed', cleanupDiagnostics: [] });
    expect(done).toEqual(['first', 'second']); // every one, in the order it was registered
  });

  it('keeps the run’s failure and every cleanup’s, neither hiding the other', async () => {
    const result = await withCleanup(
      () => Promise.reject(new Error('the run failed')),
      [
        () => {
          throw new Error('an earlier cleanup broke'); // and the cleanup after it still runs
        },
        () => 'the last cleanup could not finish',
      ],
    );
    expect(result).toEqual({
      ok: false,
      failure: 'the run failed',
      cleanupDiagnostics: [
        'cleanup threw: Error: an earlier cleanup broke',
        'the last cleanup could not finish',
      ],
    });
  });
});

describe('the launch record', () => {
  it('is written before the launch, and the launch is exactly what was written', async () => {
    const order: string[] = [];
    let recorded: readonly string[] = [];
    const argv = ['claude', '--session-id', 'U', '--model', 'sonnet'];
    const result = await recordThenDispatch(
      argv,
      async (snapshot) => {
        argv.push('--mutated-after-the-call'); // the caller changes its array mid-write
        argv[2] = 'OTHER';
        await Promise.resolve();
        recorded = [...snapshot];
        order.push('persist');
      },
      (snapshot) => {
        order.push('dispatch');
        return Promise.resolve([...snapshot]);
      },
    );
    expect(order).toEqual(['persist', 'dispatch']);
    expect(recorded).toEqual(['claude', '--session-id', 'U', '--model', 'sonnet']);
    expect(result).toEqual({ ok: true, argv: recorded, dispatched: recorded });
  });

  it('launches nothing when the record cannot be written', async () => {
    let dispatches = 0;
    const result = await recordThenDispatch(
      ['claude'],
      () => Promise.reject(new Error('ENOSPC')),
      () => Promise.resolve((dispatches += 1)),
    );
    expect(result).toEqual({
      ok: false,
      why: 'the launch record could not be written; nothing was launched: Error: ENOSPC',
    });
    expect(dispatches).toBe(0);
  });
});

describe('the prompt gate', () => {
  const TARGET = { runId: 'run-1', pane: 'w1:p1', sessionId: 'U' };
  const CONFIRMED = { ...TARGET, confirmedAt: 5 };
  const ALLOWED = { runId: 'run-1' };
  const counting = () => {
    let sends = 0;
    return { submit: () => Promise.resolve((sends += 1)), sends: () => sends };
  };

  it('sends once when confirmation and authorization both match this launch', async () => {
    const c = counting();
    const result = await promptGate(TARGET)(CONFIRMED, ALLOWED, c.submit);
    expect(result).toEqual({ kind: 'submitted', outcome: 1 });
    expect(Object.keys(result)).not.toContain('ready'); // a sent prompt is not a readiness claim
  });

  it.each([
    ['no confirmation', undefined, ALLOWED, 'no operator confirmation'],
    ['no authorization', CONFIRMED, undefined, 'no authorization to prompt'],
    [
      'another run',
      { ...CONFIRMED, runId: 'run-2' },
      ALLOWED,
      'the confirmation is for another runId',
    ],
    [
      'another pane',
      { ...CONFIRMED, pane: 'w1:p9' },
      ALLOWED,
      'the confirmation is for another pane',
    ],
    [
      'another session',
      { ...CONFIRMED, sessionId: 'V' },
      ALLOWED,
      'the confirmation is for another sessionId',
    ],
    [
      'authorization for another run',
      CONFIRMED,
      { runId: 'run-2' },
      'the authorization is for another run',
    ],
  ])('sends nothing with %s', async (_label, confirmation, authorization, why) => {
    const c = counting();
    expect(await promptGate(TARGET)(confirmation, authorization, c.submit)).toEqual({
      kind: 'refused',
      why,
    });
    expect(c.sends()).toBe(0);
  });

  it('keeps the launch it was built for, whatever later happens to the caller’s object', async () => {
    const target = { ...TARGET };
    const gate = promptGate(target);
    target.pane = 'w1:p9'; // changed through the caller's alias
    target.sessionId = 'V';
    const c = counting();
    const replacement = { runId: 'run-1', pane: 'w1:p9', sessionId: 'V', confirmedAt: 5 };
    expect(await gate(replacement, ALLOWED, c.submit)).toEqual({
      kind: 'refused',
      why: 'the confirmation is for another pane',
    });
    expect(await gate(CONFIRMED, ALLOWED, c.submit)).toEqual({ kind: 'submitted', outcome: 1 });
    expect(c.sends()).toBe(1);
  });

  it('never sends twice, whether attempts follow one another or run at once', async () => {
    const gate = promptGate(TARGET);
    const c = counting();
    const results = await Promise.all([
      gate(CONFIRMED, ALLOWED, c.submit),
      gate(CONFIRMED, ALLOWED, c.submit),
    ]);
    expect(await gate(CONFIRMED, ALLOWED, c.submit)).toMatchObject({ kind: 'refused' });
    expect(c.sends()).toBe(1);
    expect(results.map((r) => r.kind).sort()).toEqual(['refused', 'submitted']);
  });

  it('does not hand the authorization back after a submission that failed', async () => {
    const gate = promptGate(TARGET);
    let attempts = 0;
    const failing = () => {
      attempts += 1;
      return Promise.reject(new Error('delivery unknown'));
    };
    expect(await gate(CONFIRMED, ALLOWED, failing)).toEqual({
      kind: 'submission_failed',
      why: 'Error: delivery unknown',
    });
    expect(await gate(CONFIRMED, ALLOWED, failing)).toEqual({
      kind: 'refused',
      why: 'this run’s authorization has already been used',
    });
    expect(attempts).toBe(1);
  });
});
