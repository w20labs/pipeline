import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  type LockFs,
  nodeLockFs,
  promptGate,
  recordThenDispatch,
  releaseLock,
  withCleanup,
} from '../src/run-control.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const lockPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-lock-'));
  dirs.push(dir);
  return join(dir, 'run.lock');
};
const OWNER = { runId: 'run-1', pid: 4242, startedAt: 1_000 };
const throws = (message: string) => (): never => {
  throw new Error(message);
};
const fingerprint = (path: string) => ({
  bytes: readFileSync(path, 'utf8'),
  ino: statSync(path).ino,
});

describe('the run lock', () => {
  it('is taken exclusively with an owner token, and released by the invocation that took it', () => {
    const path = lockPath();
    const taken = acquireLock(path, OWNER);
    if (!taken.ok) throw new Error('setup');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...OWNER, token: taken.lock.token });
    expect(releaseLock(taken.lock)).toBeUndefined();
    expect(() => statSync(path)).toThrow();
  });

  it('refuses when held, and a failed attempt leaves the holder’s lock exactly as it was', () => {
    const path = lockPath();
    acquireLock(path, OWNER);
    const before = fingerprint(path);
    expect(acquireLock(path, { ...OWNER, runId: 'run-2' })).toEqual({
      ok: false,
      why: 'another run holds the lock',
    });
    expect(fingerprint(path)).toEqual(before);
  });

  it('refuses to release a lock that was replaced, leaving the replacement untouched', () => {
    const path = lockPath();
    const taken = acquireLock(path, OWNER);
    if (!taken.ok) throw new Error('setup');
    writeFileSync(path, JSON.stringify({ ...OWNER, runId: 'run-2', token: 'someone-else' }));
    const replaced = fingerprint(path);
    expect(releaseLock(taken.lock)).toBe('the lock was replaced; it was left as found');
    expect(fingerprint(path)).toEqual(replaced);
  });
});

describe('writing the lock', () => {
  const exists = (path: string) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  };

  it('writes the whole record across short writes, and the lock is usable', () => {
    const path = lockPath();
    const trickle: LockFs = {
      ...nodeLockFs,
      write: (fd, buffer, offset, length) =>
        nodeLockFs.write(fd, buffer, offset, Math.min(3, length)),
    };
    const taken = acquireLock(path, OWNER, trickle);
    if (!taken.ok) throw new Error('setup');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...OWNER, token: taken.lock.token });
    expect(releaseLock(taken.lock)).toBeUndefined();
  });

  it.each([
    ['a write that makes no progress', { write: () => 0 }, 'Error: the write made no progress'],
    [
      'a write that throws',
      {
        write: throws('EIO'),
      },
      'Error: EIO',
    ],
  ])('removes its own partial lock after %s, having closed it', (_label, fault, cause) => {
    const path = lockPath();
    let closes = 0;
    const fs: LockFs = {
      ...nodeLockFs,
      ...fault,
      close: (fd) => {
        closes += 1;
        nodeLockFs.close(fd);
      },
    };
    expect(acquireLock(path, OWNER, fs)).toEqual({
      ok: false,
      why: `the lock could not be written: ${cause}`,
      cleanupDiagnostics: [],
    });
    expect(closes).toBe(1);
    expect(exists(path)).toBe(false);
  });

  it('treats a failed close after a full write as a failure, removing the file', () => {
    const path = lockPath();
    const fs: LockFs = {
      ...nodeLockFs,
      close: (fd) => {
        nodeLockFs.close(fd); // the real descriptor is released before the fault
        throw new Error('EBADF');
      },
    };
    expect(acquireLock(path, OWNER, fs)).toEqual({
      ok: false,
      why: 'the lock could not be closed: Error: EBADF',
      cleanupDiagnostics: [],
    });
    expect(exists(path)).toBe(false);
  });

  it('reports a stranded lock when removal fails, keeping every failure', () => {
    const path = lockPath();
    const fs: LockFs = {
      ...nodeLockFs,
      write: throws('EIO'),
      close: (fd) => {
        nodeLockFs.close(fd);
        throw new Error('EBADF');
      },
      unlink: throws('EPERM'),
    };
    expect(acquireLock(path, OWNER, fs)).toEqual({
      ok: false,
      why: 'the lock could not be written: Error: EIO',
      cleanupDiagnostics: [
        'the lock could not be closed: Error: EBADF',
        'the partial lock could not be removed: Error: EPERM',
      ],
      strandedLock: path,
    });
    expect(exists(path)).toBe(true); // stranded, as reported
  });

  it('never removes anything after a refused exclusive open', () => {
    const path = lockPath();
    acquireLock(path, OWNER);
    let unlinks = 0;
    const counting: LockFs = {
      ...nodeLockFs,
      unlink: (p) => {
        unlinks += 1;
        nodeLockFs.unlink(p);
      },
    };
    expect(acquireLock(path, { ...OWNER, runId: 'run-2' }, counting)).toMatchObject({ ok: false });
    expect(unlinks).toBe(0);
  });
});

describe('cleanup around a run', () => {
  it('releases the lock after a failed run, keeping the run’s own failure', async () => {
    const path = lockPath();
    const taken = acquireLock(path, OWNER);
    if (!taken.ok) throw new Error('setup');
    const result = await withCleanup(
      () => Promise.reject(new Error('the run failed')),
      [() => releaseLock(taken.lock)],
    );
    expect(result).toEqual({ ok: false, failure: 'the run failed', cleanupDiagnostics: [] });
    expect(() => statSync(path)).toThrow();
  });

  it('keeps both the run’s failure and a failed release, neither hiding the other', async () => {
    const path = lockPath();
    const taken = acquireLock(path, OWNER);
    if (!taken.ok) throw new Error('setup');
    const stuck: LockFs = {
      ...nodeLockFs,
      unlink: throws('EPERM'),
    };
    const result = await withCleanup(
      () => Promise.reject(new Error('the run failed')),
      [
        () => {
          throw new Error('an earlier cleanup broke'); // and the release after it still runs
        },
        () => releaseLock(taken.lock, stuck),
      ],
    );
    expect(result).toEqual({
      ok: false,
      failure: 'the run failed',
      cleanupDiagnostics: [
        'cleanup threw: Error: an earlier cleanup broke',
        'the lock could not be released: Error: EPERM',
      ],
    });
  });
});

