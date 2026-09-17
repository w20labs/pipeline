import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  identify,
  type Identity,
  PID_BOUNDS,
  type RecordedProcess,
  validStartTime,
} from '../src/process-identity.js';

/**
 * Real `ps -o pid=,lstart=,comm= -p <pid>` output under LC_ALL=C and TZ=UTC, captured 2026-09-17:
 * macOS 26.5.2 (BSD ps) locally, and Ubuntu 24.04.5 (procps-ng 4.0.4) in Docker (`ubuntu:24.04`).
 */
const EVIDENCE = {
  macosLive: '59889 Thu Sep 17 02:33:35 2026     /bin/zsh\n',
  ubuntuLive: '    1 Thu Sep 17 02:33:34 2026 bash\n',
  macosTooLarge: 'ps: process id too large: 100000\n',
  ubuntuOutOfRange: 'error: process ID out of range\n\nUsage:\n ps [options]\n',
};
const MAC: RecordedProcess = {
  pid: 59889,
  startedAt: 'Thu Sep 17 02:33:35 2026',
  command: '/bin/zsh',
};
const UBUNTU: RecordedProcess = { pid: 1, startedAt: 'Thu Sep 17 02:33:34 2026', command: 'bash' };

interface Scripted {
  stdout?: string;
  stderr?: string;
  exit?: number | null;
  signal?: string | null;
  hang?: boolean;
  throws?: Error;
}
/** A `ps` that answers as scripted, recording how it was invoked. */
const fakePs = (script: Scripted) => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawnStub = ((_cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: options.env });
    if (script.throws !== undefined) throw script.throws;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => undefined });
    const child = Object.assign(new EventEmitter(), {
      stdout: stream(),
      stderr: stream(),
      kill: () => true,
      unref: () => undefined,
    });
    queueMicrotask(() => {
      child.emit('spawn');
      if (script.hang === true) return;
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
      child.emit('exit', script.exit ?? null, script.signal ?? null);
      child.emit('close', script.exit ?? null, script.signal ?? null);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawn: spawnStub, calls };
};
const ask = (record: RecordedProcess, script: Scripted, platform: NodeJS.Platform = 'darwin') => {
  const ps = fakePs(script);
  return identify(record, { deadline: Date.now() + 5_000, platform, spawn: ps.spawn }).then(
    (identity: Identity) => ({ identity, calls: ps.calls }),
  );
};

describe('records refused before any query', () => {
  it('states the bounds it enforces', () => {
    expect(PID_BOUNDS).toEqual({ darwin: 99_999, linux: 4_194_303 });
  });

  it.each([
    ['pid 0', { pid: 0 }, 'darwin'],
    ['a negative pid', { pid: -1 }, 'darwin'],
    ['a fractional pid', { pid: 1.5 }, 'darwin'],
    ['NaN', { pid: Number.NaN }, 'darwin'],
    ['a pid past macOS PID_MAX', { pid: 100_000 }, 'darwin'],
    ['a pid past the Linux ceiling', { pid: 4_194_304 }, 'linux'],
    ['an unsupported platform', {}, 'win32'],
    ['a start time without a clock', { startedAt: 'Thu Sep 17 2026' }, 'darwin'],
    [
      'a start time on a day that does not exist',
      { startedAt: 'Thu Sep 31 02:33:35 2026' },
      'darwin',
    ],
    ['a start time with the wrong weekday', { startedAt: 'Fri Sep 17 02:33:35 2026' }, 'darwin'],
    ['an unpadded single-digit day', { startedAt: 'Mon Sep 7 02:33:35 2026' }, 'darwin'],
    ['an empty command', { command: '' }, 'darwin'],
    ['a command with a newline', { command: 'zsh\nbash' }, 'darwin'],
  ])('refuses %s, spawning nothing', async (_label, over, platform) => {
    const { identity, calls } = await ask(
      { ...MAC, ...over },
      { stdout: EVIDENCE.macosLive, exit: 0 },
      platform as NodeJS.Platform,
    );
    expect(identity.kind).toBe('invalid_record'); // never "absent", never "reused"
    expect(calls).toEqual([]);
  });

  it('accepts the space-padded single-digit day C lstart prints', () => {
    expect(validStartTime('Mon Sep  7 02:33:35 2026')).toBe(true);
  });
});

