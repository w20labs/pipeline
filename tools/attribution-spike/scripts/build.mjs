#!/usr/bin/env node
/**
 * Builds this package: a clean `dist`, the compiler's output, and every Python helper beside it.
 *
 * The helpers are found by looking in `src`, not by a list kept here: a helper added to the package
 * and forgotten in a build script is exactly the failure this replaces.
 *
 * `dist` is removed first, so nothing survives from an earlier build. That makes overlapping
 * commands against one checkout unsupported: a build replaces files that a concurrently running
 * test or sweep may be reading. Run `pnpm build`, `pnpm test` and any sweep one at a time here.
 * Supporting concurrent readers would need a different design, and this is not it.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Which package to build. A test builds a fixture; everything else builds this package. */
const root = resolve(process.argv[2] ?? packageRoot);
const dist = join(root, 'dist');
const src = join(root, 'src');

rmSync(dist, { recursive: true, force: true });
// the compiler this package already depends on, wherever the build was pointed
execFileSync(join(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc'), [
  '-p',
  join(root, 'tsconfig.json'),
]);
mkdirSync(dist, { recursive: true });
for (const name of readdirSync(src))
  if (name.endsWith('.py')) copyFileSync(join(src, name), join(dist, name));