describe('the launch record', () => {
  it('is written before the launch, and the launch is exactly what was written', async () => {
    const order: string[] = [];
    let recorded: readonly string[] = [];
    const argv = ['claude', '--session-id', 'U', '--model', 'sonnet'];
    const result = await recordThenDispatch(
      argv,
      async (snapshot) => {
        argv.push('--mutated-after-the-call'); // the caller changes its array mid-write
        argv[2] = 'OTHER';
        await Promise.resolve();
        recorded = [...snapshot];
        order.push('persist');
      },
      (snapshot) => {
        order.push('dispatch');
        return Promise.resolve([...snapshot]);
      },
    );
    expect(order).toEqual(['persist', 'dispatch']);
    expect(recorded).toEqual(['claude', '--session-id', 'U', '--model', 'sonnet']);
    expect(result).toEqual({ ok: true, argv: recorded, dispatched: recorded });
  });

  it('launches nothing when the record cannot be written', async () => {
    let dispatches = 0;
    const result = await recordThenDispatch(
      ['claude'],
      () => Promise.reject(new Error('ENOSPC')),
      () => Promise.resolve((dispatches += 1)),
    );
    expect(result).toEqual({
      ok: false,
      why: 'the launch record could not be written; nothing was launched: Error: ENOSPC',
    });
    expect(dispatches).toBe(0);
  });
});

describe('the prompt gate', () => {
  const TARGET = { runId: 'run-1', pane: 'w1:p1', sessionId: 'U' };
  const CONFIRMED = { ...TARGET, confirmedAt: 5 };
  const ALLOWED = { runId: 'run-1' };
  const counting = () => {
    let sends = 0;
    return { submit: () => Promise.resolve((sends += 1)), sends: () => sends };
  };

  it('sends once when confirmation and authorization both match this launch', async () => {
    const c = counting();
    const result = await promptGate(TARGET)(CONFIRMED, ALLOWED, c.submit);
    expect(result).toEqual({ kind: 'submitted', outcome: 1 });
    expect(Object.keys(result)).not.toContain('ready'); // a sent prompt is not a readiness claim
  });

  it.each([
    ['no confirmation', undefined, ALLOWED, 'no operator confirmation'],
    ['no authorization', CONFIRMED, undefined, 'no authorization to prompt'],
    [
      'another run',
      { ...CONFIRMED, runId: 'run-2' },
      ALLOWED,
      'the confirmation is for another runId',
    ],
    [
      'another pane',
      { ...CONFIRMED, pane: 'w1:p9' },
      ALLOWED,
      'the confirmation is for another pane',
    ],
    [
      'another session',
      { ...CONFIRMED, sessionId: 'V' },
      ALLOWED,
      'the confirmation is for another sessionId',
    ],
    [
      'authorization for another run',
      CONFIRMED,
      { runId: 'run-2' },
      'the authorization is for another run',
    ],
  ])('sends nothing with %s', async (_label, confirmation, authorization, why) => {
    const c = counting();
    expect(await promptGate(TARGET)(confirmation, authorization, c.submit)).toEqual({
      kind: 'refused',
      why,
    });
    expect(c.sends()).toBe(0);
  });

  it('keeps the launch it was built for, whatever later happens to the caller’s object', async () => {
    const target = { ...TARGET };
    const gate = promptGate(target);
    target.pane = 'w1:p9'; // changed through the caller's alias
    target.sessionId = 'V';
    const c = counting();
    const replacement = { runId: 'run-1', pane: 'w1:p9', sessionId: 'V', confirmedAt: 5 };
    expect(await gate(replacement, ALLOWED, c.submit)).toEqual({
      kind: 'refused',
      why: 'the confirmation is for another pane',
    });
    expect(await gate(CONFIRMED, ALLOWED, c.submit)).toEqual({ kind: 'submitted', outcome: 1 });
    expect(c.sends()).toBe(1);
  });

  it('never sends twice, whether attempts follow one another or run at once', async () => {
    const gate = promptGate(TARGET);
    const c = counting();
    const results = await Promise.all([
      gate(CONFIRMED, ALLOWED, c.submit),
      gate(CONFIRMED, ALLOWED, c.submit),
    ]);
    expect(await gate(CONFIRMED, ALLOWED, c.submit)).toMatchObject({ kind: 'refused' });
    expect(c.sends()).toBe(1);
    expect(results.map((r) => r.kind).sort()).toEqual(['refused', 'submitted']);
  });

  it('does not hand the authorization back after a submission that failed', async () => {
    const gate = promptGate(TARGET);
    let attempts = 0;
    const failing = () => {
      attempts += 1;
      return Promise.reject(new Error('delivery unknown'));
    };
    expect(await gate(CONFIRMED, ALLOWED, failing)).toEqual({
      kind: 'submission_failed',
      why: 'Error: delivery unknown',
    });
    expect(await gate(CONFIRMED, ALLOWED, failing)).toEqual({
      kind: 'refused',
      why: 'this run’s authorization has already been used',
    });
    expect(attempts).toBe(1);
  });
});
