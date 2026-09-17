import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runChild } from './child.js';
import { helperTermination } from './helper-termination.js';

/**
 * Reads one control file through `read-control-file.py`, trusting the result only when the helper
 * terminated cleanly and its one line validates. Every problem is fixed wording that names a field,
 * never a value, so nothing from the helper's output — or the file behind it — is echoed.
 */

/** The helper's own bound, repeated here so a cap it would refuse is refused before parsing. */
export const MAX_CAP = 1 << 20;

const REASONS = [
  'arguments',
  'capability',
  'directory_missing',
  'directory_unusable',
  'symlink',
  'open_failed',
  'fstat_failed',
  'not_regular',
  'too_large',
  'read_failed',
  'close_failed',
] as const;
export type RefusalReason = (typeof REASONS)[number];

export interface CloseDiagnostic {
  readonly step: 'close_file' | 'close_directory';
  readonly errno: string | null;
}

export type ControlResult =
  /**
   * `bytes` is a fresh copy, not shared with the helper's output. The result object is frozen, but
   * a Buffer cannot be: the caller owns this copy, and changing it changes nothing else.
   */
  | { readonly kind: 'read'; readonly bytes: Buffer }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'refused';
      readonly reason: RefusalReason;
      readonly errno: string | null;
      readonly diagnostics: readonly CloseDiagnostic[];
    }
  /** The output could not be trusted. No bytes are returned, even if some field looked valid. */
  | { readonly kind: 'unusable'; readonly problems: readonly string[] };

const KEYS: Record<string, string> = {
  read: 'base64,diagnostics,kind',
  missing: 'diagnostics,kind',
  refused: 'diagnostics,errno,kind,reason',
};
const ERRNO = /^E[A-Z0-9]+$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const keysOf = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');
const validErrno = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && ERRNO.test(value));
const unusable = (problem: string): ControlResult =>
  Object.freeze({ kind: 'unusable', problems: Object.freeze([problem]) });

const diagnosticsOf = (value: unknown): readonly CloseDiagnostic[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const copies: CloseDiagnostic[] = [];
  for (const entry of value as unknown[]) {
    const fields = record(entry);
    if (fields === undefined || keysOf(fields) !== 'errno,step') return undefined;
    const { step, errno } = fields;
    if ((step !== 'close_file' && step !== 'close_directory') || !validErrno(errno))
      return undefined;
    copies.push(Object.freeze({ step, errno }));
  }
  return Object.freeze(copies);
};

export const parseControlResult = (stdout: string, cap: number): ControlResult => {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_CAP)
    return unusable('the cap must be a safe integer from 1 to MAX_CAP');
  if (!stdout.endsWith('\n') || stdout.indexOf('\n') !== stdout.length - 1)
    return unusable('the output is not exactly one line');

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unusable('the output is not JSON'); // the parser's message may quote the input
  }
  const fields = record(parsed);
  if (fields === undefined) return unusable('the output is not an object');
  const { kind } = fields;
  if (typeof kind !== 'string' || !Object.hasOwn(KEYS, kind)) return unusable('kind is unknown');
  if (keysOf(fields) !== KEYS[kind]) return unusable(`the ${kind} result has the wrong fields`);
  const diagnostics = diagnosticsOf(fields['diagnostics']);
  if (diagnostics === undefined) return unusable('diagnostics are malformed');

  if (kind === 'refused') {
    const { reason, errno } = fields;
    if (!REASONS.includes(reason as RefusalReason)) return unusable('reason is unknown');
    if (!validErrno(errno)) return unusable('errno is malformed');
    if (reason === 'close_failed' && diagnostics.length === 0)
      return unusable('close_failed carries no diagnostics');
    return Object.freeze({ kind, reason: reason as RefusalReason, errno, diagnostics });
  }
  // any close failure turns a read or a missing file into a refusal, so these carry none
  if (diagnostics.length > 0) return unusable(`the ${kind} result carries diagnostics`);
  if (kind === 'missing') return Object.freeze({ kind });

  const encoded = fields['base64'];
  if (typeof encoded !== 'string') return unusable('base64 is not a string');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return unusable('base64 is not canonical');
  if (bytes.length > cap) return unusable('the bytes exceed the cap');
  return Object.freeze({ kind: 'read', bytes });
};

/** Located beside this module: `src/` in tests, `dist/` once built. */
export const CONTROL_HELPER = fileURLToPath(new URL('./read-control-file.py', import.meta.url));

/**
 * Room for everything on the helper's line except the base64 itself. The largest such line is a
 * refusal with the longest reason, an errno and two close diagnostics, in `json.dumps` spacing:
 * well under 300 bytes, which a test checks rather than assumes.
 */
export const ENVELOPE_BYTES = 512;
export const maxOutputBytesFor = (cap: number): number => 4 * Math.ceil(cap / 3) + ENVELOPE_BYTES;

export interface ControlReadOptions {
  readonly deadline: number;
  readonly cap: number;
  readonly python?: string;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

const validName = (name: unknown): boolean =>
  typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);

export const readControlFile = async (
  controlDir: string,
  name: string,
  options: ControlReadOptions,
): Promise<ControlResult> => {
  // read once: a caller changing the object while the helper runs must not move the cap it checks
  const { deadline, cap, python, spawn, now } = options;
  if (typeof controlDir !== 'string' || !controlDir.startsWith('/') || controlDir.includes('\0'))
    return unusable('the control directory must be an absolute path without NUL');
  if (!validName(name)) return unusable('the name must be a single path component');
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_CAP)
    return unusable('the cap must be a safe integer from 1 to MAX_CAP');
  if (!Number.isFinite(deadline)) return unusable('the deadline must be finite');

  const outcome = await runChild(
    python ?? 'python3',
    [CONTROL_HELPER, '--dir', controlDir, '--name', name, '--cap', String(cap)],
    {
      deadline,
      termGraceMs: 200,
      killGraceMs: 200,
      spawn: spawn ?? nodeSpawn,
      now: now ?? Date.now,
      maxOutputBytes: maxOutputBytesFor(cap),
    },
  );
  const termination = helperTermination(outcome);
  const parsed = parseControlResult(termination.stdout, cap);
  if (termination.problems.length === 0) return parsed;
  // never bytes from a helper that did not terminate cleanly, however valid its line looked
  const parserProblems = parsed.kind === 'unusable' ? parsed.problems : [];
  return Object.freeze({
    kind: 'unusable',
    problems: Object.freeze([...termination.problems, ...parserProblems]),
  });
};
