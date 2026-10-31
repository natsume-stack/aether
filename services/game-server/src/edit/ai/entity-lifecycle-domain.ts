import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EntitiesTreeRDA, EntitySeedRDA, AssetsRDA, ProjectRDA, AssetType } from '@box/schema/project/project-rda';
import { ROOT_ID, TreeNodeType } from '@box/schema/project/murda-tree';
import type { EditServerState } from '../edit-server-schema';
import type { EditReplicaServer } from '../replica/replica-server';
import type { ContentDomain } from './authoring-session';
import { authoringError } from './authoring-session';
import { entitySnapshotRevision, readEntitySnapshot } from './entity-content-domain';

/**
 * Entity lifecycle domain: create, delete (leaf or explicit subtree) and reparent.
 *
 * Kept separate from the property domain on purpose: property edits are
 * reversible by writing old values back, while lifecycle changes need the whole
 * node — or the whole subtree — as inverse data.
 *
 * Policies, stated so callers never have to guess:
 * - deleting a node that has children requires `subtree: true`; it never
 *   silently orphans children.
 * - a locked node anywhere in the affected subtree refuses the whole plan.
 * - reparenting uses the tree's atomic `move` action; the inverse moves the node
 *   back to its original parent (end of that parent's child list).
 * - copying is leaf-only: the full node value (mesh and other properties) is
 *   cloned under a fresh id with an optional position offset. The inverse is
 *   the deletion of the generated copy.
 */

const finite = z.number().finite();
const vector3 = (member: z.ZodNumber) => z.tuple([member, member, member]);

const createSchema = z.object({
  op: z.literal('create'),
  parentId: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(32).regex(/^[^\u0000-\u001f]+$/),
  position: vector3(finite.min(-1000000).max(1000000)).optional(),
  scale: vector3(finite.min(0).max(10000)).optional(),
  orientation: z.tuple([finite, finite, finite, finite])
    .refine(v => Math.abs(Math.hypot(...v) - 1) < 0.03, 'Use a normalized quaternion').optional(),
  tint: z.tuple([finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1), finite.min(0).max(1)]).optional(),
  mesh: z.string().max(1024).optional(),
  tags: z.array(z.string().max(32)).max(64).optional(),
}).strict();

const deleteSchema = z.object({
  op: z.literal('delete'),
  entityId: z.string().min(1).max(64),
  subtree: z.boolean().optional(),
}).strict();

const moveSchema = z.object({
  op: z.literal('move'),
  entityId: z.string().min(1).max(64),
  /** Target parent, or omit/'' to move to the scene root. */
  parentId: z.string().max(64).optional(),
}).strict();

const copySchema = z.object({
  op: z.literal('copy'),
  entityId: z.string().min(1).max(64),
  /** Target parent, or omit to stay under the source's parent. */
  parentId: z.string().max(64).optional(),
  /** Defaults to the source name; duplicated names are allowed by the tree. */
  name: z.string().min(1).max(32).regex(/^[^\u0000-\u001f]+$/).optional(),
  positionOffset: vector3(finite.min(-1000000).max(1000000)).optional(),
}).strict();

export const entityLifecycleSchema = z.object({
  expectedRevision: z.string(),
  operations: z.array(z.discriminatedUnion('op', [createSchema, deleteSchema, moveSchema, copySchema])).min(1).max(16),
}).strict();

type Operation = z.infer<typeof createSchema> | z.infer<typeof deleteSchema> | z.infer<typeof moveSchema> | z.infer<typeof copySchema>;
type Step = {
  operations: Operation[];
  created: Record<number, string>;
  /** Ids removed by each delete operation, parent before child. */
  deletes: Record<number, string[]>;
  resultRevision: string;
};
type Snapshot = ReturnType<typeof readEntitySnapshot>;

type NodeJson = {
  id: string;
  name: string;
  parentId: string;
  type: number;
  childrenIds: string[];
  value: Record<string, any> | null;
};

