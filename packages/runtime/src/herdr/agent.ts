import type { AgentInspection, DeadlineEpochMs, LaunchResult, PaneId } from '../adapter.js';
import { herdrEnvelope, HerdrError, type HerdrOptions } from './cli.js';
import { expectType, nested } from './layout.js';

/**
 * Starting an agent in a pane that already exists.
 *
 * Launching never creates, splits or moves panes, and never answers a startup dialog: an agent
 * waiting at one is reported as waiting, for an operator to clear (SPEC R4, and `docs/SPEC.md`'s
 * rule that the runtime carries no policy).
 *
 * **What a launch may not claim.** herdr's own startup timeout is a wait, not a cancellation: when
 * it expires, an agent may still appear moments later and its name was never registered
 * (`docs/herdr-notes.md`, "agent start"). So a start that does not conclude is
 * `startup_unconfirmed` carrying the *pane* — the only handle that is certainly valid — and the
 * caller adopts whatever is there by inspecting it. Nothing here relaunches on its own.
 */

/** What a pipeline profile becomes on herdr's command line. */
export interface AgentProfile {
  /** herdr's `--kind`, from its own enumeration of supported agents. */
  readonly kind: string;
  /** Arguments for the agent itself, passed after `--`. */
  readonly args?: readonly string[];
}

/**
 * How a pipeline's profile name resolves to a herdr agent kind.
 *
 * A seam, not a profile system: step 22 owns profiles, and replaces {@link DEFAULT_PROFILES} with
 * something configurable. What matters here is that the two vocabularies are *different* — a
 * pipeline says `claude-code`, herdr says `--kind claude` — and that the translation is one named
 * place rather than a guess spread through the launch path.
 */
export type ProfileResolver = (profile: string) => AgentProfile | undefined;

/**
 * The mapping the skeleton pipeline needs, and no more. Unknown profiles are refused, not guessed.
 *
 * A `Map` rather than an object literal: indexing an object reaches `Object.prototype`, so
 * `constructor`, `toString` and `__proto__` would each resolve to something, and a launch would go
 * out with an undefined `--kind` instead of being refused.
 */
const KNOWN_PROFILES = new Map<string, AgentProfile>([
  ['claude-code', { kind: 'claude' }],
  ['codex', { kind: 'codex' }],
]);
export const DEFAULT_PROFILES: ProfileResolver = (profile) => KNOWN_PROFILES.get(profile);

export interface AgentOptions extends HerdrOptions {
  readonly profiles?: ProfileResolver;
  /**
   * The name herdr registers the agent under. Derived from the pane by default, so a launch whose
   * acknowledgement was lost can still be found by the same name on a later attempt.
   */
  readonly nameFor?: (pane: PaneId) => string;
}

/** herdr refuses a startup timeout of 3000ms or less, or of more than 300000ms. */
const MIN_STARTUP_MS = 3001;
const MAX_STARTUP_MS = 300_000;

const defaultName = (pane: PaneId): string => `pipeline_${pane.replace(/[^A-Za-z0-9_]/g, '_')}`;

export async function launchAgent(
  pane: PaneId,
  profile: string,
  deadline: DeadlineEpochMs,
  options: AgentOptions = {},
): Promise<LaunchResult> {
  const resolved = (options.profiles ?? DEFAULT_PROFILES)(profile);
  // A profile with no kind is a misconfigured run, not an uncertain one: it will never launch, and
  // reporting it as unconfirmed would invite the caller to inspect and retry for ever. herdr
  // classifies its own unknown `--kind` as a usage error, and so does this.
  if (resolved === undefined)
    throw new HerdrError(
      'usage',
      ['agent', 'start'],
      `no herdr agent kind is mapped to the profile ${profile}`,
    );

  // A deadline already spent dispatches nothing: `herdrEnvelope` refuses before it starts a child,
  // and the refusal arrives here as a timeout, which is reported below exactly as herdr's own
  // startup timeout is. No second guard for it here — one policy, in one place.
  const budget = deadline - Date.now();

  // Clamped into the range herdr accepts, never beyond the caller's budget: a budget shorter than
  // herdr's own minimum is honoured by the invocation deadline below, which abandons the call —
  // and with it the CLI child — at the instant the caller asked for.
  const startup = Math.min(Math.max(Math.ceil(budget), MIN_STARTUP_MS), MAX_STARTUP_MS);
  const extra = resolved.args ?? [];
  const name = (options.nameFor ?? defaultName)(pane);
  const argv = [
    'agent',
    'start',
    name,
    '--kind',
    resolved.kind,
    '--pane',
    pane,
    '--timeout',
    String(startup),
    ...(extra.length > 0 ? ['--', ...extra] : []),
  ];

  try {
    const started = await herdrEnvelope(argv, { ...options, deadline });
    expectType(started, argv, 'agent_started');
    // An answer about some other pane, agent or kind is not this launch's result, whatever else it
    // says. Exit 0 establishes that herdr accepted the command, not that it did what was asked.
    const mismatch = (field: string, was: string, wanted: string): never => {
      throw new HerdrError(
        'malformed',
        argv,
        `started ${field} ${was}, not the ${wanted} it was given`,
      );
    };
    const at = nested(started, argv, 'agent', 'pane_id');
    if (at !== pane) mismatch('in', at, `pane ${pane}`);
    const registered = nested(started, argv, 'agent', 'name');
    if (registered !== name) mismatch('as', registered, `agent ${name}`);
    const kind = nested(started, argv, 'agent', 'agent');
    if (kind !== resolved.kind) mismatch('a', kind, `kind ${resolved.kind}`);

    // Nor does it establish readiness. herdr reports the state it observed, and `idle` or `done`
    // with `interactive_ready` is the only pair that means this agent can take a prompt now.
    //
    // Checked as the types they are declared to be, never coerced: `String(["idle"])` is `"idle"`,
    // so a coercion would read a malformed answer as a promptable agent. A field of the wrong type
    // is malformed; a well-formed state that simply cannot take a prompt is `not_ready`.
    const agent = started.result['agent'] as Record<string, unknown>;
    const status = agent['agent_status'];
    const interactive = agent['interactive_ready'];
    if (typeof status !== 'string')
      throw new HerdrError('malformed', argv, 'the result carries no agent.agent_status string');
    if (typeof interactive !== 'boolean')
      throw new HerdrError(
        'malformed',
        argv,
        'the result carries no agent.interactive_ready boolean',
      );
    if (!(interactive && (status === 'idle' || status === 'done')))
      return {
        kind: 'not_ready',
        agent: { pane, name: registered },
        detail: `herdr reports ${status}${interactive ? '' : ', not interactive-ready'}`,
      };
    return { kind: 'ready', agent: { pane, name: registered } };
  } catch (cause) {
    const failure = cause as HerdrError;
    // A dialog is a real, addressable state: the agent exists and is named in herdr's message, but
    // has no registered handle in this answer, so it is addressed by pane.
    if (failure.code === 'agent_not_ready')
      return { kind: 'not_ready', agent: { pane }, detail: failure.message };
    // herdr's own startup wait expiring, and this runtime's deadline expiring, are the same fact:
    // readiness was not established, and whether anything launched is unknown.
    if (failure.fault === 'timed_out' || failure.code === 'timeout')
      return { kind: 'startup_unconfirmed', pane, detail: failure.message };
    throw failure;
  }
}

