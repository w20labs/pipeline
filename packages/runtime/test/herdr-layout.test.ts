import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LayoutSpec, PaneId } from '../src/adapter.js';
import type { HerdrError, HerdrRunner } from '../src/herdr/cli.js';
import { createLayout, LayoutError } from '../src/herdr/layout.js';

const recorded = (group: string, name: string) => {
  const at = (ext: string) =>
    fileURLToPath(new URL(`./fixtures/herdr/${group}/${name}.${ext}`, import.meta.url));
  const meta = readFileSync(at('meta'), 'utf8');
  return {
    code: Number(/^exit: (\d+)$/m.exec(meta)?.[1]),
    stdout: readFileSync(at('stdout'), 'utf8'),
    stderr: readFileSync(at('stderr'), 'utf8'),
  };
};

/** Replays one recorded response per call, and records the argv it was given. */
const script = (...responses: { code: number; stdout: string; stderr: string }[]) => {
  const calls: (readonly string[])[] = [];
  let next = 0;
  const run: HerdrRunner = (_file, argv) => {
    calls.push(argv);
    const response = responses[next++];
    if (response === undefined) throw new Error(`unscripted call: ${argv.join(' ')}`);
    return Promise.resolve(response);
  };
  return { run, calls, verb: () => calls.map((c) => c.slice(0, 2).join(' ')) };
};

/**
 * The error a layout call rejected with.
 *
 * Narrower than `.catch(cause => cause as HerdrError)`, which widens the awaited type to include
 * the pane, and stricter: a call that *resolves* says so here rather than failing later on a
 * missing property.
 */
const rejection = async (work: Promise<unknown>): Promise<HerdrError> =>
  work.then(
    (value) => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (cause: unknown) => cause as HerdrError,
  );

/** A rename answer that actually confirms the pane and label it was asked about. */
const renamed = (pane: string, label: string) => ({
  code: 0,
  stdout: JSON.stringify({
    id: 'cli:pane:rename',
    result: { type: 'pane_info', pane: { pane_id: pane, label } },
  }),
  stderr: '',
});

const spec = (destination: LayoutSpec['destination'], label = 'reviewer'): LayoutSpec => ({
  destination,
  cwd: '/repo',
  label,
});
const caught = async (work: Promise<unknown>): Promise<LayoutError & { cause: HerdrError }> =>
  work.then(
    () => {
      throw new Error('expected a LayoutError');
    },
    (error: unknown) => error as LayoutError & { cause: HerdrError },
  );

