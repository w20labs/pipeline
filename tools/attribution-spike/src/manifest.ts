/**
 * Validates the bootstrap manifest the operator writes after bootstrapping the research
 * configuration. Pure: the bytes arrive already read, and nothing here touches the filesystem.
 *
 * Every refusal is fixed wording. No value from the file, and no key it was not supposed to have, is
 * ever repeated, so a manifest cannot carry anything into a report by being rejected. Only the three
 * evidence fields leave this module, and only from a manifest that passed every check.
 */

import { type ControlResult, readControlFile } from './control-file.js';
import { CONTROL_FILES, type Phase } from './runner.js';

export const MAX_MANIFEST_BYTES = 16 * 1024;

export interface ManifestEvidence {
  readonly claudeVersion: string;
  readonly bootstrappedAt: string;
  readonly separateAuthorization: boolean | 'unknown';
}

export type ManifestCheck =
  | { readonly ok: true; readonly evidence: ManifestEvidence }
  | { readonly ok: false; readonly why: string };

const KEYS = [
  'version',
  'configPath',
  'claudeVersion',
  'bootstrappedAt',
  'separateAuthorization',
  'bootstrapSessionClosed',
] as const;
/** Characters that could end or forge a line wherever the version is later shown: C0, DEL, U+2028, U+2029. */
const lineUnsafe = (text: string): boolean =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
  });
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const refuse = (why: string): ManifestCheck => Object.freeze({ ok: false, why });

/**
 * The top-level keys of a JSON object, decoded, in order and including repeats — which `JSON.parse`
 * silently collapses to the last. Only called on text already parsed as an object, so every string
 * is terminated; strings are skipped whole, so quotes, braces or commas inside them count for nothing.
 */
const topLevelKeys = (text: string): string[] => {
  const keys: string[] = [];
  let depth = 0;
  let keyNext = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      // decoded, so "version" and "\u0076ersion" are the same key
      if (depth === 1 && keyNext) keys.push(JSON.parse(text.slice(i, end + 1)) as string);
      keyNext = false;
      i = end;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      keyNext = ch === '{' && depth === 1;
    } else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 1) keyNext = true;
  }
  return keys;
};

/** A real UTC instant, written as `toISOString` would write it, with or without milliseconds. */
const realTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const shape = TIMESTAMP.exec(value);
  if (shape === null) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const expected = shape[1] === undefined ? value.replace(/Z$/, '.000Z') : value;
  return date.toISOString() === expected; // an impossible date rolls over, and so no longer matches
};

