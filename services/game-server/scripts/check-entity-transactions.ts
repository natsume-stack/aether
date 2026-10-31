import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRDA, EntitySeedRDA, EntitiesTreeRDA, AssetEntryRDA, AssetType } from '@box/schema/project/project-rda';
import { ROOT_ID, TreeNodeType } from '@box/schema/project/murda-tree';
import { Semaphore } from '@box/utils/semaphore';
import { EditReplicaServer } from '../src/edit/replica/replica-server';
import { createEntityTools } from '../src/edit/ai/entity-tools';
import { coordinateAuthoring, authoringSessionFor } from '../src/edit/ai/authoring-tools';
import { createEntityContentDomain, entityRevision, readEntitySnapshot } from '../src/edit/ai/entity-content-domain';
import { AuthoringSession } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-entity-tx-'));
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);
  for (const [name, type] of [['mesh/fixture.vb', AssetType.VOXEL_MODEL], ['picture/fixture.png', AssetType.IMAGE]] as const) {
    const asset = AssetEntryRDA.stateSchema.clone(AssetEntryRDA.stateSchema.identity);
    asset.type = type; asset.hash = 'fixture-content';
    project.assets[name] = asset;
  }
  for (const id of ['one', 'two']) {
    const node = EntitiesTreeRDA.nodeSchema.alloc();
    node.id = id; node.name = id; node.parentId = ROOT_ID; node.type = TreeNodeType.leaf;
    node.value = EntitySeedRDA.stateSchema.clone(EntitySeedRDA.stateSchema.identity);
    node.value.name = id;
    node.value.position = [1, 2, 3];
    node.value.scale = [1, 1, 1];
    node.value.orientation = [0, 0, 0, 1];
    node.value.mesh = 'mesh/legacy-missing.vb';
    project.entitiesTree[id] = node;
    project.entitiesTree[ROOT_ID].childrenIds.push(id);
  }
  const state: any = { replica: { project, projectStore: ProjectRDA.createStore(project) },
    game: { state: { replica: { running: false } } } };
  const mutex = new Semaphore();
  let broadcasts = 0;
  const replica: any = { _projectSemaphore: mutex, _state: state,
    _setProjectDirty() {}, _syncLocalProjectModelMembership() {}, _protocol: { broadcast: { project() { broadcasts++; } } },
    authoringProjectTransaction: EditReplicaServer.prototype.authoringProjectTransaction };
  const tools = coordinateAuthoring(state, createEntityTools(replica, state, 1, { info() {} } as any));
  const invoke = (name: keyof typeof tools, args: any, operationId: string = name) => (tools[name].execute as any)(args, { toolCallId: operationId, messages: [] });
  const session = authoringSessionFor(state)!;
  const journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
  session.attachJournal(journal);
  let recoveredJournal: AuthoringJournal | undefined;
  try {
    const original = readEntitySnapshot(state);
    const before = entityRevision(state);
    const context = await invoke('entityContext', { limit: 1, offset: 0 });
    assert.equal(context.total, 2);
    assert.equal(context.entities.length, 1);
    const args = { expectedRevision: before, patches: [{ entityId: 'one', properties: {
      name: '新的实体', position: [12.5, 8, 4], scale: [2, 1, 2], tags: ['coauthored'], mesh: 'mesh/fixture.vb',
    } }] };
    const proposal = await invoke('authoringProposeEntities', args);
    assert.equal(entityRevision(state), before, 'Proposal simulation never writes real store');
    assert.equal(proposal.previews[0].changes[0].entityId, 'one');
    assert.equal((await invoke('authoringApply', { proposalId: proposal.proposalId }, 'apply')).success, true);
    const after = readEntitySnapshot(state);
    assert.equal(after.tree.one.value.name, '新的实体');
    assert.equal(after.tree.one.name, '新的实体');
    assert.deepEqual(after.tree.one.value.position, [12.5, 8, 4]);
    assert.equal(after.tree.one.value.mesh, 'mesh/fixture.vb');
    assert.deepEqual(after.tree.two, original.tree.two);
    assert.deepEqual(after.tree[ROOT_ID], original.tree[ROOT_ID]);
    const count = broadcasts;
    await invoke('authoringApply', { proposalId: proposal.proposalId }, 'apply');
    assert.equal(broadcasts, count);
    assert.ok(session.events().events.filter(row => row.operationId === 'apply').every(row => row.kind === 'entities'));
    journal.close();
    // Production persistence serializes project state, dropping RDA tombstones.
    // Recover from that representation, not a retained in-memory action store.
    const saved = state.replica.projectStore.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
    const reloaded = ProjectRDA.stateSchema.fromJSON(ProjectRDA.stateSchema.toJSON(saved));
    ProjectRDA.stateSchema.free(saved);
    state.replica.projectStore.free(ProjectRDA);
    state.replica.projectStore = ProjectRDA.createStore(reloaded);
    ProjectRDA.stateSchema.free(reloaded);
    const restored: AuthoringSession = new AuthoringSession(async (tool, args) => tool === 'authoringApply'
      ? restored.applyProposal(args.proposalId) : restored.revertProposal(args.proposalId));
    restored.registerDomain('entities', createEntityContentDomain(state, replica));
    recoveredJournal = new AuthoringJournal(path.join(root, 'map.jsonl'));
    restored.attachJournal(recoveredJournal);
    assert.equal(restored.proposal(proposal.proposalId).status, 'applied');
    assert.equal((await restored.perform('authoringRevert', { proposalId: proposal.proposalId }, 'revert')).success, true);
    assert.equal(entityRevision(state), before);
    assert.deepEqual(readEntitySnapshot(state), original);
    const race = await restored.proposeContent('entities', args);
    await mutex.p();
    const pending = restored.perform('authoringApply', { proposalId: race.proposalId }, 'race');
    await Promise.resolve(); await Promise.resolve();
    const humanAction = ProjectRDA.action(state.replica.projectStore).entitiesTree.update('one').position([99, 2, 3]);
    state.replica.projectStore.apply(ProjectRDA, humanAction);
    ProjectRDA.actionSchema.free(humanAction);
    mutex.v();
    const refused = await pending;
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'REVISION_CONFLICT');
    assert.equal(restored.proposal(race.proposalId).status, 'proposed');
    assert.deepEqual(readEntitySnapshot(state).tree.one.value.position, [99, 2, 3]);
    await assert.rejects(restored.proposeContent('entities', args), { code: 'REVISION_CONFLICT' });
    const revision = entityRevision(state);
    await assert.rejects(restored.proposeContent('entities', { expectedRevision: revision,
      patches: [{ entityId: 'one', properties: { mesh: 'mesh/not-in-project.vb' } }] }), { code: 'MODEL_NOT_FOUND' });
    await assert.rejects(restored.proposeContent('entities', { expectedRevision: revision,
      patches: [{ entityId: 'one', properties: { mesh: 'picture/fixture.png' } }] }), { code: 'MODEL_NOT_FOUND' });
    await assert.rejects(restored.proposeContent('entities', { expectedRevision: revision,
      patches: [{ entityId: 'one', properties: { position: [Infinity, 0, 0] } }] }));
    state.game.state.replica.running = true;
    const preview = await restored.proposeContent('entities', { ...args, expectedRevision: revision });
    assert.equal((await restored.perform('authoringApply', { proposalId: preview.proposalId }, 'preview')).code, 'PREVIEW_RUNNING');
    state.game.state.replica.running = false;
    const lock = ProjectRDA.action(state.replica.projectStore).entitiesTree.update('one').editLock(true);
    state.replica.projectStore.apply(ProjectRDA, lock); ProjectRDA.actionSchema.free(lock);
    await assert.rejects(restored.proposeContent('entities', { ...args, expectedRevision: entityRevision(state) }), { code: 'ENTITY_LOCKED' });
    const output = path.resolve(process.cwd(), '../../.local-evidence/entity-transactions-integration.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), passed: true,
      scope: 'Actual ProjectRDA fixture and production guarded commit; not a live-map scene edit',
      checks: ['bounded source read', 'proposal does not write', 'property diff', 'stable IDs and parent order',
        'unrelated entity unchanged', 'operation deduplication', 'project-state serialization and inverse recovery',
        'legacy unresolved mesh preserved by exact inverse', 'human edit while waiting for mutex refused',
        'nonfinite positions refused', 'missing new model refused', 'preview refused', 'editLock respected'],
    }, null, 2));
  } finally {
    recoveredJournal?.close(); journal.close(); state.replica.projectStore.free(ProjectRDA);
    ProjectRDA.stateSchema.free(project); fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS entity transactions: actual RDA, checked property proposals, guarded commits, stable hierarchy, durable inverse and conflicts');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
