import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EntitiesTreeRDA, AssetsRDA, ProjectRDA, AssetType } from '@box/schema/project/project-rda';
import { TreeNodeType } from '@box/schema/project/murda-tree';
import type { EditServerState } from '../edit-server-schema';
import type { EditReplicaServer } from '../replica/replica-server';
import type { ContentDomain } from './authoring-session';
import { authoringError } from './authoring-session';

const finite = z.number().finite();
const vector3 = (member: z.ZodNumber) => z.tuple([member, member, member]);
const color = finite.min(0).max(1);
const properties = z.object({
  name: z.string().min(1).max(32).regex(/^[^\u0000-\u001f]+$/).optional(),
  tags: z.array(z.string().max(32)).max(64).optional(),
  position: vector3(finite.min(-1000000).max(1000000)).optional(),
  scale: vector3(finite.min(0).max(10000)).optional(),
  orientation: z.tuple([finite, finite, finite, finite]).refine(value => Math.abs(Math.hypot(...value) - 1) < 0.03, 'Use a normalized quaternion').optional(),
  tint: z.tuple([color, color, color, color]).optional(),
  mesh: z.string().max(1024).optional(),
  collision: z.boolean().optional(), gravity: z.boolean().optional(), fixed: z.boolean().optional(),
  staticShadow: z.boolean().optional(), mass: finite.min(0).max(1000000).optional(),
  friction: finite.min(0).max(1000).optional(), restitution: finite.min(0).max(1).optional(),
  metalness: color.optional(), shininess: finite.min(0).max(1000).optional(), emissive: finite.min(0).max(1000).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one property');
export const entityPatchSchema = z.object({ expectedRevision: z.string(), patches: z.array(z.object({
  entityId: z.string().min(1), properties,
}).strict()).min(1).max(64) }).strict();
type Patch = { entityId: string; properties: Record<string, any>; treeName?: string };
type Snapshot = { tree: Record<string, any>; assets: Record<string, any> };

function stable(value: any): any {
  return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
/**
 * `value.bounds` is a bake artifact: saving the project recomputes it from the
 * mesh (internals/build-system/project/bake.ts). Hashing it made every applied
 * entity write look stale after one save, so durable inverses could never be
 * replayed. It stays in the snapshot for reading, but not in the CAS identity;
 * mesh and scale — the inputs the bake derives it from — remain hashed.
 */
function revisionView(snapshot: Snapshot): Snapshot {
  const tree: Record<string, any> = {};
  for (const [id, node] of Object.entries(snapshot.tree)) {
    const value = (node as any)?.value;
    if (!value || typeof value !== 'object') { tree[id] = node; continue; }
    const { bounds, ...rest } = value;
    void bounds;
    tree[id] = { ...(node as any), value: rest };
  }
  return { tree, assets: snapshot.assets };
}

export function entitySnapshotRevision(snapshot: Snapshot) { return createHash('sha256').update(JSON.stringify(stable(revisionView(snapshot)))).digest('hex'); }
const revisionOf = entitySnapshotRevision;

export function readEntitySnapshot(state: EditServerState): Snapshot {
  const stores = state.replica.projectStore?.stores;
  if (!stores?.entitiesTree || !stores.assets) throw authoringError('STATE_UNAVAILABLE', 'Authoritative entity and asset stores are required');
  const tree = stores.entitiesTree.state(EntitiesTreeRDA, EntitiesTreeRDA.stateSchema.alloc());
  const assets = stores.assets.state(AssetsRDA, AssetsRDA.stateSchema.alloc());
  try {
    const result = { tree: EntitiesTreeRDA.stateSchema.toJSON(tree), assets: AssetsRDA.stateSchema.toJSON(assets) } as Snapshot;
    if (Object.keys(result.tree).length > 10000 || Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
      throw authoringError('ENTITY_SCOPE_TOO_LARGE', 'Entity/asset snapshot exceeds bounded editing budget');
    return result;
  } finally { EntitiesTreeRDA.stateSchema.free(tree); AssetsRDA.stateSchema.free(assets); }
}
export const entityRevision = (state: EditServerState) => revisionOf(readEntitySnapshot(state));

/** Fresh action builders for every property; no shared outer action mutation. */
function buildActions(api: () => any, patches: Patch[], tree: Snapshot['tree']): any[] {
  const actions: any[] = [];
  for (const patch of patches) {
    for (const [key, value] of Object.entries(patch.properties)) {
      actions.push(key === 'tags' ? api().update(patch.entityId).tags.splice(0, tree[patch.entityId].value.tags.length, ...value)
        : api().update(patch.entityId)[key](value));
    }
    if (patch.treeName !== undefined || patch.properties.name !== undefined)
      actions.push(api().rename([{ nodeId: patch.entityId, newName: patch.treeName ?? patch.properties.name }]));
  }
  return actions;
}

function validateTargets(snapshot: Snapshot, patches: Patch[], restoring = false) {
  const ids = new Set<string>();
  for (const patch of patches) {
    if (ids.has(patch.entityId)) throw authoringError('ENTITY_PATCH_AMBIGUOUS', 'Combine each entity into one property patch');
    ids.add(patch.entityId);
    const node = snapshot.tree[patch.entityId];
    if (!node || node.type !== TreeNodeType.leaf || !node.value) throw authoringError('ENTITY_NOT_FOUND', 'Target must be an existing leaf entity');
    if (node.value.editLock) throw authoringError('ENTITY_LOCKED', 'Unlock this entity in the editor before modifying it');
    const mesh = patch.properties.mesh;
    if (!restoring && mesh && (!snapshot.assets[mesh] || ![AssetType.VOXEL_MODEL, AssetType.GLTF_MODEL].includes(snapshot.assets[mesh].type)
      || !snapshot.assets[mesh].hash)) throw authoringError('MODEL_NOT_FOUND', 'New mesh must reference an existing model asset with content in this project');
  }
}

function simulate(snapshot: Snapshot, patches: Patch[]) {
  const tree = EntitiesTreeRDA.stateSchema.fromJSON(snapshot.tree);
  const store = EntitiesTreeRDA.createStore(tree);
  EntitiesTreeRDA.stateSchema.free(tree);
  const actions = buildActions(() => EntitiesTreeRDA.action(store), patches, snapshot.tree);
  try {
    for (const action of actions) store.apply(EntitiesTreeRDA, action);
    const next = store.state(EntitiesTreeRDA, EntitiesTreeRDA.stateSchema.alloc());
    try { return { tree: EntitiesTreeRDA.stateSchema.toJSON(next), assets: snapshot.assets } as Snapshot; }
    finally { EntitiesTreeRDA.stateSchema.free(next); }
  } finally { for (const action of actions) EntitiesTreeRDA.actionSchema.free(action); store.free(EntitiesTreeRDA); }
}

export function createEntityContentDomain(state: EditServerState, replica: EditReplicaServer): ContentDomain {
  const revision = () => entityRevision(state);
  const running = () => !!state.game.state.replica.running;
  async function prepare(raw: Record<string, any>) {
    const args = entityPatchSchema.parse(raw);
    const before = readEntitySnapshot(state);
    const baseRevision = revisionOf(before);
    if (args.expectedRevision !== baseRevision) throw authoringError('REVISION_CONFLICT', 'Entities or assets changed after reading');
    validateTargets(before, args.patches);
    const after = simulate(before, args.patches);
    const inverse: Patch[] = args.patches.map(patch => ({ entityId: patch.entityId,
      properties: Object.fromEntries(Object.keys(patch.properties).map(key => [key, before.tree[patch.entityId].value[key]])),
      ...(patch.properties.name !== undefined ? { treeName: before.tree[patch.entityId].name } : {}),
    }));
    return { baseRevision, step: { patches: args.patches, resultRevision: revisionOf(after) },
      preview: { kind: 'entities', changes: args.patches.map(patch => ({ entityId: patch.entityId,
        name: before.tree[patch.entityId].value.name, parentId: before.tree[patch.entityId].parentId,
        properties: Object.keys(patch.properties).map(key => ({ key, before: before.tree[patch.entityId].value[key], after: after.tree[patch.entityId].value[key] })),
      })) }, undoToken: JSON.stringify({ version: 1, patches: inverse, resultRevision: baseRevision }) };
  }
  async function commit(step: Record<string, any>, expected: string, restoring = false) {
    let mutationStarted = false;
    try {
      const newRevision = await replica.authoringProjectTransaction(() => {
        if (running()) throw authoringError('PREVIEW_RUNNING', 'Stop preview before editing entities');
        if (revision() !== expected) throw authoringError('REVISION_CONFLICT', 'Entities or assets changed while waiting for the project mutex');
        validateTargets(readEntitySnapshot(state), step.patches, restoring);
      }, () => {
        const current = readEntitySnapshot(state);
        if (revisionOf(simulate(current, step.patches)) !== step.resultRevision)
          throw authoringError('INVALID_ENTITY_PLAN', 'Entity plan does not match the reviewed result');
        const actions = buildActions(() => ProjectRDA.action(state.replica.projectStore).entitiesTree, step.patches, current.tree);
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
  return { revision, prepare, apply: commit, revert: (token, expected) => {
    const inverse = JSON.parse(token);
    if (inverse.version !== 1) throw authoringError('INVALID_UNDO_TOKEN', 'Unsupported entity inverse version');
    return commit(inverse, expected, true);
  } };
}