export const validateManifest = (bytes: Uint8Array, researchConfig: string): ManifestCheck => {
  if (
    typeof researchConfig !== 'string' ||
    !researchConfig.startsWith('/') ||
    researchConfig.includes('\0')
  )
    return refuse('the research configuration must be an absolute path without NUL');
  if (bytes.length > MAX_MANIFEST_BYTES) return refuse('the manifest is larger than 16 KiB');

  let text: string;
  try {
    // a byte order mark is kept, not skipped, so the JSON check below refuses it
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('the manifest is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('the manifest is not JSON'); // the parser's message may quote the input
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return refuse('the manifest is not a JSON object');

  const seen = topLevelKeys(text);
  if (new Set(seen).size !== seen.length) return refuse('the manifest repeats a key');
  if (seen.some((key) => !(KEYS as readonly string[]).includes(key)))
    return refuse('the manifest has keys outside its schema');
  const missing = KEYS.find((key) => !seen.includes(key));
  if (missing !== undefined) return refuse(`the manifest is missing ${missing}`);

  const m = parsed as Record<(typeof KEYS)[number], unknown>;
  if (m.version !== 1) return refuse('version must be 1');
  if (m.configPath !== researchConfig)
    return refuse('configPath does not name this research configuration');
  if (m.bootstrapSessionClosed !== true)
    return refuse('the bootstrap session is not recorded as closed');
  const version = m.claudeVersion;
  if (typeof version !== 'string' || version.length < 1 || version.length > 128)
    return refuse('claudeVersion must be a string of 1 to 128 characters');
  if (lineUnsafe(version)) return refuse('claudeVersion contains a control character');
  if (!realTimestamp(m.bootstrappedAt))
    return refuse('bootstrappedAt must be a real UTC time in ISO 8601 form');
  const authorization = m.separateAuthorization;
  if (authorization !== true && authorization !== false && authorization !== 'unknown')
    return refuse('separateAuthorization must be true, false or "unknown"');

  return Object.freeze({
    ok: true,
    evidence: Object.freeze({
      claudeVersion: version,
      bootstrappedAt: m.bootstrappedAt,
      separateAuthorization: authorization,
    }),
  });
};

/** Parser problems: all fixed wording, and all mean the helper's output could not be trusted. */
const INVALID_OUTPUT = new Set([
  'the output is not exactly one line',
  'the output is not JSON',
  'the output is not an object',
  'kind is unknown',
  'the read result has the wrong fields',
  'the missing result has the wrong fields',
  'the refused result has the wrong fields',
  'diagnostics are malformed',
  'reason is unknown',
  'errno is malformed',
  'close_failed carries no diagnostics',
  'the read result carries diagnostics',
  'the missing result carries diagnostics',
  'base64 is not a string',
  'base64 is not canonical',
  'the bytes exceed the cap',
]);
const INVALID_REQUEST = new Set([
  'the control directory must be an absolute path without NUL',
  'the name must be a single path component',
  'the cap must be a safe integer from 1 to MAX_CAP',
  'the deadline must be finite',
]);
const FIXED: Record<string, string> = {
  'the helper ended exited': 'ended early',
  'the helper ended unterminated': 'ended early',
  'the helper was signalled to stop': 'signalled to stop',
  'the helper exceeded maxOutputBytes': 'exceeded its output bound',
  'the helper wrote to stderr': 'wrote to stderr',
};
const KILLED = /^the helper was killed by (SIG[A-Z0-9]+)$/;
const EXITED = /^the helper exited (-?\d+|null)$/;

/**
 * One token per problem, from fixed wording only. A problem is matched whole; the one prefix whose
 * remainder is dropped is "did not run", whose detail can be any text the system produced.
 */
const category = (problem: string): string => {
  if (problem.startsWith('the helper did not run: ')) return 'did not run';
  if (Object.hasOwn(FIXED, problem)) return FIXED[problem] as string;
  if (INVALID_OUTPUT.has(problem)) return 'invalid output';
  if (INVALID_REQUEST.has(problem)) return 'invalid request';
  const killed = KILLED.exec(problem);
  if (killed !== null) return `killed by ${String(killed[1])}`;
  const exited = EXITED.exec(problem);
  if (exited !== null) return `exited ${String(exited[1])}`;
  return 'unrecognized';
};

const unreadable = (detail: string) => `the bootstrap manifest could not be read: ${detail}`;

const refusal = (result: Exclude<ControlResult, { kind: 'read' }>): string => {
  switch (result.kind) {
    case 'missing':
      return 'the bootstrap manifest is missing';
    case 'refused': {
      // every part is a fixed reason, a fixed step, or an errno the wrapper already validated
      const errno = result.errno === null ? '' : `, ${result.errno}`;
      const closes = result.diagnostics.map((d) => `; close failed: ${d.step} ${String(d.errno)}`);
      return unreadable(`the helper refused (${result.reason}${errno})${closes.join('')}`);
    }
    case 'unusable': {
      const tokens = [...new Set(result.problems.map(category))];
      return unreadable(tokens.length === 0 ? 'unrecognized' : tokens.join(', '));
    }
  }
};

/**
 * The phase that reads and validates the bootstrap manifest. Its locations are copied when it is
 * made. Every refusal is built from fixed tokens: nothing the reader, the helper or the system wrote
 * as free text reaches the run's summary.
 */
export const manifestPhase = (
  locations: { readonly controlDir: string; readonly researchConfig: string },
  read: typeof readControlFile = readControlFile,
): Phase => {
  const { controlDir, researchConfig } = locations;
  return {
    name: 'manifest',
    run: async ({ deadline }) => {
      let result: ControlResult;
      try {
        result = await read(controlDir, CONTROL_FILES.manifest, {
          deadline,
          cap: MAX_MANIFEST_BYTES,
        });
      } catch {
        return { kind: 'refused', why: 'the bootstrap manifest reader failed unexpectedly' };
      }
      if (result.kind !== 'read') return { kind: 'refused', why: refusal(result) };
      const check = validateManifest(result.bytes, researchConfig);
      return check.ok
        ? { kind: 'completed', evidence: check.evidence }
        : { kind: 'refused', why: `the bootstrap manifest is invalid: ${check.why}` };
    },
  };
};
