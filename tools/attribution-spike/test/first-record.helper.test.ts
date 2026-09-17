import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FIRST_RECORD_LIMIT, HELPER, readFirstRecord } from '../src/first-record.js';

/**
 * The real helper against a real filesystem, on whatever platform the tests run on — macOS here,
 * Ubuntu in CI — so the descriptor-relative capabilities it needs are exercised, not assumed.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tree = () => {
  const base = mkdtempSync(join(tmpdir(), 'pipeline-first-record-'));
  made.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'projects', 'slug'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'projects', 'slug', 'f.jsonl'), 'inside\n');
  writeFileSync(join(outside, 'f.jsonl'), 'OUTSIDE\n');
  return { base, root, outside, slug: join(root, 'projects', 'slug') };
};
const PARTS = ['projects', 'slug', 'f.jsonl'];
const read = (root: string, parts = PARTS, barrier?: string) =>
  readFirstRecord(root, parts, {
    deadline: Date.now() + 10_000,
    ...(barrier === undefined ? {} : { barrier }),
  });

describe('the helper on a real filesystem', () => {
  it('has the Python it needs on this platform', () => {
    const version = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
    expect(version).toMatch(/^Python 3\./);
  });

  it('reads the first record of a real file', async () => {
    const t = tree();
    expect(await read(t.root)).toEqual({ ok: true, bytes: Buffer.from('inside\n'), newline: true });
  });

  it.each([
    [
      'the project directory',
      (t: ReturnType<typeof tree>) => {
        renameSync(t.slug, `${t.slug}.orig`);
        symlinkSync(t.outside, t.slug);
      },
      'component',
    ],
    [
      'the transcript itself',
      (t: ReturnType<typeof tree>) => {
        rmSync(join(t.slug, 'f.jsonl'));
        symlinkSync(join(t.outside, 'f.jsonl'), join(t.slug, 'f.jsonl'));
      },
      'file',
    ],
  ])('refuses %s as a symlink, returning no outside bytes', async (_label, link, step) => {
    const t = tree();
    link(t);
    const result = await read(t.root);
    expect(result.ok).toBe(false);
    expect((result as { why: string }).why).toMatch(new RegExp(`^the helper stopped at ${step}: `));
  });

  it('refuses a FIFO without blocking on it', async () => {
    const t = tree();
    rmSync(join(t.slug, 'f.jsonl'));
    execFileSync('mkfifo', [join(t.slug, 'f.jsonl')]);
    const began = Date.now();
    expect(await read(t.root)).toEqual({
      ok: false,
      why: 'the helper stopped at type: f.jsonl is not a regular file',
    });
    expect(Date.now() - began).toBeLessThan(5_000); // a blocking open would sit here until the deadline
  });

  it.each([
    [
      'root',
      (t: ReturnType<typeof tree>) => rmSync(t.root, { recursive: true }),
      /^the helper stopped at root: /,
    ],
    [
      'component',
      (t: ReturnType<typeof tree>) => rmSync(t.slug, { recursive: true }),
      /^the helper stopped at component: slug: /,
    ],
    [
      'file',
      (t: ReturnType<typeof tree>) => rmSync(join(t.slug, 'f.jsonl')),
      /^the helper stopped at file: f\.jsonl: /,
    ],
  ])('leaves a missing %s unproven, naming the step', async (_label, remove, why) => {
    const t = tree();
    remove(t);
    const result = await read(t.root);
    expect(result.ok).toBe(false);
    expect((result as { why: string }).why).toMatch(why);
  });
});

describe('where the helper stops reading', () => {
  const at = async (content: Buffer) => {
    const t = tree();
    writeFileSync(join(t.slug, 'f.jsonl'), content);
    return read(t.root);
  };

  it('accepts a newline that is exactly the last byte of the limit', async () => {
    const content = Buffer.concat([Buffer.alloc(FIRST_RECORD_LIMIT - 1, 0x61), Buffer.from('\n')]);
    const result = await at(content);
    expect(result).toMatchObject({ ok: true, newline: true });
    expect((result as { bytes: Buffer }).bytes.length).toBe(65_536);
  });

  it('stops at exactly the limit when there is no newline within it', async () => {
    const result = await at(Buffer.alloc(FIRST_RECORD_LIMIT + 10, 0x61));
    expect(result).toMatchObject({ ok: true, newline: false });
    expect((result as { bytes: Buffer }).bytes.length).toBe(65_536);
  });

  it('does not read a newline that falls one byte past the limit', async () => {
    const content = Buffer.concat([Buffer.alloc(FIRST_RECORD_LIMIT, 0x61), Buffer.from('\n')]);
    const result = await at(content);
    expect(result).toMatchObject({ ok: true, newline: false });
    expect((result as { bytes: Buffer }).bytes.length).toBe(65_536);
  });

  it('stops at the first newline, so a second record is never read', async () => {
    const result = await at(Buffer.from('not json\n{"sessionId":"a later record"}\n'));
    expect(result).toEqual({ ok: true, bytes: Buffer.from('not json\n'), newline: true });
  });
});

describe('the helper on its own', () => {
  it.each([['..'], ['.'], [''], ['a/b'], ['a\\b']])(
    'refuses the component %j itself, whatever its caller checked',
    (bad) => {
      const t = tree();
      const out = execFileSync(
        'python3',
        [HELPER, '--root', t.root, '--component', bad, '--component', 'f.jsonl', '--cap', '10'],
        { encoding: 'utf8' },
      );
      expect(JSON.parse(out)).toMatchObject({ ok: false, step: 'arguments' });
    },
  );
});

describe('a failure after the file is open', () => {
  it('reports a failed fstat at its step, releasing every descriptor and keeping close diagnostics', async () => {
    const t = tree();
    // os.fstat raises; os.close really closes, then raises — so every descriptor is released and
    // every close still has a failure to report
    const shim = join(t.base, 'python3-faults');
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        "exec python3 -c '",
        'import errno, os, runpy, sys',
        'real_close = os.close',
        'def failing_fstat(fd): raise OSError(errno.EIO, os.strerror(errno.EIO))',
        'def failing_close(fd):',
        '    real_close(fd)',
        '    raise OSError(errno.EBADF, os.strerror(errno.EBADF))',
        'os.fstat = failing_fstat',
        'os.close = failing_close',
        'sys.argv = sys.argv[1:]',
        'runpy.run_path(sys.argv[0], run_name="__main__")',
        '\' "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(shim, 0o755);
    const result = await readFirstRecord(t.root, PARTS, {
      deadline: Date.now() + 10_000,
      python: shim,
    });
    expect(result).toEqual({
      ok: false,
      why: 'the helper stopped at type: f.jsonl: Input/output error',
      // root, projects, slug and the file: each was closed, and each close's failure is kept
      diagnostics: Array(4).fill('Bad file descriptor'),
    });
  });
});

describe('a helper that exits badly', () => {
  it('refuses its answer, however valid the JSON it printed', async () => {
    const t = tree();
    const shim = join(t.base, 'python3-bad-exit');
    const good = JSON.stringify({
      ok: true,
      count: 7,
      bytes: Buffer.from('inside\n').toString('base64'),
      newline: true,
      closeErrors: [],
    });
    writeFileSync(shim, `#!/bin/sh\nprintf '%s' '${good}'\necho oops >&2\nexit 3\n`);
    chmodSync(shim, 0o755);
    const result = await readFirstRecord(t.root, PARTS, {
      deadline: Date.now() + 10_000,
      python: shim,
    });
    expect(result).toEqual({ ok: false, why: 'the helper exited 3: oops' });
  });
});

describe('a Python without descriptor-relative open', () => {
  it('fails clearly, and within the bound', async () => {
    const t = tree();
    // a python3 whose os.open has lost dir_fd support, standing in for an unsupported platform
    const shim = join(t.base, 'python3');
    writeFileSync(
      shim,
      "#!/bin/sh\nexec python3 -c 'import os, runpy, sys; os.supports_dir_fd.discard(os.open); " +
        'sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name="__main__")\' "$@"\n',
    );
    chmodSync(shim, 0o755);
    const result = await readFirstRecord(t.root, PARTS, {
      deadline: Date.now() + 10_000,
      python: shim,
    });
    expect(result).toEqual({
      ok: false,
      why: 'the helper stopped at capability: this Python lacks: dir_fd for os.open',
    });
  });
});

describe('pathname swaps once a component is held', () => {
  /** Wait for the helper to reach a barrier point, act, then release it. */
  const at = async (barrier: string, point: string, act: () => void) => {
    const until = Date.now() + 5_000;
    while (!existsSync(join(barrier, `${point}.ready`))) {
      if (Date.now() > until) throw new Error(`helper never reached ${point}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    act();
    writeFileSync(join(barrier, `${point}.go`), '');
  };

  it('reads only the inside file through a swap-and-restore sequence', async () => {
    const t = tree();
    const barrier = mkdtempSync(join(t.base, 'barrier-')); // test-owned
    const toOutside = () => {
      renameSync(t.slug, `${t.slug}.orig`);
      symlinkSync(t.outside, t.slug);
    };
    const restore = () => {
      unlinkSync(t.slug); // the symlink itself; rmSync would resolve it to the outside directory
      renameSync(`${t.slug}.orig`, t.slug);
    };
    const reading = read(t.root, PARTS, barrier);
    await at(barrier, 'root', toOutside); // swapped out after the root is held
    await at(barrier, 'component-0', restore); // restored before the project directory is opened
    await at(barrier, 'component-1', toOutside); // swapped out again once it is held
    await at(barrier, 'file', () => undefined);
    // the held directory descriptor still names the original, so the file comes from inside
    expect(await reading).toEqual({ ok: true, bytes: Buffer.from('inside\n'), newline: true });
  });

  it('reads through a held parent even when that parent’s path is swapped outside', async () => {
    // `projects` is held; its pathname is then replaced by a symlink to an outside tree that has
    // its own slug/f.jsonl. Resolving `root/projects/slug` by path would land outside; resolving
    // `slug` relative to the held descriptor cannot.
    const t = tree();
    const outsideTree = join(t.base, 'outside-tree');
    mkdirSync(join(outsideTree, 'slug'), { recursive: true });
    writeFileSync(join(outsideTree, 'slug', 'f.jsonl'), 'OUTSIDE\n');
    const projects = join(t.root, 'projects');
    const barrier = mkdtempSync(join(t.base, 'barrier-'));
    const reading = read(t.root, PARTS, barrier);
    await at(barrier, 'root', () => undefined);
    await at(barrier, 'component-0', () => {
      renameSync(projects, `${projects}.orig`);
      symlinkSync(outsideTree, projects);
    });
    await at(barrier, 'component-1', () => undefined);
    await at(barrier, 'file', () => undefined);
    expect(await reading).toEqual({ ok: true, bytes: Buffer.from('inside\n'), newline: true });
  });

  it('refuses a component swapped to a symlink before it is opened', async () => {
    const t = tree();
    const barrier = mkdtempSync(join(t.base, 'barrier-'));
    const reading = read(t.root, PARTS, barrier);
    await at(barrier, 'root', () => undefined);
    await at(barrier, 'component-0', () => {
      renameSync(t.slug, `${t.slug}.orig`);
      symlinkSync(t.outside, t.slug);
    });
    const result = await reading;
    expect(result.ok).toBe(false);
    expect((result as { why: string }).why).toMatch(/^the helper stopped at component: slug: /);
  });

  it('bounds a helper held at a barrier that is never released', async () => {
    const t = tree();
    const barrier = mkdtempSync(join(t.base, 'barrier-'));
    const began = Date.now();
    const result = await readFirstRecord(t.root, PARTS, { deadline: began + 800, barrier });
    expect(result).toEqual({ ok: false, why: 'the helper did not finish within its deadline' });
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});

it('locates the helper beside this module', () => {
  expect(existsSync(HELPER)).toBe(true);
});
