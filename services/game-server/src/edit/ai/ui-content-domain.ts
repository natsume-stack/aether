import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProjectRDA } from '@box/schema/project/project-rda';
import { UITreeRDA } from '@box/schema/project/ui-rda/defs';
import type { EditServerState } from '../edit-server-schema';
import type { EditReplicaServer } from '../replica/replica-server';
import { authoringError, ContentDomain } from './authoring-session';

const finite = z.number().finite();
const pair = (member: z.ZodNumber) => z.tuple([member, member]);
const rgb = z.tuple([
  finite.int().min(0).max(255),
  finite.int().min(0).max(255),
  finite.int().min(0).max(255),
]);
const properties = z
  .object({
    positionOffset: pair(finite.min(-100000).max(100000)).optional(),
    positionRatio: pair(finite.min(-10).max(10)).optional(),
    sizeOffset: pair(finite.min(0).max(100000)).optional(),
    sizeRatio: pair(finite.min(0).max(10)).optional(),
    anchor: pair(finite.min(0).max(1)).optional(),
    visible: z.boolean().optional(),
    backgroundColor: rgb.optional(),
    backgroundOpacity: finite.min(0).max(1).optional(),
    textContent: z.string().max(10000).optional(),
    textFontSize: finite.int().min(1).max(255).optional(),
    textColor: rgb.optional(),
    textOpacity: finite.min(0).max(1).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Supply at least one supported property');
export const uiPatchSchema = z
  .object({
    expectedRevision: z.string(),
    patches: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            properties,
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
type Patch = { nodeId: string; properties: Record<string, any> };
type Tree = Record<string, any>;
const nested: Record<string, [string, string]> = {
  positionOffset: ['position', 'offset'],
  positionRatio: ['position', 'ratio'],
  sizeOffset: ['size', 'offset'],
  sizeRatio: ['size', 'ratio'],
};
const stable = (value: any): any =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, stable(value[key])]),
      )
    : value;
export const uiContentRevision = (tree: Tree) =>
  createHash('sha256')
    .update(JSON.stringify(stable(tree)))
    .digest('hex');

export function readUiContent(state: EditServerState): Tree {
  const store = state.replica.projectStore?.stores.uiTree;
  if (!store) throw authoringError('STATE_UNAVAILABLE', 'Authoritative UI store is required');
  const raw = store.state(UITreeRDA, UITreeRDA.stateSchema.alloc());
  try {
    const tree = UITreeRDA.stateSchema.toJSON(raw) as Tree;
    if (
      Object.keys(tree).length > 10000 ||
      Buffer.byteLength(JSON.stringify(tree)) > 4 * 1024 * 1024
    )
      throw authoringError('UI_CHECK_BUDGET', 'UI snapshot exceeds bounded review budget');
    return tree;
  } finally {
    UITreeRDA.stateSchema.free(raw);
  }
}
const dataOf = (tree: Tree, id: string) => tree[id]?.value?.data?.data;
const valueOf = (data: any, key: string) =>
  nested[key] ? data[nested[key][0]][nested[key][1]] : data[key];
function validate(tree: Tree, patches: Patch[]) {
  const seen = new Set();
  for (const patch of patches) {
    if (seen.has(patch.nodeId))
      throw authoringError('UI_PATCH_AMBIGUOUS', 'Combine each node into a single patch');
    seen.add(patch.nodeId);
    const node = tree[patch.nodeId];
    if (node?.value?.type !== 'element' || !dataOf(tree, patch.nodeId))
      throw authoringError(
        'UI_NODE_NOT_EDITABLE',
        'Only existing UI elements support property edits',
      );
    const data = dataOf(tree, patch.nodeId);
    for (const key of Object.keys(patch.properties)) {
      if (valueOf(data, key) === undefined)
        throw authoringError(
          'UI_PROPERTY_NOT_SUPPORTED',
          `Property ${key} is unavailable on ${node.value.data.type}`,
        );
      // Absolute positioning on an auto-layout parent silently fails in the
      // actual renderer. Refuse that misleading proposal rather than claim success.
      const parent = tree[node.parentId]?.value;
      const parentData = parent?.type === 'screen' ? parent.data : parent?.data?.data;
      if (key.startsWith('position') && parentData?.layout?.type === 'autoLayout')
        throw authoringError(
          'UI_AUTO_LAYOUT_POSITION',
          'Parent uses auto layout; position changes would not control this element',
        );
    }
  }
}
function actions(api: () => any, tree: Tree, patches: Patch[]) {
  const result: any[] = [];
  for (const patch of patches)
    for (const [key, value] of Object.entries(patch.properties)) {
      const member = api().update(patch.nodeId).update().element.update()[
        tree[patch.nodeId].value.data.type
      ];
      const location = nested[key];
      result.push(location ? member[location[0]][location[1]](value) : member[key](value));
    }
  return result;
}
function simulate(tree: Tree, patches: Patch[]) {
  const raw = UITreeRDA.stateSchema.fromJSON(tree);
  const store = UITreeRDA.createStore(raw);
  UITreeRDA.stateSchema.free(raw);
  const changes = actions(() => UITreeRDA.action(store), tree, patches);
  try {
    for (const change of changes) store.apply(UITreeRDA, change);
    const next = store.state(UITreeRDA, UITreeRDA.stateSchema.alloc());
    try {
      return UITreeRDA.stateSchema.toJSON(next) as Tree;
    } finally {
      UITreeRDA.stateSchema.free(next);
    }
  } finally {
    for (const change of changes) UITreeRDA.actionSchema.free(change);
    store.free(UITreeRDA);
  }
}

/** Property-only boundary: IDs, names, node kinds, hierarchy, image references
 * and author scripts never change, preserving declarative binding identity.
 * No claim of new/deleted nodes, dynamic binding proof or visual correctness.
 */
export function createUiContentDomain(
  state: EditServerState,
  replica: EditReplicaServer,
): ContentDomain {
  const revision = () => uiContentRevision(readUiContent(state));
  async function prepare(raw: Record<string, any>) {
    const args = uiPatchSchema.parse(raw);
    const before = readUiContent(state),
      baseRevision = uiContentRevision(before);
    if (args.expectedRevision !== baseRevision)
      throw authoringError('REVISION_CONFLICT', 'UI changed after reading');
    validate(before, args.patches);
    const after = simulate(before, args.patches);
    const inverse = args.patches.map((patch) => ({
      nodeId: patch.nodeId,
      properties: Object.fromEntries(
        Object.keys(patch.properties).map((key) => [
          key,
          valueOf(dataOf(before, patch.nodeId), key),
        ]),
      ),
    }));
    return {
      baseRevision,
      step: { patches: args.patches, resultRevision: uiContentRevision(after) },
      preview: {
        kind: 'ui',
        bindingIdentity: 'preserved-property-only',
        changes: args.patches.map((patch) => ({
          nodeId: patch.nodeId,
          name: before[patch.nodeId].name,
          parentId: before[patch.nodeId].parentId,
          properties: Object.keys(patch.properties).map((key) => ({
            key,
            before: valueOf(dataOf(before, patch.nodeId), key),
            after: valueOf(dataOf(after, patch.nodeId), key),
          })),
        })),
      },
      undoToken: JSON.stringify({ version: 1, patches: inverse, resultRevision: baseRevision }),
    };
  }
  async function commit(step: Record<string, any>, expected: string) {
    let mutationStarted = false;
    try {
      const newRevision = await replica.authoringProjectTransaction(
        () => {
          if (state.game.state.replica.running)
            throw authoringError('PREVIEW_RUNNING', 'Stop preview before editing UI');
          if (revision() !== expected)
            throw authoringError('REVISION_CONFLICT', 'UI changed while waiting for project mutex');
          validate(readUiContent(state), step.patches);
        },
        () => {
          const tree = readUiContent(state);
          if (uiContentRevision(simulate(tree, step.patches)) !== step.resultRevision)
            throw authoringError('INVALID_UI_PLAN', 'UI plan differs from reviewed result');
          const changes = actions(
            () => ProjectRDA.action(state.replica.projectStore).uiTree,
            tree,
            step.patches,
          );
          mutationStarted = changes.length > 0;
          return changes;
        },
        () => {
          const actual = revision();
          if (actual !== step.resultRevision)
            throw authoringError(
              'WRITE_NOT_APPLIED',
              'UI readback differs; inspect current content',
            );
          return actual;
        },
      );
      return { success: true, newRevision, mutationStarted };
    } catch (error) {
      return {
        success: false,
        code: (error as any).code || 'UI_COMMIT_FAILED',
        error: (error as Error).message,
        mutationStarted,
      };
    }
  }
  return {
    revision,
    prepare,
    apply: commit,
    revert: (token, expected) => {
      const inverse = JSON.parse(token);
      if (inverse.version !== 1)
        throw authoringError('INVALID_UNDO_TOKEN', 'Unsupported UI inverse version');
      return commit(inverse, expected);
    },
  };
}
