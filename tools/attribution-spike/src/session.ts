import { isAbsolute, join } from 'node:path';

import {
  type FirstRecord,
  readFirstRecord,
  type ReadOptions,
  validComponent,
} from './first-record.js';
import { claudeSlug } from './lib.js';

/**
 * Session-bound transcript ownership: a second mode beside `ownedTranscripts`' isolated roots.
 *
 * Here the configuration directory is reused, so where a file sits proves nothing about who wrote
 * it. What binds a transcript to *this* run is a session id the harness chose and recorded before
 * the agent existed. Ownership therefore starts from that launch record and never from a file's
 * contents: a transcript that merely says the right things, without a launch bound to its id, is
 * not ours.
 *
 * The read itself is descriptor-anchored (see `first-record.ts`): it starts from the opened root
 * descriptor, which is trusted, and cannot be redirected outside it by later pathname swaps.
 */

/** Everything recorded about a launch before it happened. */
export interface LaunchBinding {
  /** The UUID passed as `--session-id`. */
  readonly sessionId: string;
  /** The research configuration directory the agent was pointed at. Trusted: harness-created. */
  readonly configRoot: string;
  /** The working directory the agent was started in. */
  readonly scratch: string;
  /** The exact launch arguments, as recorded before launch. */
  readonly argv: readonly string[];
}

/** Reads one file's first record under a root. `readFirstRecord` in production; a stub in tests. */
export type RecordReader = (root: string, components: readonly string[]) => Promise<FirstRecord>;

export type SessionOwnership =
  | { readonly owned: true; readonly path: string; readonly sessionId: string }
  | {
      readonly owned: false;
      readonly why: string;
      readonly path?: string;
      readonly diagnostics?: readonly string[];
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The production reader, bounded by `deadline`. A test barrier can never reach the helper from
 * here: the type has no field for one, and any that arrives anyway is dropped.
 */
export const productionReader =
  (deadline: number, overrides: Omit<ReadOptions, 'deadline' | 'barrier'> = {}): RecordReader =>
  (root, components) => {
    const { barrier: _dropped, ...safe } = overrides as ReadOptions;
    void _dropped;
    return readFirstRecord(root, components, { ...safe, deadline });
  };

export type ExpectedTranscript =
  | { readonly ok: true; readonly components: readonly string[]; readonly path: string }
  | { readonly ok: false; readonly why: string; readonly path?: string };

/**
 * Where a bound launch's transcript must be, relative to its configuration root — or why the binding
 * is refused. Decided from the recorded launch alone; nothing is read.
 */
export const expectedTranscript = (binding: LaunchBinding): ExpectedTranscript => {
  const { sessionId, configRoot, scratch, argv } = binding;
  if (!UUID.test(sessionId)) return { ok: false, why: 'the session id is not a UUID' };
  if (!isAbsolute(configRoot) || !isAbsolute(scratch))
    return { ok: false, why: 'the configuration root and working directory must be absolute' };
  const flag = argv.indexOf('--session-id');
  if (flag === -1 || argv[flag + 1] !== sessionId || argv.lastIndexOf('--session-id') !== flag)
    return { ok: false, why: 'the recorded launch was not bound to exactly this session id' };

  const components = ['projects', claudeSlug(scratch), `${sessionId}.jsonl`];
  const path = join(configRoot, ...components);
  if (!components.every(validComponent))
    return { ok: false, why: 'the expected path has an invalid component', path };
  return { ok: true, components, path };
};

/**
 * Whether the transcript for a bound launch exists and identifies itself as that session.
 *
 * Everything that can be refused without touching the disk is refused first. After that exactly one
 * file is asked for — never an alternate filename, never a later record — and anything missing,
 * incomplete or mismatched leaves it unproven.
 */
export const sessionBoundTranscript = async (
  binding: LaunchBinding,
  preExisting: ReadonlySet<string>,
  read: RecordReader,
): Promise<SessionOwnership> => {
  const { sessionId, configRoot, scratch } = binding;
  const expected = expectedTranscript(binding);
  if (!expected.ok)
    return {
      owned: false,
      why: expected.why,
      ...(expected.path === undefined ? {} : { path: expected.path }),
    };
  const { components, path } = expected;
  if (preExisting.has(path))
    return { owned: false, why: 'the expected transcript existed before launch', path };

  const first = await read(configRoot, components);
  if (!first.ok)
    return {
      owned: false,
      why: first.why,
      path,
      ...(first.diagnostics === undefined ? {} : { diagnostics: first.diagnostics }),
    };
  if (!first.newline)
    return { owned: false, why: 'no complete first record within the read limit', path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.bytes.subarray(0, first.bytes.length - 1).toString('utf8'));
  } catch {
    return { owned: false, why: 'the first record is not JSON', path };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { owned: false, why: 'the first record is not an object', path };
  const fields = parsed as Record<string, unknown>;
  if (fields['sessionId'] !== sessionId)
    return { owned: false, why: 'the first record does not state this session id', path };
  if (fields['cwd'] !== scratch)
    return { owned: false, why: 'the first record does not state this working directory', path };
  return { owned: true, path, sessionId };
};
