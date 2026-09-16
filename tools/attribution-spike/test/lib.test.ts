import { describe, expect, it } from 'vitest';

import { claudeSlug, mayRepeat, observeTurn, ownedTranscripts } from '../src/lib.js';

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
