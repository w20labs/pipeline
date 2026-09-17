import { defineConfig } from 'vitest/config';

export default defineConfig({
  // One build before any test file runs: two test files building concurrently race on dist/.
  test: { globalSetup: './test/global-build.ts' },
});
