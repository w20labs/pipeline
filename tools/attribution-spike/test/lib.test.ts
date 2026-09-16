import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Budget,
  claudeSlug,
  dueIn,
  mayRepeat,
  observeTurn,
  Overran,
  ownedTranscripts,
  sampleTargets,
  timedSample,
  within,
} from '../src/lib.js';

const SCRATCH = '/Users/someone/.cache/pipeline-04b-scratch';
const SLUG = claudeSlug(SCRATCH);
const codexHeader = (cwd: string, sessionId = 'sess-new') => ({
  type: 'session_meta',
  payload: { cwd, session_id: sessionId, cli_version: '0.154.0' },
});
/** The private store this run pointed the agents at, and the operator's, which it did not. */
const OURS = '/run/private/codex';
const THEIRS = '/Users/someone/.codex/sessions';
const own = (candidates: Parameters<typeof ownedTranscripts>[0], over = {}) =>
  ownedTranscripts(candidates, {
    agent: 'codex',
    scratch: SCRATCH,
    ownedRoots: [OURS],
    preExisting: new Set<string>(),
    ...over,
  });

describe('which transcripts this run created', () => {
  it('owns a codex session that appeared during the run and names this directory', () => {
    const { owned, unproven } = own([{ path: `${OURS}/new.jsonl`, header: codexHeader(SCRATCH) }]);
    expect(owned).toEqual([{ path: `${OURS}/new.jsonl`, sessionId: 'sess-new' }]);
    expect(unproven).toEqual([]);
  });

  it('refuses a new session this run did not start, in the shared store', () => {
    // the defect: new, unregistered, in the right working directory, and written by something that
    // is not this run. Nothing in the file can say otherwise — only the store it landed in can.
    const { owned, unproven } = own([
      {
        path: `${THEIRS}/2026/09/16/rollout-stranger.jsonl`,
        header: codexHeader(SCRATCH, 'sess-x'),
      },
    ]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toBe('is not in a store this run has exclusive use of');
  });

  it('owns nothing at all when no store was isolated', () => {
    const { owned, unproven } = own([{ path: `${OURS}/new.jsonl`, header: codexHeader(SCRATCH) }], {
      ownedRoots: [],
    });
    expect(owned).toEqual([]);
    expect(unproven).toHaveLength(1);
  });

  it('refuses the store directory itself, which is not a transcript in it', () => {
    const { owned } = own([{ path: OURS, header: codexHeader(SCRATCH, 'sess-root') }]);
    expect(owned).toEqual([]);
  });

  it('refuses a sibling store whose path merely begins with ours', () => {
    const { owned } = own([
      { path: `${OURS}front/new.jsonl`, header: codexHeader(SCRATCH, 'sess-y') },
    ]);
    expect(owned).toEqual([]);
  });

  it('refuses an earlier run’s session in the very same scratch directory', () => {
    // the scratch directory is stable and reused, so "same directory, recently modified" cannot
    // tell this run's sessions from the last one's. Existing beforehand is what decides.
    const { owned, unproven } = own(
      [{ path: `${OURS}/earlier.jsonl`, header: codexHeader(SCRATCH) }],
      {
        preExisting: new Set([`${OURS}/earlier.jsonl`]),
      },
    );
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toBe('existed before this run started');
  });

  it('refuses an unrelated session active at the same moment', () => {
    const { owned, unproven } = own([
      {
        path: `${OURS}/theirs.jsonl`,
        header: codexHeader('/Users/someone/work/private-repo', 'x'),
      },
    ]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toMatch(/private-repo/);
  });

  const NOT_A_HEADER = 'is not a codex session_meta header';
  // exact messages, not a regex: every rejection string here contains "session_meta", so a match
  // on it was satisfied by whichever check happened to fire
  it.each([
    ['a header of the wrong type', { type: 'event_msg', payload: { cwd: SCRATCH } }, NOT_A_HEADER],
    ['a header that is not an object', 'session_meta', NOT_A_HEADER],
    ['no header at all', undefined, NOT_A_HEADER],
    [
      'a session_meta with no cwd',
      { type: 'session_meta', payload: { session_id: 'a' } },
      'its session_meta states no cwd',
    ],
    [
      'a session_meta with no session id',
      { type: 'session_meta', payload: { cwd: SCRATCH } },
      'its session_meta carries no session_id',
    ],
    [
      'a session_meta whose id is empty',
      { type: 'session_meta', payload: { cwd: SCRATCH, session_id: '' } },
      'its session_meta carries no session_id',
    ],
  ])('refuses codex %s', (_label, header, why) => {
    const { owned, unproven } = own([
      { path: `${OURS}/odd.jsonl`, ...(header === undefined ? {} : { header }) },
    ]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toBe(why);
  });

  it('refuses a session started in a subdirectory of the scratch directory', () => {
    // a different working directory, however it is spelled: the comparison is equality, not prefix
    const { owned, unproven } = own([
      { path: `${OURS}/sub.jsonl`, header: codexHeader(`${SCRATCH}/sub`, 'deeper') },
    ]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toBe(`states cwd ${SCRATCH}/sub`);
  });

  it('refuses two files claiming one session id', () => {
    const { owned, unproven } = own([
      { path: `${OURS}/a.jsonl`, header: codexHeader(SCRATCH, 'same') },
      { path: `${OURS}/b.jsonl`, header: codexHeader(SCRATCH, 'same') },
    ]);
    expect(owned).toHaveLength(1);
    expect(unproven[0]?.why).toMatch(/repeats the session id/);
  });
});

describe('which transcripts this run created, for Claude', () => {
  const CLAUDE_ROOT = '/run/private/claude/projects';
  const claude = (candidates: Parameters<typeof ownedTranscripts>[0], over = {}) =>
    own(candidates, { agent: 'claude', ownedRoots: [CLAUDE_ROOT], ...over });
  const SESSION = '7cccbe0d-8cfa-44b2-86db-d80cbcf5150e';

  it('owns a session file named for its id in this run’s project directory', () => {
    const { owned } = claude([{ path: `${CLAUDE_ROOT}/${SLUG}/${SESSION}.jsonl` }]);
    expect(owned).toEqual([
      { path: `${CLAUDE_ROOT}/${SLUG}/${SESSION}.jsonl`, sessionId: SESSION },
    ]);
  });

  it('refuses a sibling project whose slug merely begins the same way', () => {
    // a substring match accepts `<slug>-other`; the directory has to match as a whole segment
    const { owned, unproven } = claude([{ path: `${CLAUDE_ROOT}/${SLUG}-other/${SESSION}.jsonl` }]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toMatch(/project directory/);
  });

  it('refuses a foreign directory that happens to slug identically', () => {
    // slugging is not injective: `~/.cache/x` and `~/-cache/x` are different directories with the
    // same slug, so a matching project name is a locator and never evidence of whose session it is
    const twin = '/Users/someone/-cache/pipeline-04b-scratch';
    expect(claudeSlug(twin)).toBe(SLUG);
    const { owned, unproven } = claude([{ path: `/elsewhere/${SLUG}/${SESSION}.jsonl` }]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toBe('is not in a store this run has exclusive use of');
  });

  it('refuses a file in the right directory that is not named for a session', () => {
    const { owned, unproven } = claude([{ path: `${CLAUDE_ROOT}/${SLUG}/summary.jsonl` }]);
    expect(owned).toEqual([]);
    expect(unproven[0]?.why).toMatch(/named for a session/);
  });

  it('lets a stated directory overrule a matching path', () => {
    const { owned } = claude([
      { path: `${CLAUDE_ROOT}/${SLUG}/${SESSION}.jsonl`, header: { cwd: '/somewhere/else' } },
    ]);
    expect(owned).toEqual([]);
  });

  it('refuses one that existed before the run, wherever it sits', () => {
    const path = `${CLAUDE_ROOT}/${SLUG}/${SESSION}.jsonl`;
    expect(claude([{ path }], { preExisting: new Set([path]) }).owned).toEqual([]);
  });
});

describe('what a turn’s surroundings do and do not show', () => {
  const around = (over: Partial<Parameters<typeof observeTurn>[0]> = {}) =>
    observeTurn({
      assistantBefore: 1,
      assistantAfter: 2,
      paneA: 'text\n',
      paneB: 'text\n',
      ...over,
    });

  it('records growth and quiescence without concluding anything from them', () => {
    // the counterexample this replaces: a commentary line written while a tool is still running
    // grows the transcript, and two reads a moment apart can both catch the pane between writes
    const seen = around();
    expect(seen.signals).toContain('the transcript grew after the submission');
    expect(seen.signals).toContain('the pane did not change between two reads');
    expect(seen.establishesCompletion).toBe(false);
  });

  it.each([
    ['nothing grew', { assistantAfter: 1 }],
    ['the pane was still changing', { paneB: 'text\nmore\n' }],
    ['both reads were empty', { paneA: '', paneB: '' }],
    ['everything looked finished', {}],
  ])('establishes nothing when %s', (_label, over) => {
    expect(around(over).establishesCompletion).toBe(false);
  });

  it('has nowhere for a CLI exit to enter the observation at all', () => {
    expect(Object.keys(around())).toEqual(['signals', 'establishesCompletion']);
  });
});

describe('sending a second prompt to a pane whose turn is outstanding', () => {
  it('is withheld, and takes no argument that could permit it', () => {
    const decision = mayRepeat();
    expect(decision.allowed).toBe(false);
    expect(decision.why).toMatch(/no completion signal tied to a submission/);
    expect(mayRepeat).toHaveLength(0); // nothing to pass, so nothing to satisfy
  });
});

describe('the absolute budget', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('holds the cleanup reserve back from work', () => {
    const budget = new Budget(1_000, 60_000, 5_000);
    expect(budget.forWork(1_000)).toBe(55_000);
    expect(budget.forCleanup(1_000)).toBe(60_000);
  });

  it('gives cleanup the reserve plus whatever work did not spend', () => {
    const budget = new Budget(1_000, 60_000, 5_000);
    expect(budget.forWork(56_000)).toBe(0); // work is out of time
    expect(budget.spent(56_000)).toBe(true);
    expect(budget.forCleanup(56_000)).toBe(5_000); // and cleanup still has its own
  });

  it('never reports negative time once everything is gone', () => {
    const budget = new Budget(1_000, 60_000, 5_000);
    expect(budget.forWork(999_999)).toBe(0);
    expect(budget.forCleanup(999_999)).toBe(0);
  });

  it('bounds a wait on something that never settles', async () => {
    // herdr's own --timeout bounds the command it is given; it does not bound a child that never
    // closes. This is the bound that does.
    let outcome: unknown;
    void within(new Promise(() => undefined), 'a child that never closes', 2_000).catch(
      (cause: unknown) => (outcome = cause),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Overran);
    expect((outcome as Overran).label).toBe('a child that never closes');
  });

  it('refuses a success that arrives after the deadline, however late the timer runs', async () => {
    // A blocked event loop delays the timer but not the work's own callback. The clock is advanced
    // here *without* firing timers, which is exactly that situation: nothing can preempt a blocked
    // loop, but once it resumes the answer must be what actually happened.
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => (finish = resolve));
    const bounded = within(work, 'a read', 20);
    vi.setSystemTime(Date.now() + 80);
    finish('arrived at 80ms');
    await expect(bounded).rejects.toBeInstanceOf(Overran);
    expect(vi.getTimerCount()).toBe(0); // and the timer it never needed is cleared
  });

  it('refuses success at the very instant the budget runs out', async () => {
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => (finish = resolve));
    const bounded = within(work, 'a read', 20);
    vi.setSystemTime(Date.now() + 20);
    finish('arrived exactly on time');
    await expect(bounded).rejects.toBeInstanceOf(Overran);
  });

  it.each([0, -5])('refuses a budget of %dms outright, resolved work and all', async (ms) => {
    // nothing is waited on, so an already-settled promise has no race to win
    await expect(within(Promise.resolve('instant'), 'a read', ms)).rejects.toBeInstanceOf(Overran);
  });

  it('still lets a success inside the budget through', async () => {
    // the positive control: the clock moves, but not past the deadline
    let finish: (value: string) => void = () => undefined;
    const work = new Promise<string>((resolve) => (finish = resolve));
    const bounded = within(work, 'a read', 100);
    vi.setSystemTime(Date.now() + 40);
    finish('arrived at 40ms');
    await expect(bounded).resolves.toBe('arrived at 40ms');
  });

  describe('abandoning work on a budget already spent', () => {
    /**
     * Counts rejections nobody handled, for as long as the case runs.
     *
     * An unhandled rejection is not a failed assertion — it crashes the process before cleanup, which
     * is exactly how the harness would lose its diagnostics. So it is observed directly, and the
     * case then proves the code after the bounded wait was actually reached.
     */
    const watchingUnhandled = () => {
      const seen: unknown[] = [];
      const onUnhandled = (reason: unknown) => seen.push(reason);
      process.on('unhandledRejection', onUnhandled);
      return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
    };
    /** Real timers and a few macrotasks: long enough for an unhandled rejection to be reported. */
    const settle = async () => {
      vi.useRealTimers();
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it.each([0, -5])(
      'handles work that had already rejected, at a %dms budget, and reaches cleanup',
      async (ms) => {
        const watch = watchingUnhandled();
        const reached: string[] = [];
        try {
          const work = Promise.reject(new Error('the command failed first'));
          await expect(within(work, 'a read', ms)).rejects.toBeInstanceOf(Overran);
          await settle();
          reached.push('cleanup');
          expect(watch.seen).toEqual([]);
        } finally {
          watch.stop();
        }
        expect(reached).toEqual(['cleanup']);
      },
    );

    it('handles work that rejects later, after it was abandoned', async () => {
      const watch = watchingUnhandled();
      const reached: string[] = [];
      try {
        let fail: (cause: Error) => void = () => undefined;
        const work = new Promise<string>((_resolve, reject) => (fail = reject));
        await expect(within(work, 'a read', 0)).rejects.toBeInstanceOf(Overran);
        fail(new Error('the command failed afterwards')); // nobody is waiting on it any more
        await settle();
        reached.push('cleanup');
        expect(watch.seen).toEqual([]);
      } finally {
        watch.stop();
      }
      expect(reached).toEqual(['cleanup']);
    });

    it('arms no timer for a budget already spent', async () => {
      const bounded = within(new Promise<string>(() => undefined), 'a read', 0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(bounded).rejects.toBeInstanceOf(Overran);
    });
  });

  it('passes a rejection through as it stands, rather than as a deadline miss', async () => {
    const failed = Promise.reject(new Error('the command failed'));
    await expect(within(failed, 'a read', 1_000)).rejects.toThrow('the command failed');
  });

  it('lets work that finishes in time through, and clears its timer', async () => {
    const done = within(Promise.resolve('answered'), 'a prompt', 2_000);
    await expect(done).resolves.toBe('answered');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('when each sample is due', () => {
  it('measures every target from the closure itself, not from the first read', () => {
    // the defect: a child closed at 50ms was recorded as settling at 1,700ms, because the harness
    // slept and read before taking the timestamp
    const closedAt = 1_050;
    expect(sampleTargets(closedAt, [0, 250, 1_000, 3_000])).toEqual([1_050, 1_300, 2_050, 4_050]);
  });

  it('does not let one read’s cost push the next target out', () => {
    // targets are absolute and computed once, so a slow read at +0 is late *itself* rather than
    // moving +250 to +250-after-the-read
    const targets = sampleTargets(1_000, [0, 250]);
    const first = timedSample(0, targets[0] as number, 1_000, 1_900); // a 900ms read
    const second = timedSample(250, targets[1] as number, 1_900, 1_950);
    expect(first.tookMs).toBe(900);
    expect(second.targetAt).toBe(1_250); // still +250 from closure
    expect(second.missedByMs).toBe(650); // and honestly recorded as 650ms late
  });

  it('records a sample that hit its target as on time', () => {
    const sample = timedSample(250, 1_250, 1_250, 1_270);
    expect(sample.missedByMs).toBe(0);
    expect(sample.tookMs).toBe(20);
  });

  it('never reports a negative miss for a sample taken early', () => {
    expect(timedSample(250, 1_250, 1_240, 1_260).missedByMs).toBe(0);
  });

  it.each([
    ['waits out the remaining time', 1_250, 1_000, 60_000, 250],
    ['does not wait for a target already past', 1_250, 1_400, 60_000, 0],
    ['never waits past what the budget allows', 9_000, 1_000, 500, 500],
  ])('%s', (_label, targetAt, now, budget, expected) => {
    expect(dueIn(targetAt, now, budget)).toBe(expected);
  });
});
