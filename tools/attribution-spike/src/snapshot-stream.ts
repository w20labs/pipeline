/**
 * Validates the stream `snapshot-tree.py` writes, and nothing else.
 *
 * **Protocol completeness only.** A stream can be well-formed and still come from a helper that was
 * killed, exited non-zero or overflowed its output bound; `takeSnapshot` must establish that the
 * helper terminated successfully before a snapshot counts as complete. This function never can.
 *
 * Helper records and this parser's own problems are kept apart: `done`'s counts are checked against
 * what the helper sent, never against the problems found here.
 */

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface SnapshotEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface StreamLimits {
  /** Most `entry` records a stream may carry. */
  readonly cap: number;
  /** Most UTF-8 bytes in one line, **excluding** its terminating newline. */
  readonly maxLineBytes: number;
}

export interface ParsedStream {
  /** Well-formed, one consistent `done`, and the helper itself reported complete. Not termination. */
  readonly protocolComplete: boolean;
  /** Entries from lines that were individually valid, in order; the first of any duplicate path. */
  readonly entries: readonly SnapshotEntry[];
  /** Messages the helper reported. */
  readonly helperDiagnostics: readonly string[];
  /** What this parser found wrong with the stream. */
  readonly problems: readonly string[];
}

const KINDS = new Set<string>(['file', 'dir', 'symlink', 'other']);
const DECIMAL = /^(0|[1-9]\d*)$/;
const ENTRY_KEYS = ['dev', 'ino', 'kind', 'mtimeNs', 'path', 'size', 'type'];

const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).sort().join(',') === [...keys].sort().join(',');

const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  !path.startsWith('/') &&
  path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !/[\\\0]/.test(s));

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export const parseSnapshotStream = (stdout: string, limits: StreamLimits): ParsedStream => {
  const entries: SnapshotEntry[] = [];
  const helperDiagnostics: string[] = [];
  const problems: string[] = [];
  const finish = (complete: boolean): ParsedStream =>
    Object.freeze({
      protocolComplete: complete && problems.length === 0,
      entries: Object.freeze(entries),
      helperDiagnostics: Object.freeze(helperDiagnostics),
      problems: Object.freeze(problems),
    });

  if (!positive(limits.cap) || !positive(limits.maxLineBytes)) {
    problems.push('the stream limits must be positive safe integers');
    return finish(false);
  }

  const lines = stdout.split('\n');
  // Every record ends with a newline, so a complete stream splits into lines and one empty tail.
  if (lines.pop() !== '') problems.push('the stream ends with a partial line');

  const received = { entries: 0, diagnostics: 0 };
  const seen = new Set<string>();
  let done: Record<string, unknown> | undefined;

  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (done !== undefined) return void problems.push(`${at}: a record after done`);
    if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes)
      return void problems.push(`${at}: longer than ${limits.maxLineBytes} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return void problems.push(`${at}: not JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return void problems.push(`${at}: not an object`);
    const record = parsed as Record<string, unknown>;

    switch (record['type']) {
      case 'entry': {
        received.entries += 1;
        const { path, kind, size, mtimeNs, dev, ino } = record;
        const numbers = [size, mtimeNs, dev, ino];
        if (!exactKeys(record, ENTRY_KEYS)) return void problems.push(`${at}: entry fields`);
        if (!validPath(path)) return void problems.push(`${at}: entry path`);
        if (typeof kind !== 'string' || !KINDS.has(kind))
          return void problems.push(`${at}: entry kind`);
        if (!numbers.every((n) => typeof n === 'string' && DECIMAL.test(n)))
          return void problems.push(`${at}: entry numbers`);
        if (seen.has(path)) return void problems.push(`${at}: duplicate path ${path}`);
        if (entries.length >= limits.cap)
          return void problems.push(`${at}: more entries than the cap`);
        seen.add(path);
        entries.push(
          Object.freeze({
            path,
            kind: kind as EntryKind,
            size: BigInt(size as string),
            mtimeNs: BigInt(mtimeNs as string),
            dev: BigInt(dev as string),
            ino: BigInt(ino as string),
          }),
        );
        return;
      }
      case 'diagnostic':
        received.diagnostics += 1;
        if (!exactKeys(record, ['message', 'type']) || typeof record['message'] !== 'string')
          return void problems.push(`${at}: diagnostic fields`);
        helperDiagnostics.push(record['message']);
        return;
      case 'done':
        done = record;
        return;
      default:
        return void problems.push(`${at}: unknown record type`);
    }
  });

  if (done === undefined) {
    problems.push('the stream has no done');
    return finish(false);
  }
  if (
    !exactKeys(done, ['complete', 'diagnostics', 'entries', 'type']) ||
    !count(done['entries']) ||
    !count(done['diagnostics']) ||
    typeof done['complete'] !== 'boolean'
  ) {
    problems.push('done fields');
    return finish(false);
  }
  // against what the helper sent, not against this parser's problems
  if (done['entries'] !== received.entries)
    problems.push('done.entries does not match the entries sent');
  if (done['diagnostics'] !== received.diagnostics)
    problems.push('done.diagnostics does not match the diagnostics sent');
  if (done['complete'] && received.diagnostics > 0)
    problems.push('done claims complete while reporting diagnostics');
  return finish(done['complete']);
};