describe('creating a layout', () => {
  it('owns the workspace it creates, and labels its root pane', async () => {
    // the recorded rename confirms w2:p1 carrying 'reviewer', which is what this case creates
    const s = script(recorded('workspace-create', 'success'), recorded('pane-rename', 'success'));
    const pane = await createLayout(spec({ kind: 'new_workspace' }), { run: s.run });
    expect(pane).toBe('w2:p1');
    expect(s.calls[0]).toEqual(['workspace', 'create', '--cwd', '/repo', '--label', 'reviewer']);
    // the workspace label is not the pane title, so the root pane is renamed too
    expect(s.calls[1]).toEqual(['pane', 'rename', 'w2:p1', 'reviewer']);
    // never a bare tab create, which lands in whatever the operator is looking at
    expect(s.verb()).not.toContain('tab create');
  });

  it('puts a tab in an existing workspace, where the tab carries the label', async () => {
    const s = script(recorded('tab-create', 'success'));
    const pane = await createLayout(spec({ kind: 'workspace', workspaceId: 'w1' }), { run: s.run });
    expect(pane).toBe('w1:p2');
    expect(s.calls[0]).toEqual([
      'tab',
      'create',
      '--workspace',
      'w1',
      '--cwd',
      '/repo',
      '--label',
      'reviewer',
    ]);
    expect(s.calls).toHaveLength(1); // nothing to rename
  });

  it.each(['right', 'down'] as const)(
    'splits %s without moving the operator',
    async (direction) => {
      const s = script(recorded('pane-split', 'success'), renamed('wA:p3', 'reviewer'));
      const pane = await createLayout(spec({ kind: 'split', pane: 'wA:p1' as PaneId, direction }), {
        run: s.run,
      });
      expect(pane).toBe('wA:p3');
      expect(s.calls[0]).toEqual([
        'pane',
        'split',
        'wA:p1',
        '--direction',
        direction,
        '--cwd',
        '/repo',
        '--no-focus',
      ]);
      expect(s.calls[1]).toEqual(['pane', 'rename', 'wA:p3', 'reviewer']); // split takes no --label
    },
  );

  it('passes the working directory and label through unchanged', async () => {
    const s = script(recorded('pane-split', 'success'), renamed('wA:p3', 'review round 2'));
    const odd = {
      destination: { kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' },
      cwd: '/repo/a dir/"quoted"',
      label: 'review round 2',
    } as LayoutSpec;
    await createLayout(odd, { run: s.run });
    expect(s.calls[0]).toContain('/repo/a dir/"quoted"');
    expect(s.calls[1]?.at(-1)).toBe('review round 2');
  });
});

describe('confirming what the answer is about', () => {
  it.each([
    [
      'a rename that confirms another pane',
      renamed('w9:p9', 'reviewer'),
      /confirmed w9:p9, not the pane wA:p3/,
    ],
    [
      'a rename that confirms another label',
      renamed('wA:p3', 'something else'),
      /confirmed the label something else/,
    ],
    [
      'a rename answering with the wrong event',
      {
        code: 0,
        stdout:
          '{"id":"cli:pane:rename","result":{"type":"tab_created","pane":{"pane_id":"wA:p3","label":"reviewer"}}}',
        stderr: '',
      },
      /answered tab_created, not pane_info/,
    ],
  ])('refuses %s', async (_label, response, message) => {
    const s = script(recorded('pane-split', 'success'), response);
    const error = await caught(
      createLayout(spec({ kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' }), {
        run: s.run,
      }),
    );
    expect(error.cause.fault).toBe('malformed');
    expect(error.cause.message).toMatch(message);
    expect(error.remains).toEqual({ createdPane: 'wA:p3' }); // the split did happen
  });

  it('refuses a root pane belonging to a different workspace, renaming nothing', async () => {
    const s = script({
      code: 0,
      stdout: JSON.stringify({
        id: 'cli:workspace:create',
        result: {
          type: 'workspace_created',
          workspace: { workspace_id: 'w2' },
          root_pane: { pane_id: 'w9:p9', workspace_id: 'w9' },
        },
      }),
      stderr: '',
    });
    const error = await caught(createLayout(spec({ kind: 'new_workspace' }), { run: s.run }));
    expect(error.cause.message).toMatch(/w9:p9 is not in workspace w2/);
    expect(s.calls).toHaveLength(1); // nothing was renamed
  });

  it.each([
    ['workspace create', 'workspace_created'],
    ['tab create', 'tab_created'],
    ['pane split', 'pane_info'],
  ])('refuses an answer to %s that is the wrong event', async (command, wanted) => {
    const destination: LayoutSpec['destination'] =
      command === 'workspace create'
        ? { kind: 'new_workspace' }
        : command === 'tab create'
          ? { kind: 'workspace', workspaceId: 'w1' }
          : { kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' };
    const s = script({
      code: 0,
      stdout: '{"id":"cli:x","result":{"type":"something_else"}}',
      stderr: '',
    });
    const error = await rejection(createLayout(spec(destination), { run: s.run }));
    expect(error).toMatchObject({ fault: 'malformed' });
    expect(error.message).toContain(`not ${wanted}`);
  });
});

describe('when a later step fails', () => {
  it('keeps the workspace and pane it made when the rename is refused', async () => {
    const s = script(
      recorded('workspace-create', 'success'),
      recorded('pane-rename', 'error-bad-pane'),
    );
    const error = await caught(createLayout(spec({ kind: 'new_workspace' }), { run: s.run }));
    expect(error).toBeInstanceOf(LayoutError);
    expect(error.remains).toEqual({ createdPane: 'w2:p1', ownedWorkspaceId: 'w2' });
    // the original failure survives whole, fault and herdr's own code included
    expect(error.cause).toMatchObject({ fault: 'api_error', code: 'pane_not_found' });
    expect(error.message).toMatch(/removed nothing; inspect what is named here/);
    // nothing was created again and nothing was cleaned up
    expect(s.verb()).toEqual(['workspace create', 'pane rename']);
  });

  it('keeps the split pane when its rename is refused, and owns no workspace', async () => {
    const s = script(recorded('pane-split', 'success'), recorded('pane-rename', 'error-bad-pane'));
    const error = await caught(
      createLayout(spec({ kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' }), {
        run: s.run,
      }),
    );
    expect(error.remains).toEqual({ createdPane: 'wA:p3' });
    expect(error.remains.ownedWorkspaceId).toBeUndefined(); // this call created no workspace
    expect(error.cause.fault).toBe('api_error');
    expect(s.verb()).toEqual(['pane split', 'pane rename']);
  });

  it('still names what exists when the rename answers with an unreadable payload', async () => {
    const s = script(recorded('workspace-create', 'success'), {
      code: 0,
      stdout: '{"id":"cli:pane:rename","result":{"type":"pane_info"}}',
      stderr: '',
    });
    const error = await caught(createLayout(spec({ kind: 'new_workspace' }), { run: s.run }));
    expect(error.remains).toEqual({ createdPane: 'w2:p1', ownedWorkspaceId: 'w2' });
    expect(error.cause.fault).toBe('malformed');
  });

  it('names the pane it created when the workspace cannot be read', async () => {
    const s = script({
      code: 0,
      stdout: JSON.stringify({
        id: 'cli:workspace:create',
        result: { type: 'workspace_created', root_pane: { pane_id: 'w7:p1', workspace_id: 'w7' } },
      }),
      stderr: '',
    });
    const error = await caught(createLayout(spec({ kind: 'new_workspace' }), { run: s.run }));
    // whichever field is missing, the one that was read is still reported
    expect(error.remains).toEqual({ createdPane: 'w7:p1' });
    expect(error.cause.message).toMatch(/workspace\.workspace_id/);
    expect(s.calls).toHaveLength(1); // and no rename follows a failed validation
  });

  it('names the workspace it created when the root pane cannot be read', async () => {
    const s = script({
      code: 0,
      stdout:
        '{"id":"cli:workspace:create","result":{"type":"workspace_created","workspace":{"workspace_id":"w7"}}}',
      stderr: '',
    });
    const error = await caught(createLayout(spec({ kind: 'new_workspace' }), { run: s.run }));
    expect(error.remains).toEqual({ ownedWorkspaceId: 'w7' });
    expect(error.remains.createdPane).toBeUndefined();
    expect(error.cause.fault).toBe('malformed');
    expect(s.calls).toHaveLength(1); // no rename was attempted for a pane we cannot name
  });
});

describe('when creation itself fails', () => {
  it('reports a refused split as herdr reported it, having made nothing', async () => {
    const s = script(recorded('pane-run', 'error-bad-pane'));
    const error = await createLayout(
      spec({ kind: 'split', pane: 'wA:p999' as PaneId, direction: 'right' }),
      { run: s.run },
    ).catch((cause: unknown) => cause as HerdrError);
    expect(error).not.toBeInstanceOf(LayoutError); // there is nothing that survived to report
    expect(error).toMatchObject({ fault: 'api_error', code: 'pane_not_found' });
  });

  it('reports a rejected direction as the usage error it is', async () => {
    const s = script(recorded('pane-split', 'error-bad-direction'));
    const error = await rejection(
      createLayout(spec({ kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' }), {
        run: s.run,
      }),
    );
    expect(error).toMatchObject({ fault: 'usage', exitCode: 2 });
    expect(error.message).toContain('invalid split direction');
  });

  it('refuses a split whose payload names no pane', async () => {
    const s = script({
      code: 0,
      stdout: '{"id":"cli:pane:split","result":{"type":"pane_info"}}',
      stderr: '',
    });
    const error = await rejection(
      createLayout(spec({ kind: 'split', pane: 'wA:p1' as PaneId, direction: 'right' }), {
        run: s.run,
      }),
    );
    expect(error).not.toBeInstanceOf(LayoutError); // nothing was established to preserve
    expect(error.fault).toBe('malformed');
    expect(s.calls).toHaveLength(1);
  });
});
