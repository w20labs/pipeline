import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runChild } from './child.js';

/**
 * The first record of one file under a trusted root, read by a descriptor-anchored helper.
 *
 * `read-first-record.py` does the read, because Node cannot open a path relative to a directory
 * descriptor. This side decides what to ask for, bounds the whole call — including any test
 * barrier — through `runChild`, and trusts nothing the helper prints until it has been validated.
 *
 * **Trusted root.** Protection starts from the root *descriptor* the helper opens. Nothing here or
 * there proves the root's pathname was unchanged before it was opened; the harness creates and
 * records that path, and that is what is trusted.
 *
 * **Runtime dependency:** `python3`, standard library only, with descriptor-relative `os.open`.
 */

/** The whole of what is ever read. */
export const FIRST_RECORD_LIMIT = 65_536;

/** Located beside this module, so it is found from `src` in tests and from `dist` once built. */
export const HELPER = fileURLToPath(new URL('./read-first-record.py', import.meta.url));

export type FirstRecord =
  | { readonly ok: true; readonly bytes: Buffer; readonly newline: boolean }
  | { readonly ok: false; readonly why: string; readonly diagnostics?: readonly string[] };

export interface ReadOptions {
  readonly deadline: number;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
  /** Test-only: a directory the test owns, at which the helper waits. Production never sets it. */
  readonly barrier?: string;
}

/** A path component the helper may be given. Descriptor-relative opening does not constrain these. */
export const validComponent = (part: string): boolean =>
  part !== '' &&
  part !== '.' &&
  part !== '..' &&
  !part.includes('/') &&
  !part.includes('\\') &&
  !part.includes('\0');

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Check the helper's answer against itself: nothing it claims is taken on trust. */
export const validateResponse = (stdout: string): FirstRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, why: 'the helper printed something that is not JSON' };
  }
  const answer = record(parsed);
  const closeErrors = answer?.['closeErrors'];
  if (
    answer === undefined ||
    typeof answer['ok'] !== 'boolean' ||
    !Array.isArray(closeErrors) ||
    !closeErrors.every((e) => typeof e === 'string')
  )
    return { ok: false, why: 'the helper answered in an unexpected shape' };
  const diagnostics = closeErrors as string[];

  if (answer['ok'] === false) {
    const step = answer['step'];
    const error = answer['error'];
    if (typeof step !== 'string' || typeof error !== 'string')
      return { ok: false, why: 'the helper answered in an unexpected shape' };
    return {
      ok: false,
      why: `the helper stopped at ${step}: ${error}`,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  const { count, newline } = answer;
  const encoded = answer['bytes'];
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    typeof newline !== 'boolean' ||
    typeof encoded !== 'string'
  )
    return { ok: false, why: 'the helper answered in an unexpected shape' };
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded)
    return { ok: false, why: 'the helper’s bytes are not canonical base64' };
  if (bytes.length !== count)
    return { ok: false, why: 'the helper’s byte count does not match the bytes it returned' };
  if (count < 0 || count > FIRST_RECORD_LIMIT)
    return { ok: false, why: `the helper returned more than ${FIRST_RECORD_LIMIT} bytes` };
  const first = bytes.indexOf(0x0a);
  // a claimed newline must be present, and be the last byte: an empty answer has no last byte
  if (newline ? count === 0 || first !== count - 1 : first !== -1)
    return { ok: false, why: 'the helper’s newline report does not agree with its bytes' };
  // A close failure is reported, and the evidence is not accepted as a clean read.
  if (diagnostics.length > 0)
    return { ok: false, why: 'the helper could not release what it opened', diagnostics };
  return { ok: true, bytes, newline };
};

export const readFirstRecord = async (
  root: string,
  components: readonly string[],
  options: ReadOptions,
): Promise<FirstRecord> => {
  if (components.length === 0 || !components.every(validComponent))
    return { ok: false, why: 'a path component is empty, relative or contains a separator' };

  const args = [HELPER, '--root', root, '--cap', String(FIRST_RECORD_LIMIT)];
  for (const part of components) args.push('--component', part);
  if (options.barrier !== undefined) args.push('--barrier', options.barrier);

  const outcome = await runChild(options.python ?? 'python3', args, {
    deadline: options.deadline,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn: options.spawn ?? nodeSpawn,
    now: options.now ?? Date.now,
  });
  switch (outcome.kind) {
    case 'not_started':
      return { ok: false, why: 'the deadline had passed before the helper could start' };
    case 'spawn_failed':
      return { ok: false, why: `python3 is required and could not be started: ${outcome.detail}` };
    case 'unterminated':
    case 'exited':
      return { ok: false, why: 'the helper did not finish within its deadline' };
    case 'closed':
      if (outcome.evidence.signalled.length > 0)
        return { ok: false, why: 'the helper did not finish within its deadline' };
      if (outcome.exitCode !== 0)
        return {
          ok: false,
          why: `the helper exited ${outcome.exitCode ?? outcome.signal}: ${outcome.evidence.stderr.trim()}`,
        };
      return validateResponse(outcome.evidence.stdout);
  }
};