describe('the query itself', () => {
  it('asks for three metadata fields of one recorded pid, pinning format and timezone', async () => {
    const { calls } = await ask(MAC, { stdout: EVIDENCE.macosLive, exit: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['-o', 'pid=,lstart=,comm=', '-p', '59889']);
    // the two overrides only: the inherited environment is not printed here
    expect({ LC_ALL: calls[0]?.env.LC_ALL, TZ: calls[0]?.env.TZ }).toEqual({
      LC_ALL: 'C',
      TZ: 'UTC',
    });
  });
});

describe('what a live answer establishes', () => {
  it.each([
    ['macOS', MAC, EVIDENCE.macosLive, 'darwin'],
    ['Ubuntu', UBUNTU, EVIDENCE.ubuntuLive, 'linux'],
  ])('a matching %s start and command is a leftover', async (_os, record, stdout, platform) => {
    expect((await ask(record, { stdout, exit: 0 }, platform as NodeJS.Platform)).identity).toEqual({
      kind: 'leftover',
    });
  });

  it('compares against the record as it was when asked, not as the caller later changed it', async () => {
    const ps = fakePs({ stdout: EVIDENCE.macosLive, exit: 0 });
    const record = { ...MAC };
    const pending = identify(record, {
      deadline: Date.now() + 5_000,
      platform: 'darwin',
      spawn: ps.spawn,
    });
    record.startedAt = 'Wed Sep 16 19:29:48 2026'; // changed while the query is pending
    record.command = '/bin/bash';
    record.pid = 1;
    expect(await pending).toEqual({ kind: 'leftover' }); // still a blocking leftover
    expect(ps.calls[0]?.args).toEqual(['-o', 'pid=,lstart=,comm=', '-p', '59889']);
  });

  it('a different start time is a reused pid', async () => {
    const { identity } = await ask(
      { ...MAC, startedAt: 'Wed Sep 16 19:29:48 2026' },
      { stdout: EVIDENCE.macosLive, exit: 0 },
    );
    expect(identity).toEqual({ kind: 'reused', observed: MAC });
  });

  it('the same start time with a different command is unresolved, never reuse', async () => {
    const { identity } = await ask(
      { ...MAC, command: '/bin/bash' },
      { stdout: EVIDENCE.macosLive, exit: 0 },
    );
    expect(identity).toEqual({
      kind: 'unresolved',
      why: 'same start time but a different command',
    });
  });
});

describe('absence, and everything that is not absence', () => {
  it.each([
    ['macOS', MAC, 'darwin'],
    ['Ubuntu', UBUNTU, 'linux'],
  ])('exit 1 with no output at all is absent on %s', async (_os, record, platform) => {
    expect((await ask(record, { exit: 1 }, platform as NodeJS.Platform)).identity).toEqual({
      kind: 'absent',
    });
  });

  const U = (why: string): Identity => ({ kind: 'unresolved', why });
  it.each([
    ['exit 1 with macOS’s refusal', { exit: 1, stderr: EVIDENCE.macosTooLarge }, U('ps exited 1')],
    [
      'exit 1 with Ubuntu’s refusal',
      { exit: 1, stderr: EVIDENCE.ubuntuOutOfRange },
      U('ps exited 1'),
    ],
    ['exit 1 with stray stdout', { exit: 1, stdout: EVIDENCE.macosLive }, U('ps exited 1')],
    ['another exit code', { exit: 2 }, U('ps exited 2')],
    [
      'termination by a signal',
      { exit: null, signal: 'SIGKILL' },
      U('the query was terminated by a signal'),
    ],
    [
      'success that also wrote stderr',
      { exit: 0, stdout: EVIDENCE.macosLive, stderr: 'warning\n' },
      U('ps succeeded but wrote to stderr'),
    ],
    ['success with no output', { exit: 0 }, U('ps answered with a malformed line')],
    [
      'success with two lines',
      { exit: 0, stdout: EVIDENCE.macosLive + EVIDENCE.macosLive },
      U('ps did not answer with exactly one line'),
    ],
    [
      'success about another pid',
      { exit: 0, stdout: EVIDENCE.macosLive.replace('59889', '59890') },
      U('ps answered about another pid'),
    ],
    [
      'a mangled start time',
      { exit: 0, stdout: '59889 Thu Sep 17 02:33 2026 xx /bin/zsh\n' },
      U('ps answered with a malformed line'),
    ],
    [
      'a missing command',
      { exit: 0, stdout: '59889 Thu Sep 17 02:33:35 2026\n' },
      U('ps answered with a malformed line'),
    ],
    [
      'a failure to spawn',
      { throws: new Error('spawn ps ENOENT') },
      U('the query ended spawn_failed'),
    ],
  ])('%s is unresolved', async (_label, script, expected) => {
    expect((await ask(MAC, script as Scripted)).identity).toEqual(expected);
  });

  it('a query that never answers is unresolved at its deadline, never absent', async () => {
    const ps = fakePs({ hang: true });
    const began = Date.now();
    const identity = await identify(MAC, {
      deadline: began + 400,
      platform: 'darwin',
      spawn: ps.spawn,
    });
    expect(identity.kind).toBe('unresolved');
    expect(Date.now() - began).toBeLessThan(2_000);
  });
});