function buildNode(id: string, operation: any): any {
  const node = EntitiesTreeRDA.nodeSchema.alloc();
  const defaults = EntitySeedRDA.stateSchema.identity;
  node.id = id;
  node.name = operation.name;
  node.parentId = operation.parentId || ROOT_ID;
  node.type = operation.type ?? TreeNodeType.leaf;
  node.childrenIds = [];
  if (operation.value === null) {
    node.value = undefined;
    return node;
  }
  node.value = {
    ...defaults,
    ...((operation as any).value ? structuredClone((operation as any).value) : {}),
    name: operation.name,
    ...(operation.position ? { position: operation.position } : {}),
    ...(operation.scale ? { scale: operation.scale } : {}),
    ...(operation.orientation ? { orientation: operation.orientation } : {}),
    ...(operation.tint ? { tint: operation.tint } : {}),
    ...(operation.tags ? { tags: operation.tags } : {}),
    ...(operation.mesh ? { mesh: operation.mesh } : {}),
  };
  return node;
}

/**
 * Copy becomes a create that carries the source's full value, so simulation,
 * CAS readback and the inverse (delete the new id) all reuse the create path.
 */
function normalizeCopy(snapshot: Snapshot, operation: z.infer<typeof copySchema>): Operation {
  const source = snapshot.tree[operation.entityId] as NodeJson | undefined;
  if (!source) throw authoringError('ENTITY_NOT_FOUND', 'Copy source does not exist');
  if (operation.entityId === ROOT_ID) throw authoringError('ENTITY_ROOT_IMMUTABLE', 'The scene root cannot be copied');
  if (source.type !== TreeNodeType.leaf || !source.value)
    throw authoringError('ENTITY_NOT_LEAF', 'Only leaf entities with editable properties can be copied');
  if (source.value.editLock) throw authoringError('ENTITY_LOCKED', 'Unlock this entity in the editor before copying it');
  const value: Record<string, any> = structuredClone(source.value);
  const base = Array.isArray(value.position) && value.position.length === 3 ? value.position : [0, 0, 0];
  const offset = operation.positionOffset || [0, 0, 0];
  value.position = [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]];
  const parentId = operation.parentId === undefined ? source.parentId || ROOT_ID : operation.parentId || ROOT_ID;
  const name = operation.name || source.name || value.name || 'Entity';
  value.name = name;
  return { op: 'create', parentId, name, type: source.type, value } as any;
}

