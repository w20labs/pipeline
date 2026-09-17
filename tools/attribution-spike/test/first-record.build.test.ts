import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The built package, not the sources: the Python helper is not something tsc emits, so this checks
 * the build puts it beside the compiled module and that it is found from there — from a working
 * directory that has nothing to do with the repository.
 */
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const built = join(pkgRoot, 'dist');
const scratch = mkdtempSync(join(tmpdir(), 'pipeline-first-record-build-'));

describe('the built package', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['--filter', '@pipeline/attribution-spike', 'build'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      stdio: 'pipe',
    });
  }, 120_000);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('ships the helper beside the compiled module', () => {
    expect(existsSync(join(built, 'read-first-record.py'))).toBe(true);
  });

  it('finds and runs the helper from an unrelated working directory', async () => {
    const root = join(scratch, 'root');
    mkdirSync(join(root, 'projects'), { recursive: true });
    writeFileSync(join(root, 'projects', 'f.jsonl'), 'built\n');
    const elsewhere = mkdtempSync(join(scratch, 'cwd-'));
    const script = `
      const { readFirstRecord, HELPER } = await import(${JSON.stringify(pathToFileURL(join(built, 'first-record.js')).href)});
      const result = await readFirstRecord(${JSON.stringify(root)}, ['projects', 'f.jsonl'], { deadline: Date.now() + 10000 });
      process.stdout.write(JSON.stringify({ helper: HELPER, ok: result.ok, text: result.ok ? result.bytes.toString() : result.why }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: elsewhere, timeout: 20_000 },
    );
    expect(JSON.parse(stdout)).toEqual({
      helper: join(built, 'read-first-record.py'),
      ok: true,
      text: 'built\n',
    });
  }, 30_000);
});
