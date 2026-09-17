import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the package once, bounded, before any test file runs. Tests that drive `dist/` rely on it;
 * a build that fails or overruns throws here, which stops the run rather than testing stale output.
 */
export default function build(): void {
  execFileSync('pnpm', ['--filter', '@pipeline/attribution-spike', 'build'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: 'pipe',
    timeout: 120_000,
  });
}
