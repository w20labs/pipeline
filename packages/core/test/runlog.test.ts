import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { strictAjv } from './support/ajv.js';
import { HandoffError } from '../src/runlog/handoff.js';
import { projectLog, readSnapshot } from '../src/runlog/snapshot.js';
import {
  openRunLog,
  readEvents,
  runPaths,
  RunLogError,
  type EventPayload,
  type PipelineEvent,
} from '../src/runlog/index.js';

const ajv = strictAjv();
const validateEvent = ajv.compile(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../spec/events.schema.json', import.meta.url)),
      'utf8',
    ),
  ) as object,
);
const valid = (event: PipelineEvent): true | string =>
  validateEvent(event) ? true : JSON.stringify(validateEvent.errors);

const base = () => mkdtempSync(join(tmpdir(), 'pipeline-runlog-'));
/**
 * Opening a run now takes the lock for its authoritative read, so an injected lock failure would
 * land there instead of on the append under test. These let the open-time cycle behave normally
 * and fail from the next call onward.
 */
const afterOpen = {
  remove: (message: string) => {
    let calls = 0;
    return (path: string): void => {
      calls += 1;
      if (calls > 1) throw new Error(message);
      rmSync(path, { force: true });
    };
  },
  stamp: (message: string) => {
    let calls = 0;
    return (fd: number): void => {
      calls += 1;
      if (calls > 1) throw new Error(message);
      writeSync(fd, `${process.pid}\n`);
    };
  },
};
const clock = () => {
  let t = Date.parse('2026-09-13T09:00:00Z');
  return () => new Date((t += 1000));
};
/**
 * One of every event type, and both `resumed` forms, in an order that also replays: a refused
 * max-round entry, its granted resume, then an ordinary escalation and a resume carrying no grant.
 */
const script: EventPayload[] = [
  { type: 'run_started', pipeline: 'feature-loop', task: 'Add rate limiting' },
  { type: 'node_started', node: 'implementer', round: 1 },
  { type: 'handoff_written', node: 'implementer', round: 1, path: 'handoffs/r1-implementer-1.txt' },
  { type: 'node_finished', node: 'implementer', round: 1, outcome: 'done' },
  { type: 'escalated', node: 'implementer', round: 2, reason: 'max_rounds' },
  { type: 'resumed', node: 'implementer', round: 2, extra_rounds: 2 },
  { type: 'node_started', node: 'implementer', round: 2 },
  { type: 'escalated', node: 'implementer', round: 2, reason: 'blocked' },
  { type: 'resumed', node: 'implementer', round: 2 },
  { type: 'run_finished', status: 'done' },
];

describe('the run folder', () => {
  it('lays out .pipeline/runs/<run-id>/ with handoffs, and creates it on open', () => {
    const dir = base();
    const paths = runPaths(dir, 'run-2');
    expect(paths.root).toBe(join(dir, '.pipeline', 'runs', 'run-2'));
    expect(paths.events).toBe(join(paths.root, 'events.jsonl'));
    expect(paths.state).toBe(join(paths.root, 'state.json'));
    expect(paths.handoffs).toBe(join(paths.root, 'handoffs'));
    expect(openRunLog(dir, 'run-2').paths.handoffs).toBe(paths.handoffs);
    expect(readEvents(paths.events)).toEqual({ events: [], complete: true }); // no log yet
  });

  it.each(['..', 'a/b', '/abs', '.hidden', '', 'a\\b'])(
    'refuses the run id %j rather than reaching outside the runs directory',
    (runId) => {
      expect(() => runPaths(base(), runId)).toThrow(/invalid run id/);
    },
  );

  it('preserves an existing run, and other runs, when reopened', () => {
    const dir = base();
    openRunLog(dir, 'run-1', { now: clock() }).append(script[0] as EventPayload);
    openRunLog(dir, 'other', { now: clock() }).append(script[0] as EventPayload);
    const reopened = openRunLog(dir, 'run-1', { now: clock() });
    expect(reopened.existing).toHaveLength(1); // not clobbered
    expect(reopened.nextSeq).toBe(2); // continues the sequence
    reopened.append(script[1] as EventPayload);
    expect(readEvents(runPaths(dir, 'run-1').events).events).toHaveLength(2);
    expect(readEvents(runPaths(dir, 'other').events).events).toHaveLength(1);
  });
});

