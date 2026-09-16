import type { LayoutSpec, PaneId } from '../adapter.js';
import { herdrEnvelope, HerdrError, type HerdrEnvelope, type HerdrOptions } from './cli.js';

/**
 * `createLayout` over the herdr CLI.
 *
 * Every destination is named explicitly and nothing is created relative to focus. A new workspace
 * is created as a workspace we own — `workspace create`, never a bare `tab create`, which the spike
 * showed lands a tab in whatever the operator is looking at.
 *
 * Two of the three destinations take two calls, because `pane split` has no `--label` and
 * `workspace create --label` labels the *workspace*, while `LayoutSpec.label` is a tab or pane
 * title. In both cases the pane is renamed afterwards. That second call can fail once the first has
 * already created something, which is what {@link LayoutError} exists to report.
 */

/** What had already been created when a later step failed. Both are left in place. */
export interface LayoutRemains {
  readonly createdPane?: PaneId;
  /** Set only when this call created the workspace, so a caller knows what it owns. */
  readonly ownedWorkspaceId?: string;
}

/**
 * A layout step failed after herdr had confirmed creating something.
 *
 * What is claimed here is narrow: the named resources were **reported as created**, and this
 * adapter has since removed nothing. Whether they still exist, and what they are called, is not
 * known — the preserved cause may itself be `pane_not_found`. Creating again is not the recovery;
 * inspecting what is named here is. The original {@link HerdrError} is kept whole, fault and API
 * code included, so the reason is not flattened into this one.
 */
export class LayoutError extends Error {
  override readonly cause: HerdrError;
  constructor(
    cause: HerdrError,
    readonly remains: LayoutRemains,
    detail: string,
  ) {
    const owned =
      remains.ownedWorkspaceId === undefined ? '' : ` in workspace ${remains.ownedWorkspaceId}`;
    super(
      `${detail}${owned}: ${cause.message}. Creation was confirmed and this adapter removed nothing; inspect what is named here rather than creating it again.`,
    );
    this.name = 'LayoutError';
    this.cause = cause;
  }
}

/** Read one string out of a nested payload object, or nothing if it is not there. */
export const optional = (
  envelope: HerdrEnvelope,
  key: string,
  field: string,
): string | undefined => {
  const holder = envelope.result[key];
  const value =
    typeof holder === 'object' && holder !== null
      ? (holder as Record<string, unknown>)[field]
      : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const nested = (
  envelope: HerdrEnvelope,
  argv: readonly string[],
  key: string,
  field: string,
): string => {
  const value = optional(envelope, key, field);
  if (value === undefined)
    throw new HerdrError('malformed', argv, `the result carries no ${key}.${field}`);
  return value;
};

/**
 * Each command answers with its own event type. Accepting any envelope would let one command's
 * answer stand in for another's, so the type is checked before anything is read out of it.
 */
export const expectType = (
  envelope: HerdrEnvelope,
  argv: readonly string[],
  type: string,
): void => {
  if (envelope.result.type !== type)
    throw new HerdrError('malformed', argv, `answered ${envelope.result.type}, not ${type}`);
};

/** Run a step, turning any failure into one that still names what exists. */
const preserving = async <T>(remains: LayoutRemains, detail: string, step: () => T): Promise<T> => {
  try {
    return await step();
  } catch (cause) {
    throw new LayoutError(cause as HerdrError, remains, detail);
  }
};

/**
 * Rename a pane, and require the answer to confirm *that* pane carrying *that* label.
 *
 * A well-formed response about some other pane is not confirmation of this one.
 */
const renameTo = async (pane: PaneId, label: string, options: HerdrOptions): Promise<void> => {
  const argv = ['pane', 'rename', pane, label];
  const renamed = await herdrEnvelope(argv, options);
  expectType(renamed, argv, 'pane_info');
  const named = nested(renamed, argv, 'pane', 'pane_id');
  if (named !== pane)
    throw new HerdrError(
      'malformed',
      argv,
      `confirmed ${named}, not the pane ${pane} it was given`,
    );
  const applied = nested(renamed, argv, 'pane', 'label');
  if (applied !== label)
    throw new HerdrError('malformed', argv, `confirmed the label ${applied}, not ${label}`);
};

export async function createLayout(spec: LayoutSpec, options: HerdrOptions = {}): Promise<PaneId> {
  const { destination } = spec;

  if (destination.kind === 'workspace') {
    // The tab carries the label, so this is the one destination that needs no rename.
    const argv = [
      'tab',
      'create',
      '--workspace',
      destination.workspaceId,
      '--cwd',
      spec.cwd,
      '--label',
      spec.label,
    ];
    const created = await herdrEnvelope(argv, options);
    expectType(created, argv, 'tab_created');
    return nested(created, argv, 'root_pane', 'pane_id') as PaneId;
  }

  if (destination.kind === 'new_workspace') {
    const argv = ['workspace', 'create', '--cwd', spec.cwd, '--label', spec.label];
    const created = await herdrEnvelope(argv, options);
    expectType(created, argv, 'workspace_created');
    // Both identities are read independently, so whichever is missing the other is still reported.
    const ownedWorkspaceId = optional(created, 'workspace', 'workspace_id');
    const pane = optional(created, 'root_pane', 'pane_id') as PaneId | undefined;
    const remains: LayoutRemains = {
      ...(pane === undefined ? {} : { createdPane: pane }),
      ...(ownedWorkspaceId === undefined ? {} : { ownedWorkspaceId }),
    };
    const refuse = (detail: string): never => {
      throw new LayoutError(
        new HerdrError('malformed', argv, detail),
        remains,
        'the workspace was created',
      );
    };
    if (ownedWorkspaceId === undefined) refuse('the result carries no workspace.workspace_id');
    if (pane === undefined) refuse('the result carries no root_pane.pane_id');
    // A pane belonging to some other workspace is not this workspace's root, and renaming it
    // would act on something this call never created.
    if (optional(created, 'root_pane', 'workspace_id') !== ownedWorkspaceId)
      refuse(`the root pane ${pane as PaneId} is not in workspace ${ownedWorkspaceId as string}`);
    await preserving(
      remains,
      `the pane ${pane as PaneId} was created but could not be renamed`,
      () => renameTo(pane as PaneId, spec.label, options),
    );
    return pane as PaneId;
  }

  const argv = [
    'pane',
    'split',
    destination.pane,
    '--direction',
    destination.direction,
    '--cwd',
    spec.cwd,
    // the operator's focus stays where it was
    '--no-focus',
  ];
  const created = await herdrEnvelope(argv, options);
  expectType(created, argv, 'pane_info');
  const pane = nested(created, argv, 'pane', 'pane_id') as PaneId;
  await preserving(
    { createdPane: pane },
    `the pane ${pane} was created but could not be renamed`,
    () => renameTo(pane, spec.label, options),
  );
  return pane;
}