/**
 * What a pane holds, from `pane get` and nothing else.
 *
 * **`agent explain` is deliberately not consulted.** Asked about a pane `pane get` reports as
 * `unknown`, it answers `state: "idle"` with `matched_rule: null` and
 * `fallback_reason: "default_known_agent_idle_fallback"`
 * (test/fixtures/herdr/agent-explain/known-agent-unknown.stdout). A default is not an observation,
 * and readiness manufactured from one would be indistinguishable from the real thing. Not asking
 * is safer than reading the answer carefully, and it costs one call instead of two.
 *
 * **The discriminator is the `agent` key, never the status.** An unrecognized process and a
 * recognised agent in an unknown state both report `agent_status: "unknown"`; only the presence of
 * `agent` tells them apart (docs/herdr-notes.md, Q4). Nothing here concludes a pane is idle or free
 * to reuse — `no_agent` means no agent was recognised, and something may well be running.
 *
 * `pane get` carries no `interactive_ready`, so readiness rests on the reported status alone. That
 * is weaker than {@link launchAgent}'s evidence, which is why this is an inspection and not a
 * launch.
 */
export async function inspectAgent(
  pane: PaneId,
  deadline: DeadlineEpochMs,
  signal?: AbortSignal,
  options: HerdrOptions = {},
): Promise<AgentInspection> {
  const argv = ['pane', 'get', pane];
  const malformed = (detail: string): never => {
    throw new HerdrError('malformed', argv, detail);
  };

  let answer;
  try {
    answer = await herdrEnvelope(argv, {
      ...options,
      deadline,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    const failure = cause as HerdrError;
    // Established absence, and only that: `agent_not_found` would not do here, because it cannot
    // tell a pane with no agent from a pane that does not exist.
    if (failure.code === 'pane_not_found') return { kind: 'unknown_pane', pane };
    // Neither of these claims anything about what the pane holds.
    if (failure.fault === 'timed_out') return { kind: 'timed_out', pane };
    if (failure.fault === 'cancelled') return { kind: 'cancelled', pane };
    throw failure;
  }

  // Everything is validated before anything is classified — including `no_agent`, which is a
  // claim about this pane and may not be made from an answer about another.
  expectType(answer, argv, 'pane_info');
  const held = answer.result['pane'];
  if (typeof held !== 'object' || held === null || Array.isArray(held))
    malformed('the result carries no pane object');
  const reported = held as Record<string, unknown>;
  if (reported['pane_id'] !== pane)
    malformed(`answered about ${String(reported['pane_id'])}, not the pane ${pane} it was given`);

  // Absent means no agent was recognised. Present and unusable — null, empty, or not a string — is
  // a malformed answer, not an absence, and must not be read as one.
  if (!('agent' in reported)) return { kind: 'no_agent', pane };
  const recognised = reported['agent'];
  if (typeof recognised !== 'string' || recognised.length === 0)
    malformed('agent is present but is not a non-empty string');

  const status = reported['agent_status'];
  if (typeof status !== 'string') malformed('the result carries no agent_status string');
  // Pane-addressed: `pane get` reports the agent's kind, not the name herdr registered it under,
  // and this is the handle a launch whose acknowledgement was lost has to adopt.
  const agent = { pane };
  switch (status) {
    case 'idle':
    case 'done':
      return { kind: 'ready', agent };
    case 'working':
      return { kind: 'working', agent };
    case 'blocked':
      // No dialog text is invented: `pane get` did not provide any.
      return { kind: 'not_ready', agent, detail: 'herdr reports a blocked state' };
    case 'unknown':
      return { kind: 'state_unknown', agent, detail: 'herdr reports the agent state as unknown' };
    default:
      // An unsupported value is not a state to act on, and must never fall through to ready.
      return malformed(`agent_status ${String(status)} is not a state herdr reports`);
  }
}
