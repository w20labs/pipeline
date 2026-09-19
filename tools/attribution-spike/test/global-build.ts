import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the package once, bounded, before any test file runs. Tests that drive `dist/` rely on it;
 * a build that fails or overruns throws here, which stops the run rather than testing stale output.
 *
 * The build removes `dist` first, so overlapping commands against one checkout are unsupported: a
 * build started while tests or a sweep are running replaces files those readers are holding. Run
 * `pnpm build`, `pnpm test` and any sweep one at a time here. Nothing in this setup makes a second
 * builder safe — supporting concurrent readers would need a different design.
 */
export default function build(): void {
  execFileSync('pnpm', ['--filter', '@pipeline/attribution-spike', 'build'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: 'pipe',
    timeout: 120_000,
  });
}