/** Pre-order descendants: a parent always appears before its children. */
function descendants(tree: Record<string, any>, id: string): string[] {
  const out: string[] = [];
  const walk = (nodeId: string) => {
    for (const child of tree[nodeId]?.childrenIds || []) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

function subtreeIds(tree: Record<string, any>, id: string): string[] {
  return [id, ...descendants(tree, id)];
}

function validate(snapshot: Snapshot, step: Step, restoring = false) {
  const removed = new Set<string>();
  const added = new Set<string>();
  const exists = (id: string) => (!!snapshot.tree[id] && !removed.has(id)) || added.has(id);
  step.operations.forEach((operation, index) => {
    if (operation.op === 'create') {
      const parentId = operation.parentId || ROOT_ID;
      if (!exists(parentId)) throw authoringError('ENTITY_PARENT_NOT_FOUND', 'Parent node does not exist or was deleted in this plan');
      const mesh = operation.mesh as string | undefined;
      if (!restoring && mesh) {
        const asset = snapshot.assets[mesh];
        if (!asset || ![AssetType.VOXEL_MODEL, AssetType.GLTF_MODEL].includes(asset.type) || !asset.hash)
          throw authoringError('MODEL_NOT_FOUND', 'Mesh must reference an existing model asset with content in this project');
      }
      added.add(step.created[index]);
      return;
    }
    if (operation.op === 'move') {
      if (!exists(operation.entityId) || removed.has(operation.entityId))
        throw authoringError('ENTITY_NOT_FOUND', 'Target entity does not exist or is deleted by an earlier operation');
      if (operation.entityId === ROOT_ID) throw authoringError('ENTITY_ROOT_IMMUTABLE', 'The scene root cannot be moved');
      const target = operation.parentId || ROOT_ID;
      if (!exists(target) || removed.has(target)) throw authoringError('ENTITY_PARENT_NOT_FOUND', 'Target parent does not exist');
      if (target === operation.entityId) throw authoringError('ENTITY_CYCLE', 'An entity cannot be its own parent');
      const known = snapshot.tree[operation.entityId];
      if (known && target !== ROOT_ID && subtreeIds(snapshot.tree, operation.entityId).includes(target))
        throw authoringError('ENTITY_CYCLE', 'Cannot move an entity under its own descendant');
      if (known && (known.parentId || ROOT_ID) === target && !added.has(operation.entityId))
        throw authoringError('ENTITY_ALREADY_THERE', 'Entity already has this parent');
      return;
    }
    // Copy operations are normalized to creates before validation.
    const deletion = operation as z.infer<typeof deleteSchema>;
    const node = snapshot.tree[deletion.entityId];
    if (!node || removed.has(deletion.entityId)) throw authoringError('ENTITY_NOT_FOUND', 'Target entity does not exist');
    if (deletion.entityId === ROOT_ID) throw authoringError('ENTITY_ROOT_IMMUTABLE', 'The scene root cannot be deleted');
    const kids = descendants(snapshot.tree, deletion.entityId).filter(id => !removed.has(id));
    if (kids.length && !deletion.subtree)
      throw authoringError('ENTITY_HAS_CHILDREN', 'Target has children; pass subtree:true to delete the branch explicitly');
    if (node.value?.editLock) throw authoringError('ENTITY_LOCKED', 'Unlock this entity in the editor before deleting it');
    if (kids.length && step.deletes[index]?.length !== kids.length + 1)
      throw authoringError('ENTITY_HAS_CHILDREN', 'The subtree changed since it was read; re-read and propose again');
    for (const id of step.deletes[index] || [deletion.entityId]) {
      if (snapshot.tree[id]?.value?.editLock) throw authoringError('ENTITY_LOCKED', `Child ${id} is locked; unlock it before deleting the branch`);
    }
    for (const id of step.deletes[index] || [deletion.entityId]) removed.add(id);
  });
}

/**
 * Build the authoritative actions for this step as thunks.
 *
 * Order matters and later actions depend on earlier ones: a child can only be
 * added under a parent that exists, and a restore relinks nodes created in the
 * same step. The transaction therefore expands each thunk immediately before
 * applying it, never all up front.
 */
function actionsFor(api: () => any, step: Step): (() => any)[] {
  const actions: (() => any)[] = [];
  step.operations.forEach((operation, index) => {
    if (operation.op === 'create') {
      const id = step.created[index];
      actions.push(() => api().add(buildNode(id, operation)));
      return;
    }
    if (operation.op === 'move') {
      const parentId = operation.parentId || ROOT_ID;
      const insert = (operation as any).insert as { id: string; type: 'before' | 'after' } | undefined;
      actions.push(() => api().move({ moveIds: [operation.entityId], insertParentId: parentId, ...(insert ? { insert } : {}) }));
      return;
    }
    const ids = step.deletes[index];
    actions.push(() => api().remove(ids));
  });
  return actions;
}

function simulate(snapshot: Snapshot, step: Step): Snapshot {
  const tree = EntitiesTreeRDA.stateSchema.fromJSON(snapshot.tree);
  const store = EntitiesTreeRDA.createStore(tree);
  EntitiesTreeRDA.stateSchema.free(tree);
  const factories = actionsFor(() => EntitiesTreeRDA.action(store), step);
  const applied: any[] = [];
  try {
    for (const factory of factories) {
      const action = factory();
      if (!action) continue;
      store.apply(EntitiesTreeRDA, action);
      applied.push(action);
    }
    const next = store.state(EntitiesTreeRDA, EntitiesTreeRDA.stateSchema.alloc());
    try { return { tree: EntitiesTreeRDA.stateSchema.toJSON(next), assets: snapshot.assets } as Snapshot; }
    finally { EntitiesTreeRDA.stateSchema.free(next); }
  } finally {
    for (const action of applied) EntitiesTreeRDA.actionSchema.free(action);
    store.free(EntitiesTreeRDA);
  }
}

function inverseStep(snapshot: Snapshot, step: Step): Step {
  // Inverse operations may carry the full original value, which the public
  // create schema does not accept (it is built here, never parsed from input).
  const operations: any[] = [];
  const created: Record<number, string> = {};
  const deletes: Record<number, string[]> = {};
  [...step.operations].reverse().forEach((_, reverseIndex) => {
    const index = step.operations.length - 1 - reverseIndex;
    const operation = step.operations[index];
    if (operation.op === 'create') {
      operations.push({ op: 'delete', entityId: step.created[index] });
      deletes[operations.length - 1] = [step.created[index]];
      return;
    }
    if (operation.op === 'move') {
      const node = snapshot.tree[operation.entityId] as NodeJson;
      operations.push({ op: 'move', entityId: operation.entityId, parentId: node.parentId || ROOT_ID });
      return;
    }
    const ids = step.deletes[index];
    // Recreate every node first (parent before child), then relink the branch:
    // the tree links a parent to its children through explicit `move` actions,
    // so a plain re-add restores the entity but not its hierarchy.
    for (const id of ids) {
      const node = snapshot.tree[id] as NodeJson;
      const restored: Record<string, any> = structuredClone(node.value || {});
      operations.push({
        op: 'create',
        parentId: node.parentId,
        name: node.name,
        type: node.type,
        value: node.value === null ? null : restored,
        position: restored.position,
        scale: restored.scale,
        orientation: restored.orientation,
        tint: restored.tint,
        mesh: restored.mesh,
        tags: restored.tags,
      });
      created[operations.length - 1] = id;
    }
    // Relink in original sibling order. `move` without an anchor inserts at
    // the TOP of the child list (generateSequences defaults to index -1), so
    // every restored node is placed before its original next sibling, or after
    // its previous sibling when it was last. Processing back-to-front keeps the
    // anchors stable.
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const node = snapshot.tree[id] as NodeJson;
      const parentId = node.parentId || ROOT_ID;
      if (!groups.has(parentId)) groups.set(parentId, (snapshot.tree[parentId]?.childrenIds || []) as string[]);
    }
    for (const [parentId, fullOrder] of groups) {
      const restoredOrder = fullOrder.filter(child => ids.includes(child));
      for (let i = restoredOrder.length - 1; i >= 0; i--) {
        const id = restoredOrder[i];
        const at = fullOrder.indexOf(id);
        const next = fullOrder[at + 1];
        const previous = fullOrder[at - 1];
        operations.push({
          op: 'move', entityId: id, parentId,
          ...(next ? { insert: { id: next, type: 'before' } } : previous ? { insert: { id: previous, type: 'after' } } : {}),
        });
      }
    }
  });
  return { operations, created, deletes, resultRevision: '' };
}

export function createEntityLifecycleDomain(state: EditServerState, replica: EditReplicaServer): ContentDomain {
  const revision = () => entitySnapshotRevision(readEntitySnapshot(state));
  const running = () => !!state.game.state.replica.running;

  async function prepare(raw: Record<string, any>) {
    const args = entityLifecycleSchema.parse(raw);
    const before = readEntitySnapshot(state);
    const baseRevision = entitySnapshotRevision(before);
    if (args.expectedRevision !== baseRevision) throw authoringError('REVISION_CONFLICT', 'Entities or assets changed after reading');
    const created: Record<number, string> = {};
    const deletes: Record<number, string[]> = {};
    args.operations.forEach((operation, index) => {
      if (operation.op === 'create' || operation.op === 'copy') created[index] = randomUUID();
      if (operation.op === 'delete') {
        deletes[index] = operation.subtree ? subtreeIds(before.tree, operation.entityId) : [operation.entityId];
      }
    });
    const operations = args.operations.map((operation, index) =>
      operation.op === 'copy' ? normalizeCopy(before, operation) : operation);
    const step: Step = { operations, created, deletes, resultRevision: '' };
    validate(before, step);
    const after = simulate(before, step);
    step.resultRevision = entitySnapshotRevision(after);
    const inverse = inverseStep(before, step);
    inverse.resultRevision = baseRevision;
    const deletedCount = Object.values(deletes).reduce((sum, ids) => sum + ids.length, 0);
    return {
      baseRevision,
      step,
      preview: {
        kind: 'entities-lifecycle',
        atomic: false,
        operations: args.operations.map((operation, index) => {
          if (operation.op === 'create') {
            return { op: 'create', entityId: created[index], name: operation.name, parentId: operation.parentId || ROOT_ID,
              mesh: operation.mesh || null, position: operation.position || null };
          }
          if (operation.op === 'copy') {
            const copied = operations[index] as any;
            return { op: 'copy', entityId: created[index], sourceEntityId: operation.entityId, name: copied.name,
              parentId: copied.parentId, mesh: copied.value?.mesh || null, position: copied.value?.position || null,
              positionOffset: operation.positionOffset || null };
          }
          if (operation.op === 'move') {
            return { op: 'move', entityId: operation.entityId, name: before.tree[operation.entityId]?.name,
              parentId: operation.parentId || ROOT_ID, fromParentId: before.tree[operation.entityId]?.parentId || ROOT_ID };
          }
          return { op: 'delete', entityId: operation.entityId, name: before.tree[operation.entityId]?.name,
            subtree: !!operation.subtree, nodeCount: deletes[index]?.length || 1 };
        }),
        createdCount: args.operations.filter(op => op.op === 'create' || op.op === 'copy').length,
        copiedCount: args.operations.filter(op => op.op === 'copy').length,
        deletedCount,
        movedCount: args.operations.filter(op => op.op === 'move').length,
      },
      undoToken: JSON.stringify({ version: 1, step: inverse }),
    };
  }

  async function commit(step: Step, expected: string, restoring = false) {
    let mutationStarted = false;
    try {
      const newRevision = await replica.authoringProjectTransaction(() => {
        if (running()) throw authoringError('PREVIEW_RUNNING', 'Stop preview before editing entities');
        if (revision() !== expected) throw authoringError('REVISION_CONFLICT', 'Entities or assets changed while waiting for the project mutex');
        validate(readEntitySnapshot(state), step, restoring);
      }, () => {
        const current = readEntitySnapshot(state);
        if (entitySnapshotRevision(simulate(current, step)) !== step.resultRevision)
          throw authoringError('INVALID_ENTITY_PLAN', 'Entity lifecycle plan does not match the reviewed result');
        const actions = actionsFor(() => ProjectRDA.action(state.replica.projectStore).entitiesTree, step);
        mutationStarted = actions.length > 0;
        return actions;
      }, () => {
        const actual = revision();
        if (actual !== step.resultRevision) throw authoringError('WRITE_NOT_APPLIED', 'Entity readback differs; inspect current content');
        return actual;
      });
      return { success: true, newRevision, mutationStarted };
    } catch (error) {
      return { success: false, code: (error as any).code || 'ENTITY_COMMIT_FAILED', error: (error as Error).message, mutationStarted };
    }
  }

  return {
    revision,
    prepare,
    apply: (step, expected) => commit(step as Step, expected, false),
    revert: (token, expected) => {
      const inverse = JSON.parse(token);
      if (inverse.version !== 1) throw authoringError('INVALID_UNDO_TOKEN', 'Unsupported entity inverse version');
      return commit(inverse.step as Step, expected, true);
    },
  };
}
