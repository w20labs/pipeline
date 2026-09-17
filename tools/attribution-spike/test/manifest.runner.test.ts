import { describe, expect, it } from 'vitest';

import type { readControlFile } from '../src/control-file.js';
import { manifestPhase } from '../src/manifest.js';
import { type RunConfig, runResearch } from '../src/runner.js';

const CONFIG: RunConfig = {
  runId: 'run-1',
  runsRoot: '/cache/research/runs',
  researchConfig: '/cache/research/claude-config',
  operatorClaudeDir: '/home/op/.claude',
  scratch: '/cache/scratch',
  controlDir: '/cache/research/control',
  budgetMs: 10_000,
  cleanupReserveMs: 2_000,
};
const MANIFEST = {
  version: 1,
  configPath: CONFIG.researchConfig,
  claudeVersion: '2.1.272',
  bootstrappedAt: '2026-09-17T08:30:00Z',
  separateAuthorization: 'unknown',
  bootstrapSessionClosed: true,
};

/** The real phase and runner; only the reader and the filesystem are fakes. The clock stands still. */
const summaryOf = async (manifest: object) => {
  const read: typeof readControlFile = async () => ({
    kind: 'read',
    bytes: Buffer.from(JSON.stringify(manifest)),
  });
  const written: string[] = [];
  const fs = {
    mkdirExclusive: async () => undefined,
    writeSummary: async (_path: string, text: string) => void written.push(text),
  };
  const result = await runResearch(CONFIG, [manifestPhase(CONFIG, read)], fs, () => 1_000);
  expect(written).toHaveLength(1);
  return {
    result,
    text: written[0] ?? '',
    summary: JSON.parse(written[0] ?? '') as Record<string, unknown>,
  };
};

describe('the manifest phase inside a research run', () => {
  it('writes exactly the three approved evidence fields to the summary', async () => {
    const { summary, text } = await summaryOf(MANIFEST);
    expect(summary['outcome']).toEqual({ kind: 'completed' });
    expect(summary['phases']).toEqual([
      {
        name: 'manifest',
        status: 'completed',
        startedAt: 1_000,
        endedAt: 1_000,
        evidence: {
          claudeVersion: '2.1.272',
          bootstrappedAt: '2026-09-17T08:30:00Z',
          separateAuthorization: 'unknown',
        },
      },
    ]);
    for (const withheld of [
      'configPath',
      'bootstrapSessionClosed',
      '"version"',
      CONFIG.researchConfig,
    ])
      expect(text).not.toContain(withheld);
  });

  it('refuses a manifest in fixed words, with no evidence and none of its content in the summary', async () => {
    const { result, summary, text } = await summaryOf({
      ...MANIFEST,
      configPath: '/SENTINEL',
      claudeVersion: 'SENTINEL',
    });
    const refused = {
      name: 'manifest',
      status: 'refused',
      why: 'the bootstrap manifest is invalid: configPath does not name this research configuration',
      startedAt: 1_000,
      endedAt: 1_000,
    };
    expect(result.outcome).toEqual(refused);
    expect(summary['outcome']).toEqual(refused);
    expect(summary['phases']).toEqual([refused]); // no evidence field at all
    expect(text).not.toContain('SENTINEL');
  });
});
