import assert from 'node:assert/strict';
import {
  ProjectRDA,
} from '@box/schema/project/project-rda';
import { UITreeRDA, UITextRDA, DEFAULT_SCREEN_ID } from '@box/schema/project/ui-rda/defs';
import { TreeNodeType } from '@box/schema/project/murda-tree';
import { Semaphore } from '@box/utils/semaphore';
import { EditReplicaServer } from '../src/edit/replica/replica-server';
import { createUiContentDomain, readUiContent, uiContentRevision } from '../src/edit/ai/ui-content-domain';
import { createTerrainContentDomain } from '../src/edit/ai/terrain-content-domain';
import { AuthoringSession } from '../src/edit/ai/authoring-session';

/**
 * Terrain as a cross-domain plan member, proven against a deterministic
 * in-memory voxel world that mirrors `terrainApply`'s CAS + undoToken contract.
 *
 * What this proves: a terrain fill proposal and a UI property proposal can be
 * reviewed as one plan, applied in order (terrain + UI both change), and
 * reverted in reverse (both restored) — the thing GOAL defect #3 says was
 * impossible while terrain was not a ContentDomain.
 * What this does not prove: real voxel packing on a live map or visual quality.
 */
function makeTerrain() {
  const shape: [number, number, number] = [8, 8, 8];
  const cells = new Map<string, number>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const get = (x: number, y: number, z: number) => cells.get(key(x, y, z)) ?? 0;
  const revision = () => {
    let h = 0;
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 8; z++) h = (h * 31 + get(x, y, z)) | 0;
    return 'rev' + h;
  };
  const invoke = async (tool: string, args: any) => {
    if (tool === 'terrainInfo') return { success: true, revision: revision(), shape };
    if (tool === 'terrainApply') {
      const { region, block, expectedRevision, dryRun } = args;
      if (expectedRevision && expectedRevision !== revision()) {
        return { success: false, code: 'REVISION_CONFLICT', newRevision: revision(), undoToken: '[]' };
      }
      const pts: [number, number, number][] = [];
      for (let x = region.min[0]; x <= region.max[0]; x++)
        for (let y = region.min[1]; y <= region.max[1]; y++)
          for (let z = region.min[2]; z <= region.max[2]; z++) pts.push([x, y, z]);
      if (dryRun) {
        const changed = pts.filter(([x, y, z]) => get(x, y, z) !== block).length;
        return { success: true, changed, rejected: 0, changedBounds: region, newRevision: revision(), undoToken: '[]' };
      }
      const undo = pts.map(([x, y, z]) => [x, y, z, get(x, y, z)]);
      for (const [x, y, z] of pts) cells.set(key(x, y, z), block);
      return { success: true, changed: pts.length, rejected: 0, changedBounds: region, newRevision: revision(), undoToken: JSON.stringify(undo) };
    }
    if (tool === 'terrainRevert') {
      const undo = JSON.parse(args.undoToken) as number[][];
      for (const [x, y, z, b] of undo) cells.set(key(x, y, z), b);
      return { success: true, newRevision: revision() };
    }
    throw new Error('unexpected tool ' + tool);
  };
  return { shape, get, revision, invoke };
}

async function main() {
  const terrain = makeTerrain();
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);
  const title = UITreeRDA.nodeSchema.alloc();
  title.id = 'title';
  title.name = 'title';
  title.type = TreeNodeType.node;
  title.parentId = DEFAULT_SCREEN_ID;
  title.value = { type: 'element', data: { type: 'text', data: UITextRDA.stateSchema.clone(UITextRDA.stateSchema.identity) } } as any;
  project.uiTree.title = title;
  project.uiTree[DEFAULT_SCREEN_ID].childrenIds.push('title');

  const state: any = {
    replica: { project, projectStore: ProjectRDA.createStore(project) },
    game: { state: { replica: { running: false } } },
  };
  const replica: any = {
    _projectSemaphore: new Semaphore(),
    _state: state,
    _setProjectDirty() {},
    _syncLocalProjectModelMembership() {},
    _protocol: { broadcast: { project() {} } },
    authoringProjectTransaction: EditReplicaServer.prototype.authoringProjectTransaction,
  };

  const session = new AuthoringSession(terrain.invoke as any);
  session.registerDomain('terrain', createTerrainContentDomain(terrain.invoke as any));
  session.registerDomain('ui', createUiContentDomain(state, replica));

  const rev0 = terrain.revision();
  const terrainProp = await session.proposeContent('terrain', {
    expectedRevision: rev0,
    step: { args: { region: { min: [1, 1, 1], max: [2, 2, 2] }, block: 5 } },
  });
  assert.equal(terrainProp.success, true);
  assert.equal(terrain.get(1, 1, 1), 0, 'proposal must never write terrain');

  const uiBefore = readUiContent(state);
  const uiProp = await session.proposeContent('ui', {
    expectedRevision: uiContentRevision(uiBefore),
    patches: [{ nodeId: 'title', properties: { textContent: '平台+摆件+标签' } }],
  });
  assert.equal(uiProp.success, true);

  const plan = await session.proposePlan([terrainProp.proposalId, uiProp.proposalId]);
  assert.equal((plan as any).members.length, 2);

  const applied = await session.applyPlan((plan as any).planId);
  assert.equal((applied as any).success, true, JSON.stringify(applied));
  assert.equal(terrain.get(1, 1, 1), 5, 'terrain fill applied');
  assert.equal(readUiContent(state).title.value.data.data.textContent, '平台+摆件+标签', 'ui applied');
  assert.equal(session.plan((plan as any).planId).status, 'applied');

  const reverted = await session.revertPlan((plan as any).planId);
  assert.equal((reverted as any).success, true, JSON.stringify(reverted));
  assert.equal(terrain.get(1, 1, 1), 0, 'terrain reverted');
  assert.deepEqual(readUiContent(state), uiBefore, 'ui reverted');
  assert.equal(session.plan((plan as any).planId).status, 'reverted');

  console.log(JSON.stringify({ ok: true, rev0, revAfterRevert: terrain.revision() }));
}

main().catch((error) => { console.error(error); process.exit(1); });
