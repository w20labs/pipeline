/**
 * Validates the bootstrap manifest the operator writes after bootstrapping the research
 * configuration. Pure: the bytes arrive already read, and nothing here touches the filesystem.
 *
 * Every refusal is fixed wording. No value from the file, and no key it was not supposed to have, is
 * ever repeated, so a manifest cannot carry anything into a report by being rejected. Only the three
 * evidence fields leave this module, and only from a manifest that passed every check.
 */

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