describe('appending', () => {
  const dir = base();
  let written: PipelineEvent[] = [];
  beforeAll(() => {
    const log = openRunLog(dir, 'run-2', { now: clock() });
    written = script.map((payload) => log.append(payload));
  });

  it.each(script.map((p, i) => [p.type, i] as const))(
    'writes a schema-valid %s event',
    (_type, index) => {
      expect(valid(written[index] as PipelineEvent)).toBe(true);
    },
  );

  it('numbers events from one, strictly increasing with no gaps', () => {
    expect(written.map((e) => e.seq)).toEqual(script.map((_, i) => i + 1));
    expect(written.every((e) => e.run_id === 'run-2')).toBe(true);
  });

  it('appends one JSON object per line, and reads back exactly what was written', () => {
    const text = readFileSync(runPaths(dir, 'run-2').events, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(script.length);
    const read = readEvents(runPaths(dir, 'run-2').events);
    expect(read).toEqual({ events: written, complete: true });
  });

  it.each([
    [
      'fails before writing any bytes',
      () => {
        throw new Error('no bytes written');
      },
    ],
    [
      'fails after writing part of a line',
      (path: string, line: string) => {
        appendFileSync(path, line.slice(0, 12));
        throw new Error('torn write');
      },
    ],
  ] as [string, (path: string, line: string) => void][])(
    'invalidates the writer when an append %s',
    (_label, writeLine) => {
      const dir = base();
      const good = openRunLog(dir, 'run-3', { now: clock() });
      good.append(script[0] as EventPayload); // real history, which must survive
      const log = openRunLog(dir, 'run-3', { now: clock(), writeLine });
      expect(() => log.append(script[1] as EventPayload)).toThrow(RunLogError);
      expect(log.nextSeq).toBe(2); // the seq is reused, not skipped
      // and the handle is finished: it may not write again and bury the damage mid-file
      expect(() => log.append(script[1] as EventPayload)).toThrow(/writer|append failed/);
      expect(readEvents(log.paths.events).events[0]).toMatchObject({ seq: 1 }); // history intact
    },
  );

  it('leaves a torn prefix as a recoverable tail rather than burying it', () => {
    const dir = base();
    const first = openRunLog(dir, 'run-3', { now: clock() });
    first.append(script[0] as EventPayload);
    const torn = openRunLog(dir, 'run-3', {
      now: clock(),
      writeLine: (path, line) => {
        appendFileSync(path, line.slice(0, 12));
        throw new Error('torn write');
      },
    });
    expect(() => torn.append(script[1] as EventPayload)).toThrow();
    const read = readEvents(torn.paths.events);
    expect(read.complete).toBe(false);
    expect(read.events).toHaveLength(1); // the sound prefix
    expect(read.damagedTail).toMatchObject({ kind: 'unparsable', line: 2 }); // a torn JSON prefix
    expect(() => openRunLog(dir, 'run-3')).toThrow(RunLogError); // and reopening refuses it
  });

  it('refuses to append over a tail damaged by someone else', () => {
    const dir = base();
    const log = openRunLog(dir, 'run-3', { now: clock() });
    log.append(script[0] as EventPayload);
    // another process tore a line after our last append: the valid prefix still ends at our seq,
    // so only a damaged-tail check stops us writing past it and burying the damage
    appendFileSync(log.paths.events, '{"type":"nod');
    expect(readEvents(log.paths.events).events.map((e) => e.seq)).toEqual([1]);
    expect(() => log.append(script[1] as EventPayload)).toThrow(/damaged tail/);
    expect(readEvents(log.paths.events).damagedTail).toBeDefined(); // still there, unrepaired
  });

  it('refuses a second writer rather than duplicating a sequence number', () => {
    const dir = base();
    const a = openRunLog(dir, 'run-3', { now: clock() });
    const b = openRunLog(dir, 'run-3', { now: clock() }); // opened before either wrote
    a.append(script[0] as EventPayload);
    expect(() => b.append(script[1] as EventPayload)).toThrow(/expects 0/);
    expect(() => b.append(script[1] as EventPayload)).toThrow(RunLogError); // stays invalid
    a.append(script[1] as EventPayload);
    expect(readEvents(a.paths.events).events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('surfaces a read failure that is not a missing log', () => {
    const dir2 = base();
    mkdirSync(runPaths(dir2, 'run-5').root, { recursive: true });
    mkdirSync(runPaths(dir2, 'run-5').events);
    expect(() => readEvents(runPaths(dir2, 'run-5').events)).toThrow();
  });
});

describe('events the reader would reject', () => {
  it.each([
    ['a round below one', { type: 'node_started', node: 'implementer', round: 0 }],
    [
      'a handoff path escaping the run folder',
      { type: 'handoff_written', node: 'implementer', round: 1, path: '../outside.txt' },
    ],
    ['an unknown outcome', { type: 'node_finished', node: 'a', round: 1, outcome: 'maybe' }],
  ] as [string, EventPayload][])('refuses to write %s, which the schema rejects', (_label, bad) => {
    const dir = base();
    const log = openRunLog(dir, 'run-7', { now: clock() });
    log.append(script[0] as EventPayload);
    const before = readFileSync(log.paths.events, 'utf8');
    expect(() => log.append(bad)).toThrow(/refusing to append an invalid event/);
    expect(readFileSync(log.paths.events, 'utf8')).toBe(before); // bytes preserved
    expect(log.nextSeq).toBe(2); // sequence state preserved
    // a caller's bad event is not corruption, so the handle stays usable
    log.append(script[1] as EventPayload);
    expect(readEvents(log.paths.events).events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('events the history would reject', () => {
  const opened = (dir: string) => {
    const log = openRunLog(dir, 'run-14', { now: clock() });
    log.append(script[0] as EventPayload);
    log.append(script[1] as EventPayload); // node_started implementer round 1, left open
    return log;
  };

  it.each([
    ['a second entry over an unfinished one', { type: 'node_started', node: 'b', round: 1 }],
    [
      'a finish naming a different entry',
      { type: 'node_finished', node: 'b', round: 1, outcome: 'done' },
    ],
    [
      'a handoff naming a different entry',
      { type: 'handoff_written', node: 'b', round: 1, path: 'handoffs/r1-b-1.txt' },
    ],
    ['a resume with nothing to resume', { type: 'resumed', node: 'implementer', round: 1 }],
  ] as [string, EventPayload][])(
    'refuses %s, which the schema accepts but the history does not',
    (_label, candidate) => {
      const dir = base();
      const log = opened(dir);
      const before = readFileSync(log.paths.events, 'utf8');
      let thrown: RunLogError | undefined;
      try {
        log.append(candidate);
      } catch (error) {
        thrown = error as RunLogError;
      }
      expect(thrown?.fault).toBe('invalid_event');
      expect(thrown?.bytes).toBe('unchanged');
      expect(thrown?.message).toMatch(/unreplayable/);
      expect(readFileSync(log.paths.events, 'utf8')).toBe(before);
      expect(log.nextSeq).toBe(3);
      expect(log.fault).toBeUndefined(); // a bad candidate does not break the handle
      // and a valid event still lands, taking the seq the refusal did not consume
      expect(log.append(script[2] as EventPayload).seq).toBe(3);
    },
  );

  it('refuses an existing history that cannot be replayed, without touching the file', () => {
    const dir = base();
    const log = opened(dir);
    // a schema-valid but unprojectable line, written past this writer by something else
    const intruder = {
      type: 'node_started',
      node: 'b',
      round: 1,
      run_id: 'run-14',
      seq: 3,
      ts: '2026-09-13T09:00:09Z',
    };
    appendFileSync(log.paths.events, `${JSON.stringify(intruder)}\n`);
    const before = readFileSync(log.paths.events, 'utf8');
    const reopened = openRunLog(dir, 'run-14', { now: clock() });
    let thrown: RunLogError | undefined;
    try {
      reopened.append(script[2] as EventPayload);
    } catch (error) {
      thrown = error as RunLogError;
    }
    expect(thrown?.fault).toBe('corrupt'); // the history, not the candidate
    expect(thrown?.bytes).toBe('unchanged');
    expect(thrown?.message).toMatch(/existing log cannot be replayed/);
    expect(readFileSync(log.paths.events, 'utf8')).toBe(before);
    expect(reopened.fault?.fault).toBe('corrupt'); // and the handle is finished
  });
});

describe('ownership', () => {
  it('rechecks the owner before every append, not only on open', () => {
    const dir = base();
    const mine = openRunLog(dir, 'run-8', { now: clock() });
    mine.append(script[0] as EventPayload);
    // another run's log, valid and at the same seq, swapped in underneath the open handle
    const other = openRunLog(dir, 'other', { now: clock() });
    other.append(script[0] as EventPayload);
    const replacement = readFileSync(other.paths.events, 'utf8');
    writeFileSync(mine.paths.events, replacement, 'utf8');
    expect(() => mine.append(script[1] as EventPayload)).toThrow(
      /now belongs to run other, not run-8/,
    );
    expect(readFileSync(mine.paths.events, 'utf8')).toBe(replacement); // refusal preserves it
  });
});

describe('publishing the projection', () => {
  const run = (dir: string, options: Parameters<typeof openRunLog>[2] = {}) => {
    const log = openRunLog(dir, 'run-15', { now: clock(), ...options });
    return log;
  };

  it('republishes after every append, matching the log it just wrote', () => {
    const dir = base();
    const log = run(dir);
    for (const [i, payload] of script.entries()) {
      log.append(payload as EventPayload);
      // the published snapshot is the projection of the authoritative log, at every step
      expect(readSnapshot(log.paths)).toEqual(projectLog(log.paths));
      expect((readSnapshot(log.paths) as { lastSeq: number }).lastSeq).toBe(i + 1);
      expect(log.snapshotFault).toBeUndefined();
    }
    expect(readSnapshot(log.paths)).toMatchObject({ status: 'done', runId: 'run-15' });
  });

  it('publishes while the lock is still held', () => {
    const dir = base();
    let heldWhilePublishing: boolean | undefined;
    const log = run(dir, {
      snapshot: {
        write: (path, text) => {
          heldWhilePublishing = existsSync(`${runPaths(dir, 'run-15').events}.lock`);
          writeFileSync(path, text, 'utf8');
        },
      },
    });
    log.append(script[0] as EventPayload);
    expect(heldWhilePublishing).toBe(true); // read, replay and publish share one lock
  });

  it('returns the committed event when publication fails, and says so', () => {
    const dir = base();
    const log = run(dir, {
      snapshot: {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });
    const event = log.append(script[0] as EventPayload);
    expect(event.seq).toBe(1); // committed and returned
    expect(log.nextSeq).toBe(2); // the counter advanced with the bytes
    expect(readEvents(log.paths.events).events).toHaveLength(1);
    expect(log.snapshotFault).toMatchObject({ fault: 'snapshot_failed', bytes: 'committed' });
    expect(log.snapshotFault?.message).toMatch(/seq 1 was committed/);
    expect(log.fault).toBeUndefined(); // the handle is still usable
    expect(readSnapshot(log.paths)).toBeUndefined(); // nothing was published
  });

  it('clears the publication failure once a later append publishes', () => {
    const dir = base();
    let failing = true;
    const log = run(dir, {
      snapshot: {
        write: (path, text) => {
          if (failing) throw new Error('ENOSPC: no space left on device');
          writeFileSync(path, text, 'utf8');
        },
      },
    });
    log.append(script[0] as EventPayload);
    expect(log.snapshotFault).toBeDefined();
    failing = false;
    log.append(script[1] as EventPayload);
    expect(log.snapshotFault).toBeUndefined();
    expect(readSnapshot(log.paths)).toEqual(projectLog(log.paths));
  });

  it('keeps both the committed outcome and the stranded lock discoverable', () => {
    const dir = base();
    const log = run(dir, {
      snapshot: {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
      lock: {
        remove: afterOpen.remove('EACCES: permission denied'),
      },
    });
    const event = log.append(script[0] as EventPayload);
    expect(event.seq).toBe(1); // the committed outcome survives both failures
    expect(readEvents(log.paths.events).events).toHaveLength(1);
    expect(log.snapshotFault).toMatchObject({ fault: 'snapshot_failed', bytes: 'committed' });
    // and the lock nobody released is named, so it can be cleared
    expect(log.fault).toMatchObject({ fault: 'lock_residue', bytes: 'committed' });
    expect(log.fault?.message).toContain(`${log.paths.events}.lock`);
  });

  it.each([
    [
      'an event the history refuses',
      (log: ReturnType<typeof openRunLog>) =>
        log.append({ type: 'resumed', node: 'b', round: 1 } as EventPayload),
    ],
    [
      'an event the schema rejects',
      (log: ReturnType<typeof openRunLog>) =>
        log.append({ type: 'node_started', node: 'b', round: 0 } as EventPayload),
    ],
  ])('publishes nothing when %s is rejected', (_label, attempt) => {
    const dir = base();
    const log = run(dir);
    log.append(script[0] as EventPayload);
    const published = readFileSync(log.paths.state, 'utf8');
    expect(() => attempt(log)).toThrow(RunLogError);
    expect(readFileSync(log.paths.state, 'utf8')).toBe(published); // unchanged by a refusal
    expect(log.snapshotFault).toBeUndefined();
  });
});

describe('recording handoffs', () => {
  const started = (dir: string, options: Parameters<typeof openRunLog>[2] = {}) => {
    const log = openRunLog(dir, 'run-18', { now: clock(), ...options });
    log.append(script[0] as EventPayload); // run_started
    log.append(script[1] as EventPayload); // node_started implementer round 1
    return log;
  };
  const file = (log: ReturnType<typeof openRunLog>, path: string) =>
    join(realpathSync(log.paths.handoffs), path.replace('handoffs/', ''));

  it('writes the file and records it with the producing node and round', () => {
    const log = started(base());
    const event = log.writeHandoff('implementer', 1, 'the handoff body\n');
    expect(event).toMatchObject({
      type: 'handoff_written',
      node: 'implementer',
      round: 1,
      path: 'handoffs/r1-implementer-1.txt',
      seq: 3,
    });
    expect(readFileSync(file(log, event.path), 'utf8')).toBe('the handoff body\n');
    expect(readEvents(log.paths.events).events.at(-1)).toEqual(event);
    // and the republished snapshot carries it, in order
    expect(readSnapshot(log.paths)).toMatchObject({
      handoffs: [{ node: 'implementer', round: 1, path: 'handoffs/r1-implementer-1.txt' }],
    });
    expect(log.snapshotFault).toBeUndefined();
  });

  it('numbers by node and round, and keeps numbering across a reopen', () => {
    const dir = base();
    const log = started(dir);
    expect(log.writeHandoff('implementer', 1, 'a').path).toBe('handoffs/r1-implementer-1.txt');
    expect(log.writeHandoff('implementer', 1, 'b').path).toBe('handoffs/r1-implementer-2.txt');
    log.append({ type: 'node_finished', node: 'implementer', round: 1, outcome: 'done' });
    log.append({ type: 'node_started', node: 'reviewer', round: 2 });
    expect(log.writeHandoff('reviewer', 2, 'c').path).toBe('handoffs/r2-reviewer-1.txt');
    // a new handle derives the count from the log, not from anything it remembers
    const reopened = openRunLog(dir, 'run-18', { now: clock() });
    expect(reopened.writeHandoff('reviewer', 2, 'd').path).toBe('handoffs/r2-reviewer-2.txt');
    expect(
      readEvents(reopened.paths.events).events.filter((e) => e.type === 'handoff_written'),
    ).toHaveLength(4);
  });

  it('refuses an orphaned destination rather than writing over it', () => {
    const log = started(base());
    const orphan = file(log, 'handoffs/r1-implementer-1.txt');
    writeFileSync(orphan, 'left by an earlier attempt', 'utf8');
    expect(() => log.writeHandoff('implementer', 1, 'new')).toThrow(HandoffError);
    expect(readFileSync(orphan, 'utf8')).toBe('left by an earlier attempt');
    expect(readEvents(log.paths.events).events).toHaveLength(2); // nothing recorded
    expect(log.fault).toBeUndefined(); // and the handle survives a caller-level refusal
  });

  it.each([
    ['clears its partial file', {}, false],
    [
      'reports residue when clearing fails',
      {
        remove: () => {
          throw new Error('EACCES: permission denied');
        },
      },
      true,
    ],
  ])('records nothing when the file cannot be written, and %s', (_label, extra, residue) => {
    const log = started(base(), {
      handoff: {
        write: () => {
          throw new Error('ENOSPC: no space left on device');
        },
        ...extra,
      },
    });
    let thrown: HandoffError | undefined;
    try {
      log.writeHandoff('implementer', 1, 'x');
    } catch (error) {
      thrown = error as HandoffError;
    }
    expect(thrown?.fault).toBe('write_failed');
    expect(thrown?.residue).toBe(residue ? file(log, 'handoffs/r1-implementer-1.txt') : undefined);
    expect(existsSync(file(log, 'handoffs/r1-implementer-1.txt'))).toBe(residue);
    expect(readEvents(log.paths.events).events).toHaveLength(2); // no event, log unchanged
    expect(log.nextSeq).toBe(3);
  });

  it('creates no file when the handoff is refused before anything is written', () => {
    const dir = base();
    const log = started(dir);
    // a handoff for an entry that is not open: refused by the history, and nothing is left behind
    let thrown: RunLogError | undefined;
    try {
      log.writeHandoff('reviewer', 4, 'never written');
    } catch (error) {
      thrown = error as RunLogError;
    }
    expect(thrown?.fault).toBe('invalid_event');
    expect(thrown?.bytes).toBe('unchanged');
    expect(thrown?.handoff).toBeUndefined(); // there is no orphan to name
    expect(existsSync(file(log, 'handoffs/r4-reviewer-1.txt'))).toBe(false);
    expect(readEvents(log.paths.events).events).toHaveLength(2);
    // and the refusal costs the node nothing: once the entry is legitimately open, it works
    log.append({ type: 'node_finished', node: 'implementer', round: 1, outcome: 'done' });
    log.append({ type: 'node_started', node: 'reviewer', round: 4 });
    expect(log.writeHandoff('reviewer', 4, 'now valid').path).toBe('handoffs/r4-reviewer-1.txt');
  });

  it('keeps the file and names it when the event write fails outright', () => {
    const dir = base();
    let appends = 0;
    const log = started(dir, {
      // the two setup appends land; the handoff's own event write fails before emitting anything
      writeLine: (path, line) => {
        appends += 1;
        if (appends <= 2) return void appendFileSync(path, line);
        throw new Error('EIO: input/output error');
      },
    });
    let thrown: RunLogError | undefined;
    try {
      log.writeHandoff('implementer', 1, 'body');
    } catch (error) {
      thrown = error as RunLogError;
    }
    // the writer cannot know how far a failed write got, so it never claims the log is unchanged
    expect(thrown?.fault).toBe('writer_invalid');
    expect(thrown?.bytes).toBe('uncertain');
    expect(thrown?.handoff).toBe('handoffs/r1-implementer-1.txt');
    expect(readFileSync(file(log, 'handoffs/r1-implementer-1.txt'), 'utf8')).toBe('body');
    expect(log.nextSeq).toBe(3); // no seq was consumed
    expect(log.fault?.fault).toBe('writer_invalid'); // and the handle is finished
    // reopening finds the orphan and refuses to write over it
    const reopened = openRunLog(dir, 'run-18', { now: clock() });
    expect(() => reopened.writeHandoff('implementer', 1, 'again')).toThrow(HandoffError);
    expect(readFileSync(file(log, 'handoffs/r1-implementer-1.txt'), 'utf8')).toBe('body');
  });

  it('keeps the file and names it when the append tears a partial line', () => {
    let appends = 0;
    const log = started(base(), {
      // the two setup appends land normally; only the handoff's own append tears
      writeLine: (path, line) => {
        appends += 1;
        if (appends <= 2) return void appendFileSync(path, line);
        appendFileSync(path, line.slice(0, 12));
        throw new Error('torn write');
      },
    });
    let thrown: RunLogError | undefined;
    try {
      log.writeHandoff('implementer', 1, 'body');
    } catch (error) {
      thrown = error as RunLogError;
    }
    expect(thrown?.fault).toBe('writer_invalid');
    expect(thrown?.bytes).toBe('uncertain'); // the log's tail is torn, not unchanged
    expect(thrown?.handoff).toBe('handoffs/r1-implementer-1.txt');
    expect(readFileSync(file(log, 'handoffs/r1-implementer-1.txt'), 'utf8')).toBe('body');
    expect(readEvents(log.paths.events).damagedTail).toBeDefined();
  });

  it('returns the committed handoff when its projection cannot be published', () => {
    const dir = base();
    let failing = false;
    const log = started(dir, {
      snapshot: {
        write: (path, text) => {
          if (failing) throw new Error('ENOSPC: no space left on device');
          writeFileSync(path, text, 'utf8');
        },
      },
    });
    failing = true;
    const event = log.writeHandoff('implementer', 1, 'body');
    expect(event.seq).toBe(3); // committed and returned
    expect(readEvents(log.paths.events).events).toHaveLength(3);
    expect(log.snapshotFault).toMatchObject({ fault: 'snapshot_failed', bytes: 'committed' });
  });

  it('holds the lock from allocation through the file write', () => {
    const dir = base();
    let heldWhileWriting: boolean | undefined;
    const log = started(dir, {
      handoff: {
        write: (fd, buffer, offset) => {
          heldWhileWriting = existsSync(`${runPaths(dir, 'run-18').events}.lock`);
          return writeSync(fd, buffer, offset);
        },
      },
    });
    log.writeHandoff('implementer', 1, 'body');
    expect(heldWhileWriting).toBe(true);
  });
});

describe('rebuilding the projection on open', () => {
  const withEvents = (howMany: number) => {
    const dir = base();
    const log = openRunLog(dir, 'run-16', { now: clock() });
    for (const payload of script.slice(0, howMany)) log.append(payload as EventPayload);
    return { dir, log };
  };
  const reopen = (dir: string, options: Parameters<typeof openRunLog>[2] = {}) =>
    openRunLog(dir, 'run-16', { now: clock(), ...options });

  it.each([
    ['missing', (paths: { state: string }) => rmSync(paths.state)],
    ['unparseable', (paths: { state: string }) => writeFileSync(paths.state, '{ not json', 'utf8')],
    [
      'wrong in every field but lastSeq',
      (paths: { state: string }) =>
        writeFileSync(
          paths.state,
          // the right sequence and nothing else right: a lastSeq comparison would accept this
          JSON.stringify({
            lastSeq: 3,
            eventCount: 3,
            extraRoundsGranted: 9,
            handoffs: [],
            runId: 'someone-else',
            task: 'a different task',
            status: 'done',
          }),
          'utf8',
        ),
    ],
    [
      'a projection of an earlier round',
      (paths: { state: string }) =>
        writeFileSync(paths.state, JSON.stringify({ lastSeq: 1, eventCount: 1 }), 'utf8'),
    ],
  ])('republishes a snapshot that is %s', (_label, damage) => {
    const { dir, log } = withEvents(3);
    damage(log.paths);
    const reopened = reopen(dir);
    expect(readSnapshot(reopened.paths)).toEqual(projectLog(reopened.paths));
    expect(readSnapshot(reopened.paths)).toMatchObject({ lastSeq: 3, runId: 'run-16' });
    expect(reopened.snapshotFault).toBeUndefined();
  });

  it('draws existing, nextSeq and the snapshot from the same locked read', () => {
    const { dir, log } = withEvents(1);
    const extra = {
      type: 'node_started',
      node: 'implementer',
      round: 1,
      run_id: 'run-16',
      seq: 2,
      ts: '2026-09-13T09:00:09Z',
    };
    // the log grows after the lock is taken but before the read: a handle that had read earlier
    // would publish the state it saw before this landed
    const reopened = reopen(dir, {
      lock: {
        stamp: (fd) => {
          writeSync(fd, `${process.pid}\n`);
          appendFileSync(log.paths.events, `${JSON.stringify(extra)}\n`);
        },
      },
    });
    expect(reopened.existing).toHaveLength(2);
    expect(reopened.nextSeq).toBe(3);
    expect(readSnapshot(reopened.paths)).toMatchObject({ lastSeq: 2 });
  });

  it('leaves a fresh run alone, publishing nothing before its first event', () => {
    const dir = base();
    const log = openRunLog(dir, 'run-17', { now: clock() });
    expect(existsSync(log.paths.state)).toBe(false);
    expect(log.snapshotFault).toBeUndefined();
  });

  it.each([
    [
      'a log that cannot be replayed',
      (paths: { events: string }) =>
        appendFileSync(
          paths.events,
          `${JSON.stringify({
            type: 'node_started',
            node: 'b',
            round: 1,
            run_id: 'run-16',
            seq: 4,
            ts: '2026-09-13T09:00:09Z',
          })}\n`,
        ),
      {},
    ],
    [
      'a snapshot that cannot be written',
      () => undefined,
      {
        snapshot: {
          write: () => {
            throw new Error('ENOSPC: no space left on device');
          },
        },
      },
    ],
  ])('reports %s without touching the log or its snapshot', (_label, damage, options) => {
    const { dir, log } = withEvents(3);
    const snapshot = readFileSync(log.paths.state, 'utf8');
    damage(log.paths);
    const events = readFileSync(log.paths.events, 'utf8');
    const reopened = reopen(dir, options);
    expect(reopened.snapshotFault).toMatchObject({ fault: 'rebuild_failed', bytes: 'unchanged' });
    expect(readFileSync(reopened.paths.state, 'utf8')).toBe(snapshot); // the old one survives
    expect(readFileSync(reopened.paths.events, 'utf8')).toBe(events); // nothing was appended
  });

  it('reports a lock it could not release after rebuilding', () => {
    const { dir, log } = withEvents(2);
    const reopened = reopen(dir, {
      lock: {
        remove: () => {
          throw new Error('EACCES: permission denied');
        },
      },
    });
    expect(readSnapshot(reopened.paths)).toEqual(projectLog(log.paths)); // the rebuild happened
    expect(reopened.fault).toMatchObject({ fault: 'lock_residue', bytes: 'unchanged' });
    expect(reopened.fault?.message).toContain(`${log.paths.events}.lock`);
  });

  it('names a stranded lock alongside a refusal to open', () => {
    const { dir, log } = withEvents(2);
    appendFileSync(log.paths.events, '{"torn');
    let thrown: RunLogError | undefined;
    try {
      reopen(dir, {
        lock: {
          remove: () => {
            throw new Error('EACCES: permission denied');
          },
        },
      });
    } catch (error) {
      thrown = error as RunLogError;
    }
    expect(thrown?.fault).toBe('damaged_tail'); // the refusal is still the outcome
    expect(thrown?.message).toMatch(/could not be released .* and remains/); // and the lock is named
  });
});

describe('a damaged tail', () => {
  const withTail = (tail: string) => {
    const dir = base();
    const log = openRunLog(dir, 'run-4', { now: clock() });
    log.append(script[0] as EventPayload);
    log.append(script[1] as EventPayload);
    const path = log.paths.events;
    writeFileSync(path, readFileSync(path, 'utf8') + tail, 'utf8');
    return { dir, path };
  };

  it('reports an unparsable final line and returns the valid prefix, not a clean log', () => {
    const { path } = withTail('{"type":"node_fini\n');
    const read = readEvents(path);
    expect(read.complete).toBe(false); // never presented as complete
    expect(read.events).toHaveLength(2);
    expect(read.damagedTail).toMatchObject({ kind: 'unparsable', line: 3 });
  });

  it('reports a valid record with no closing newline, and preserves the file', () => {
    const { path } = withTail('{"type":"run_finished","run_id":"run-4","seq":3,"ts":"x"}');
    const before = readFileSync(path, 'utf8');
    const read = readEvents(path);
    expect(read.complete).toBe(false);
    expect(read.events).toHaveLength(2); // the unterminated record is not an event
    expect(read.damagedTail).toMatchObject({ kind: 'unterminated', line: 3 });
    expect(read.damagedTail?.text).toContain('run_finished');
    expect(readFileSync(path, 'utf8')).toBe(before); // no truncation, no repair
  });

  it.each([
    ['unparsable', '{"type":"node_fini\n'],
    ['unterminated', '{"type":"run_finished","run_id":"run-4","seq":3,"ts":"x"}'],
  ])('refuses to reopen an appender over an %s tail', (_kind, tail) => {
    const { dir, path } = withTail(tail);
    const before = readFileSync(path, 'utf8');
    expect(() => openRunLog(dir, 'run-4')).toThrow(RunLogError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each([
    ['a record that is not an object', 'null'],
    [
      'an event with a mistyped field',
      '{"type":"run_started","run_id":"run-4","seq":3,"ts":"2026-09-13T09:00:00Z","pipeline":"p","task":"t","extra":1}',
    ],
    [
      'a field of the wrong type',
      '{"type":"node_started","run_id":"run-4","seq":"3","ts":"2026-09-13T09:00:00Z","node":"a","round":1}',
    ],
  ])('refuses %s, even as the last line, without touching the file', (_label, record) => {
    const { path } = withTail(`${record}\n`);
    const before = readFileSync(path, 'utf8');
    expect(() => readEvents(path)).toThrow(/not a valid event/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses a sequence gap and a foreign run id', () => {
    const gap = withTail(
      '{"type":"node_finished","run_id":"run-4","seq":9,"ts":"2026-09-13T09:00:00Z","node":"a","round":1,"outcome":"done"}\n',
    );
    expect(() => readEvents(gap.path)).toThrow(/breaks the sequence at 3/);
    const foreign = withTail(
      '{"type":"node_started","run_id":"other","seq":3,"ts":"2026-09-13T09:00:00Z","node":"a","round":1}\n',
    );
    expect(() => readEvents(foreign.path)).toThrow(/does not match run-4/);
  });

  it('refuses to append to a log belonging to another run', () => {
    const dir = base();
    openRunLog(dir, 'run-4', { now: clock() }).append(script[0] as EventPayload);
    const stolen = runPaths(dir, 'stolen');
    mkdirSync(stolen.handoffs, { recursive: true });
    writeFileSync(stolen.events, readFileSync(runPaths(dir, 'run-4').events, 'utf8'), 'utf8');
    expect(() => openRunLog(dir, 'stolen')).toThrow(/belongs to run run-4, not stolen/);
  });

  it('treats corruption before the last line as a hard error', () => {
    const { path } = withTail('');
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, `${lines[0]}\nnot json\n${lines[1]}\n`, 'utf8');
    expect(() => readEvents(path)).toThrow(/not the last line/);
    expect(() => readEvents(path)).toThrow(RunLogError);
  });

  it('promises unchanged bytes only when that is true', () => {
    const dir = base();
    const log = openRunLog(dir, 'run-9', {
      now: clock(),
      writeLine: (path, line) => {
        appendFileSync(path, line.slice(0, 12));
        throw new Error('torn write');
      },
    });
    let thrown: RunLogError | undefined;
    try {
      log.append(script[0] as EventPayload);
    } catch (error) {
      thrown = error as RunLogError;
    }
    expect(thrown?.bytes).toBe('uncertain');
    expect(thrown?.bytesUnchanged).toBe(false);
    expect(thrown?.message).not.toContain('left untouched');
    expect(thrown?.message).toMatch(/part of a line may have been written/i);
    expect(readFileSync(log.paths.events, 'utf8')).toHaveLength(12); // the claim is accurate
    // faults raised before any write still give the strong assurance
    const clean = openRunLog(base(), 'run-9', { now: clock() });
    try {
      clean.append({ type: 'node_started', node: 'a', round: 0 });
    } catch (error) {
      expect((error as RunLogError).bytes).toBe('unchanged');
      expect((error as RunLogError).message).toContain('left untouched');
    }
  });

  it('keeps the append outcome when releasing the lock fails', () => {
    const dir = base();
    const stuck = {
      remove: afterOpen.remove('EACCES: cannot unlink'),
    };
    const log = openRunLog(dir, 'run-10', { now: clock(), lock: stuck });
    // the event commits; a cleanup failure afterwards is not a rejected append
    const event = log.append(script[0] as EventPayload);
    expect(event.seq).toBe(1);
    expect(log.nextSeq).toBe(2); // the counter advanced with the bytes
    expect(readEvents(log.paths.events).events).toHaveLength(1);
    // and the cleanup failure is readable without appending again, saying plainly that the event
    // was written: the bytes did change, and the log is intact rather than possibly torn
    expect(log.fault).toMatchObject({ fault: 'lock_residue', bytes: 'committed' });
    expect(log.fault?.bytesUnchanged).toBe(false);
    expect(log.fault?.message).toMatch(/seq 1 was committed/);
    expect(log.fault?.message).not.toContain('left untouched');
    expect(log.fault?.message).not.toMatch(/part of a line/i);
  });

  it('keeps a partial-write failure visible when releasing the lock also fails', () => {
    const dir = base();
    const log = openRunLog(dir, 'run-11', {
      now: clock(),
      lock: {
        remove: afterOpen.remove('EACCES: cannot unlink'),
      },
      writeLine: (path, line) => {
        appendFileSync(path, line.slice(0, 12));
        throw new Error('torn write');
      },
    });
    let thrown: RunLogError | undefined;
    try {
      log.append(script[0] as EventPayload);
    } catch (error) {
      thrown = error as RunLogError;
    }
    // the write failure is the outcome, not the cleanup error that followed it
    expect(thrown?.fault).toBe('writer_invalid');
    expect(thrown?.bytesUnchanged).toBe(false);
    expect(log.nextSeq).toBe(1); // nothing committed
  });

  it('keeps the claim failure when removing the unclaimed lock also fails', () => {
    const dir = base();
    const log = openRunLog(dir, 'run-13', {
      now: clock(),
      lock: {
        stamp: afterOpen.stamp('ENOSPC: no space left on device'),
        remove: afterOpen.remove('EACCES: permission denied'),
      },
    });
    let thrown: RunLogError | undefined;
    try {
      log.append(script[0] as EventPayload);
    } catch (error) {
      thrown = error as RunLogError;
    }
    // the claim failure is the outcome; the cleanup failure is reported alongside it
    expect(thrown?.fault).toBe('lock_unavailable');
    expect(thrown?.bytes).toBe('unchanged');
    expect(thrown?.message).toMatch(/could not claim/);
    expect(thrown?.message).toMatch(/ENOSPC/); // the original cause survives
    expect(thrown?.message).toMatch(/EACCES/); // and so does the cleanup failure
    expect(thrown?.message).toMatch(/remains/); // naming what an operator must clear
  });

  it('leaves no lock behind when claiming it fails, and stays usable afterwards', () => {
    const dir = base();
    const failing = openRunLog(dir, 'run-12', {
      now: clock(),
      lock: {
        stamp: afterOpen.stamp('ENOSPC: no space left on device'),
      },
    });
    expect(() => failing.append(script[0] as EventPayload)).toThrow(/could not claim/);
    expect(() => failing.append(script[0] as EventPayload)).toThrow(/ENOSPC/); // cause retained
    expect(existsSync(`${failing.paths.events}.lock`)).toBe(false); // no leaked ownership
    // a later writer is not locked out by a lock that was never claimed
    const next = openRunLog(dir, 'run-12', { now: clock() });
    expect(next.append(script[0] as EventPayload).seq).toBe(1);
  });

  it('reports where the damage starts, in bytes', () => {
    const { path } = withTail('oops');
    const read = readEvents(path);
    const prefix = readFileSync(path, 'utf8').slice(0, read.damagedTail?.byteOffset);
    expect(prefix.endsWith('\n')).toBe(true);
    expect(prefix.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
