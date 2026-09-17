import { spawn as nodeSpawn } from 'node:child_process';

import { runChild } from './child.js';

/**
 * Whether a process this harness recorded is still the same process.
 *
 * Only metadata is ever requested — pid, start time and command name — and only for recorded pids,
 * one per query: on macOS a single unusable pid in a multi-pid call hides the others. Evidence for
 * every rule below was captured on macOS 26.5.2 (BSD ps) and Ubuntu 24.04.5 (procps-ng 4.0.4).
 */

/**
 * The largest pid each platform can issue. macOS: XNU's PID_MAX, confirmed by ps accepting 99999 and
 * refusing 100000. Linux: pids stay below pid_max, whose ceiling on 64-bit kernels is 4194304 — and
 * ps there answers pids above it with the same empty exit-1 as a real absence, so the harness must
 * refuse them itself. Other platforms are unsupported. A pid outside its bound is refused, not clamped.
 */
export const PID_BOUNDS: Readonly<Partial<Record<NodeJS.Platform, number>>> = {
  darwin: 99_999,
  linux: 4_194_303,
};

export interface RecordedProcess {
  readonly pid: number;
  /** `lstart` exactly as ps printed it under LC_ALL=C and TZ=UTC. */
  readonly startedAt: string;
  /** `comm` exactly as ps printed it on this host: a full path on macOS, 15 characters on Linux. */
  readonly command: string;
}

export type Identity =
  /** The recorded record itself is unusable, so no query was made. Blocks. */
  | { readonly kind: 'invalid_record'; readonly why: string }
  /** Still running, same start and same command. Blocks. */
  | { readonly kind: 'leftover' }
  /** The pid now belongs to a process that started at another time. Does not block. */
  | { readonly kind: 'reused'; readonly observed: RecordedProcess }
  /** No process has this pid. Does not block. */
  | { readonly kind: 'absent' }
  /** Nothing established either way. Blocks. */
  | { readonly kind: 'unresolved'; readonly why: string };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** C-locale `%a %b %e %H:%M:%S %Y`: always 24 characters, the day padded with a space. */
const LSTART =
  /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** A real date and time, with the weekday that date actually falls on. */
export const validStartTime = (text: string): boolean => {
  const m = LSTART.exec(text);
  if (m === null) return false;
  const [, day, month, date, hh, mm, ss, year] = m as unknown as string[];
  const monthIndex = MONTHS.indexOf(month as string);
  if (monthIndex === -1 || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return false;
  const at = new Date(
    Date.UTC(Number(year), monthIndex, Number(date), Number(hh), Number(mm), Number(ss)),
  );
  return (
    at.getUTCMonth() === monthIndex &&
    at.getUTCDate() === Number(date) &&
    DAYS[at.getUTCDay()] === day
  );
};

const validCommand = (command: string): boolean =>
  command.length > 0 && command.trim() === command && !/[\r\n]/.test(command);

export const validateRecord = (
  record: RecordedProcess,
  platform: NodeJS.Platform,
): string | undefined => {
  const bound = PID_BOUNDS[platform];
  if (bound === undefined) return `process identity is not supported on ${platform}`;
  if (!Number.isInteger(record.pid) || record.pid < 1 || record.pid > bound)
    return `pid ${String(record.pid)} is not a pid on ${platform} (1 to ${bound})`;
  if (!validStartTime(record.startedAt)) return 'the recorded start time is not a C/UTC lstart';
  if (!validCommand(record.command)) return 'the recorded command is empty or malformed';
  return undefined;
};

/** One `ps` line: pid, the 24-character lstart, then the command, which may contain spaces. */
export const parseIdentityLine = (line: string): RecordedProcess | undefined => {
  const m = /^\s*(\d+) (.{24}) +(.+)$/.exec(line);
  if (m === null) return undefined;
  const [, pid, startedAt, command] = m as unknown as [string, string, string, string];
  if (!validStartTime(startedAt) || !validCommand(command)) return undefined;
  return { pid: Number(pid), startedAt, command };
};

export interface QueryOptions {
  readonly deadline: number;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof nodeSpawn;
  readonly now?: () => number;
}

export const identify = async (
  given: RecordedProcess,
  options: QueryOptions,
): Promise<Identity> => {
  // Copied before anything else: the caller's object can change while the query is pending, and a
  // record changed mid-query must not turn a matching leftover into a reused pid.
  const record: RecordedProcess = Object.freeze({
    pid: given.pid,
    startedAt: given.startedAt,
    command: given.command,
  });
  const platform = options.platform ?? process.platform;
  const invalid = validateRecord(record, platform);
  if (invalid !== undefined) return { kind: 'invalid_record', why: invalid };

  const outcome = await runChild('ps', ['-o', 'pid=,lstart=,comm=', '-p', String(record.pid)], {
    deadline: options.deadline,
    termGraceMs: 200,
    killGraceMs: 200,
    spawn: options.spawn ?? nodeSpawn,
    now: options.now ?? Date.now,
    // pinned for this query only, so the start time's format and timezone cannot drift
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  if (outcome.kind !== 'closed')
    return { kind: 'unresolved', why: `the query ended ${outcome.kind}` };
  // a query that was signalled — including one timed out — never establishes anything
  if (outcome.evidence.signalled.length > 0 || outcome.signal !== null)
    return { kind: 'unresolved', why: 'the query was terminated by a signal' };
  const { stdout, stderr } = outcome.evidence;

  if (outcome.exitCode === 1 && stdout === '' && stderr === '') return { kind: 'absent' };
  if (outcome.exitCode !== 0)
    return { kind: 'unresolved', why: `ps exited ${String(outcome.exitCode)}` };
  if (stderr !== '') return { kind: 'unresolved', why: 'ps succeeded but wrote to stderr' };

  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  if (lines.length !== 1)
    return { kind: 'unresolved', why: 'ps did not answer with exactly one line' };
  const observed = parseIdentityLine(lines[0] as string);
  if (observed === undefined)
    return { kind: 'unresolved', why: 'ps answered with a malformed line' };
  if (observed.pid !== record.pid)
    return { kind: 'unresolved', why: 'ps answered about another pid' };

  if (observed.startedAt !== record.startedAt) return { kind: 'reused', observed };
  if (observed.command !== record.command)
    return { kind: 'unresolved', why: 'same start time but a different command' };
  return { kind: 'leftover' };
};
