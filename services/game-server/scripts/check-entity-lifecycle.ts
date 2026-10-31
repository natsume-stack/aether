import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectRDA,
  EntitySeedRDA,
  EntitiesTreeRDA,
  AssetEntryRDA,
  AssetType,
} from '@box/schema/project/project-rda';
import { ROOT_ID, TreeNodeType } from '@box/schema/project/murda-tree';
import { Semaphore } from '@box/utils/semaphore';
import { EditReplicaServer } from '../src/edit/replica/replica-server';
import { createEntityContentDomain, entityRevision, readEntitySnapshot } from '../src/edit/ai/entity-content-domain';
import { createEntityLifecycleDomain, entityLifecycleSchema } from '../src/edit/ai/entity-lifecycle-domain';
import { AuthoringSession } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';

/**
 * Entity lifecycle integration against a real ProjectRDA.
 *
 * Proves: create/delete go through the production project mutex, keep unrelated
 * nodes untouched, produce exact inverse data that survives a serialized store
 * and a journal reopen, and refuse locked entities, subtrees, the scene root and
 * unknown models. Reparenting is deliberately out of scope.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-entity-lifecycle-'));
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);

  const model = AssetEntryRDA.stateSchema.clone(AssetEntryRDA.stateSchema.identity);
  model.type = AssetType.VOXEL_MODEL;
  model.hash = 'fixture-content';
  project.assets['mesh/hut.vb'] = model;
  const image = AssetEntryRDA.stateSchema.clone(AssetEntryRDA.stateSchema.identity);
  image.type = AssetType.IMAGE;
  image.hash = 'picture-content';
  project.assets['picture/hut.png'] = image;

  const makeLeaf = (id: string, parentId = ROOT_ID) => {
    const node = EntitiesTreeRDA.nodeSchema.alloc();
    node.id = id;
    node.name = id;
    node.parentId = parentId;
    node.type = TreeNodeType.leaf;
    node.value = EntitySeedRDA.stateSchema.clone(EntitySeedRDA.stateSchema.identity);
    node.value.name = id;
    node.value.position = [1, 2, 3];
    node.value.scale = [1, 1, 1];
    node.value.orientation = [0, 0, 0, 1];
    node.value.mesh = 'mesh/legacy.vb';
    project.entitiesTree[id] = node;
    project.entitiesTree[parentId].childrenIds.push(id);
    return node;
  };
  makeLeaf('existing');
  const locked = makeLeaf('locked');
  locked.value!.editLock = true;
  const withChild = makeLeaf('parent', ROOT_ID);
  withChild.type = TreeNodeType.node;
  makeLeaf('child', 'parent');

  const state: any = {
    replica: { project, projectStore: ProjectRDA.createStore(project) },
    game: { state: { replica: { running: false } } },
  };
  const mutex = new Semaphore();
  let broadcasts = 0;
  const replica: any = {
    _projectSemaphore: mutex,
    _state: state,
    _setProjectDirty() {},
    _syncLocalProjectModelMembership() {},
    _protocol: { broadcast: { project() { broadcasts++; } } },
    authoringProjectTransaction: EditReplicaServer.prototype.authoringProjectTransaction,
  };

  let journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
  const build = () => {
    const session = new AuthoringSession(async () => ({ success: false, code: 'UNUSED' }));
    session.registerDomain('entities', createEntityContentDomain(state, replica));
    session.registerDomain('entityLifecycle', createEntityLifecycleDomain(state, replica));
    session.attachJournal(journal);
    return session;
  };
  let session = build();
  const original = readEntitySnapshot(state);

  try {
    // Schema is strict: unknown keys and empty plans are refused before any work.
    assert.throws(() => entityLifecycleSchema.parse({ expectedRevision: 'x', operations: [] }));
    assert.throws(() => entityLifecycleSchema.parse({ expectedRevision: 'x', operations: [{ op: 'create', name: 'a', hidden: 1 }] }));

    // 1. Create a leaf with a real model asset, then delete it; both inverse-able.
    const created = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'create', name: '休息点', parentId: ROOT_ID, position: [4, 23, 5], mesh: 'mesh/hut.vb', tags: ['rest'] }],
    });
    const preview = created.previews[0];
    assert.equal(preview.operations[0].op, 'create');
    assert.equal(preview.createdCount, 1);
    assert.deepEqual(readEntitySnapshot(state), original, 'proposal must not write');

    const applied = await session.applyProposal(created.proposalId);
    assert.equal(applied.success, true, 'create apply');
    const createdId = preview.operations[0].entityId as string;
    const afterCreate = readEntitySnapshot(state);
    assert.equal(afterCreate.tree[createdId].value.name, '休息点');
    assert.deepEqual(afterCreate.tree[createdId].value.position, [4, 23, 5]);
    assert.equal(afterCreate.tree[createdId].value.mesh, 'mesh/hut.vb');
    assert.deepEqual(afterCreate.tree[createdId].value.tags, ['rest']);
    assert.deepEqual(afterCreate.tree.existing, original.tree.existing, 'unrelated entity untouched');
    const revisionAfterApply = entityRevision(state);

    // Serialize the store the way a save does, reopen the journal, then undo.
    const saved = state.replica.projectStore.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
    const reloaded = ProjectRDA.stateSchema.fromJSON(ProjectRDA.stateSchema.toJSON(saved));
    ProjectRDA.stateSchema.free(saved);
    state.replica.projectStore.free(ProjectRDA);
    state.replica.projectStore = ProjectRDA.createStore(reloaded);
    ProjectRDA.stateSchema.free(reloaded);
    journal.close();
    journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
    session = build();
    assert.equal(entityRevision(state), revisionAfterApply, 'entity revision survives serialize + store rebuild');
    assert.equal(session.proposal(created.proposalId).status, 'applied');
    const reverted = await session.revertProposal(created.proposalId);
    assert.equal(reverted.success, true, 'create revert');
    assert.equal(readEntitySnapshot(state).tree[createdId], undefined, 'created entity removed by inverse');
    assert.deepEqual(readEntitySnapshot(state), original, 'tree returns to its original content');

    // 2. Delete an existing leaf and restore it with the full node value.
    const deletion = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'delete', entityId: 'existing' }],
    });
    assert.equal(deletion.previews[0].deletedCount, 1);
    assert.equal((await session.applyProposal(deletion.proposalId)).success, true, 'delete apply');
    assert.equal(readEntitySnapshot(state).tree.existing, undefined);
    const deletionRevert = await session.revertProposal(deletion.proposalId);
    assert.equal(deletionRevert.success, true, 'delete revert');
    const restored = readEntitySnapshot(state);
    assert.deepEqual(restored.tree.existing, original.tree.existing, 'deleted entity restored with its original value');
    assert.deepEqual(
      [...(restored.tree[ROOT_ID].childrenIds as string[])].sort(),
      [...(original.tree[ROOT_ID].childrenIds as string[])].sort(),
      'restored entity returns to the root child set (order may change)',
    );

    // 3. Refusals: locked target, subtree, root, unknown model, missing parent.
    const attempt = (operations: any[]) => session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state), operations,
    });
    await assert.rejects(attempt([{ op: 'delete', entityId: 'locked' }]), /Unlock this entity/);
    await assert.rejects(attempt([{ op: 'delete', entityId: ROOT_ID }]), /scene root/);
    await assert.rejects(
      attempt([{ op: 'create', name: 'x', mesh: 'picture/hut.png' }]),
      /model asset/,
    );
    await assert.rejects(
      attempt([{ op: 'create', name: 'x', parentId: 'missing-parent' }]),
      /Parent node does not exist/,
    );
    // A parent with children cannot be deleted without naming the branch.
    await assert.rejects(attempt([{ op: 'delete', entityId: 'parent' }]), /pass subtree:true/);

    // 4. Reparent an existing entity and move it back with the inverse.
    const moveArgs = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'move', entityId: 'existing', parentId: 'parent' }],
    });
    assert.equal(moveArgs.previews[0].movedCount, 1);
    const moveResult = await session.applyProposal(moveArgs.proposalId);
    if (moveResult.success !== true) console.error('MOVE_FAILED', JSON.stringify(moveResult));
    assert.equal(moveResult.success, true, 'move apply');
    assert.equal(readEntitySnapshot(state).tree.existing.parentId, 'parent');
    assert.ok(readEntitySnapshot(state).tree.parent.childrenIds.includes('existing'));
    assert.equal((await session.revertProposal(moveArgs.proposalId)).success, true, 'move revert');
    assert.equal(readEntitySnapshot(state).tree.existing.parentId, ROOT_ID);
    assert.deepEqual(readEntitySnapshot(state).tree.existing, original.tree.existing);

    // 5. Deleting a branch needs subtree:true and restores the hierarchy.
    await assert.rejects(attempt([{ op: 'delete', entityId: 'parent' }]), /subtree:true/);
    const branch = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'delete', entityId: 'parent', subtree: true }],
    });
    assert.equal(branch.previews[0].deletedCount, 2);
    const branchResult = await session.applyProposal(branch.proposalId);
    if (branchResult.success !== true) console.error('BRANCH_FAILED', JSON.stringify(branchResult));
    assert.equal(branchResult.success, true, 'branch apply');
    const afterBranch = readEntitySnapshot(state);
    assert.equal(afterBranch.tree.parent, undefined);
    assert.equal(afterBranch.tree.child, undefined);
    const branchRevert = await session.revertProposal(branch.proposalId);
    if (branchRevert.success !== true) console.error('BRANCH_REVERT', JSON.stringify(branchRevert));
    assert.equal(branchRevert.success, true, 'branch revert');
    const restoredBranch = readEntitySnapshot(state);
    assert.equal(restoredBranch.tree.child.parentId, 'parent');
    assert.ok(restoredBranch.tree.parent.childrenIds.includes('child'));
    assert.deepEqual(restoredBranch.tree.child.value, original.tree.child.value);

    // 6. Cycle and no-op moves are refused before any write.
    await assert.rejects(attempt([{ op: 'move', entityId: 'parent', parentId: 'child' }]), /descendant/);
    await assert.rejects(attempt([{ op: 'move', entityId: 'existing', parentId: ROOT_ID }]), /already has this parent/);
    await assert.rejects(attempt([{ op: 'move', entityId: ROOT_ID, parentId: 'parent' }]), /scene root/);

    assert.ok(broadcasts > 0, 'writes broadcast to editors');
    console.log(JSON.stringify({ ok: true, broadcasts }, null, 2));
  } finally {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
