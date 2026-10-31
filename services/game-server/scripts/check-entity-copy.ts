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
import {
  UITreeRDA,
  UITextRDA,
  DEFAULT_SCREEN_ID,
} from '@box/schema/project/ui-rda/defs';
import { ROOT_ID, TreeNodeType } from '@box/schema/project/murda-tree';
import { Semaphore } from '@box/utils/semaphore';
import { EditReplicaServer } from '../src/edit/replica/replica-server';
import { entityRevision, readEntitySnapshot } from '../src/edit/ai/entity-content-domain';
import { createEntityLifecycleDomain, entityLifecycleSchema } from '../src/edit/ai/entity-lifecycle-domain';
import { createUiContentDomain, readUiContent, uiContentRevision } from '../src/edit/ai/ui-content-domain';
import { AuthoringSession } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';

/**
 * Entity copy integration against a real ProjectRDA.
 *
 * Proves: a leaf copy keeps the full node value (mesh and gameplay properties),
 * applies an optional position offset under the source or an explicit parent,
 * uses entity/asset CAS, survives a serialized store and journal reopen, can be
 * reverted to the exact prior revision, joins a cross-domain plan, and refuses
 * locked/non-leaf/root/unknown sources. Subtree copies are deliberately out of
 * scope; copying a group must be expressed as copies of its leaves.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-entity-copy-'));
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);

  const model = AssetEntryRDA.stateSchema.clone(AssetEntryRDA.stateSchema.identity);
  model.type = AssetType.VOXEL_MODEL;
  model.hash = 'fixture-content';
  project.assets['mesh/hut.vb'] = model;

  const makeLeaf = (id: string, parentId = ROOT_ID) => {
    const node = EntitiesTreeRDA.nodeSchema.alloc();
    node.id = id;
    node.name = id;
    node.parentId = parentId;
    node.type = TreeNodeType.leaf;
    node.value = EntitySeedRDA.stateSchema.clone(EntitySeedRDA.stateSchema.identity);
    node.value.name = id;
    node.value.position = [1, 2, 3];
    node.value.scale = [0.5, 0.5, 0.5];
    node.value.orientation = [0, 0, 0, 1];
    node.value.mesh = 'mesh/hut.vb';
    node.value.tags = ['rest', 'lamp'];
    node.value.mass = 12;
    node.value.friction = 0.7;
    node.value.collision = false;
    project.entitiesTree[id] = node;
    project.entitiesTree[parentId].childrenIds.push(id);
    return node;
  };
  makeLeaf('existing');
  const locked = makeLeaf('locked');
  locked.value!.editLock = true;
  const group = makeLeaf('group');
  group.type = TreeNodeType.node;
  group.value = undefined;
  makeLeaf('child', 'group');

  const title = UITreeRDA.nodeSchema.alloc();
  title.id = 'title';
  title.name = 'title';
  title.type = TreeNodeType.node;
  title.parentId = DEFAULT_SCREEN_ID;
  title.value = {
    type: 'element',
    data: { type: 'text', data: UITextRDA.stateSchema.clone(UITextRDA.stateSchema.identity) },
  };
  project.uiTree.title = title;
  project.uiTree[DEFAULT_SCREEN_ID].childrenIds.push('title');

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
    session.registerDomain('entityLifecycle', createEntityLifecycleDomain(state, replica));
    session.registerDomain('ui', createUiContentDomain(state, replica));
    session.attachJournal(journal);
    return session;
  };
  let session = build();
  const original = readEntitySnapshot(state);
  const revisionBefore = entityRevision(state);
  const uiBefore = readUiContent(state);

  const attempt = (operations: any[]) => session.proposeContent('entityLifecycle', {
    expectedRevision: entityRevision(state), operations,
  });

  try {
    // Schema is strict: unknown keys and empty plans are refused before any work.
    assert.throws(() => entityLifecycleSchema.parse({ expectedRevision: 'x', operations: [] }));
    assert.throws(() => entityLifecycleSchema.parse({ expectedRevision: 'x', operations: [{ op: 'copy', entityId: 'existing', hidden: 1 }] }));

    // 1. Copy a leaf with a name and position offset; full value must survive.
    const copied = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'copy', entityId: 'existing', name: 'existing-copy', positionOffset: [2, 0, -1] }],
    });
    const preview = copied.previews[0];
    assert.equal(preview.operations[0].op, 'copy');
    assert.equal(preview.operations[0].sourceEntityId, 'existing');
    assert.equal(preview.copiedCount, 1);
    assert.equal(preview.createdCount, 1);
    assert.deepEqual(readEntitySnapshot(state), original, 'proposal must not write');
    const copyId = preview.operations[0].entityId as string;
    assert.notEqual(copyId, 'existing');

    const applied = await session.applyProposal(copied.proposalId);
    if (applied.success !== true) console.error('COPY_APPLY_FAILED', JSON.stringify(applied));
    assert.equal(applied.success, true, 'copy apply');
    const afterCopy = readEntitySnapshot(state);
    assert.equal(afterCopy.tree[copyId].name, 'existing-copy');
    assert.equal(afterCopy.tree[copyId].parentId, ROOT_ID);
    assert.deepEqual(afterCopy.tree[copyId].value.position, [3, 2, 2]);
    assert.equal(afterCopy.tree[copyId].value.mesh, 'mesh/hut.vb');
    assert.deepEqual(afterCopy.tree[copyId].value.scale, [0.5, 0.5, 0.5]);
    assert.deepEqual(afterCopy.tree[copyId].value.tags, ['rest', 'lamp']);
    assert.equal(afterCopy.tree[copyId].value.mass, 12);
    assert.equal(afterCopy.tree[copyId].value.friction, 0.7);
    assert.equal(afterCopy.tree[copyId].value.collision, false);
    assert.deepEqual(afterCopy.tree.existing, original.tree.existing, 'copy source untouched');
    assert.ok(afterCopy.tree[ROOT_ID].childrenIds.includes(copyId));
    const revisionAfterCopy = entityRevision(state);
    assert.notEqual(revisionAfterCopy, revisionBefore, 'copy changes the entity revision');

    // 2. Serialize the store the way a save does, reopen the journal, then undo.
    const saved = state.replica.projectStore.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
    const reloaded = ProjectRDA.stateSchema.fromJSON(ProjectRDA.stateSchema.toJSON(saved));
    ProjectRDA.stateSchema.free(saved);
    state.replica.projectStore.free(ProjectRDA);
    state.replica.projectStore = ProjectRDA.createStore(reloaded);
    ProjectRDA.stateSchema.free(reloaded);
    journal.close();
    journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
    session = build();
    assert.equal(entityRevision(state), revisionAfterCopy, 'entity revision survives serialize + store rebuild');
    assert.equal(session.proposal(copied.proposalId).status, 'applied');
    const reverted = await session.revertProposal(copied.proposalId);
    if (reverted.success !== true) console.error('COPY_REVERT_FAILED', JSON.stringify(reverted));
    assert.equal(reverted.success, true, 'copy revert');
    assert.equal(readEntitySnapshot(state).tree[copyId], undefined, 'copy removed by inverse');
    assert.deepEqual(readEntitySnapshot(state), original, 'tree returns to its original content');
    assert.equal(entityRevision(state), revisionBefore, 'revert restores the exact prior revision');

    // 3. Copy under an explicit parent, then a later write must block its revert.
    const intoGroup = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'copy', entityId: 'existing', parentId: 'group', name: 'child-copy' }],
    });
    assert.equal(intoGroup.previews[0].operations[0].parentId, 'group');
    assert.equal((await session.applyProposal(intoGroup.proposalId)).success, true, 'copy into group');
    const groupCopyId = intoGroup.previews[0].operations[0].entityId as string;
    const afterGroup = readEntitySnapshot(state);
    assert.equal(afterGroup.tree[groupCopyId].parentId, 'group');
    assert.ok(afterGroup.tree.group.childrenIds.includes(groupCopyId));
    assert.deepEqual(afterGroup.tree[groupCopyId].value.position, [1, 2, 3]);

    const later = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'create', name: 'later', parentId: ROOT_ID }],
    });
    assert.equal((await session.applyProposal(later.proposalId)).success, true, 'later write');
    await assert.rejects(session.revertProposal(intoGroup.proposalId), /changed/);
    assert.equal((await session.revertProposal(later.proposalId)).success, true, 'undo later write');
    const groupRevert = await session.revertProposal(intoGroup.proposalId);
    if (groupRevert.success !== true) console.error('GROUP_REVERT_FAILED', JSON.stringify(groupRevert));
    assert.equal(groupRevert.success, true, 'copy into group reverts once revision is back');
    assert.equal(readEntitySnapshot(state).tree[groupCopyId], undefined);
    assert.deepEqual(readEntitySnapshot(state), original);

    // 4. Several copies in one proposal apply and revert together.
    const multi = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [
        { op: 'copy', entityId: 'existing', name: 'copy-a', positionOffset: [0, 1, 0] },
        { op: 'copy', entityId: 'existing', name: 'copy-b', positionOffset: [-1, 0, 2] },
      ],
    });
    assert.equal(multi.previews[0].copiedCount, 2);
    assert.equal(multi.previews[0].operations.length, 2);
    assert.equal((await session.applyProposal(multi.proposalId)).success, true, 'multi copy');
    const multiIds = multi.previews[0].operations.map((op: any) => op.entityId as string);
    const multiState = readEntitySnapshot(state);
    assert.deepEqual(multiState.tree[multiIds[0]].value.position, [1, 3, 3]);
    assert.deepEqual(multiState.tree[multiIds[1]].value.position, [0, 2, 5]);
    assert.equal(multiState.tree[multiIds[0]].name, 'copy-a');
    assert.equal(multiState.tree[multiIds[1]].name, 'copy-b');
    assert.equal((await session.revertProposal(multi.proposalId)).success, true, 'multi copy revert');
    assert.deepEqual(readEntitySnapshot(state), original);

    // 5. Refusals: locked, non-leaf, root, unknown source, missing parent.
    await assert.rejects(attempt([{ op: 'copy', entityId: 'locked' }]), /Unlock this entity/);
    await assert.rejects(attempt([{ op: 'copy', entityId: 'group' }]), /Only leaf entities/);
    await assert.rejects(attempt([{ op: 'copy', entityId: ROOT_ID }]), /scene root/);
    await assert.rejects(attempt([{ op: 'copy', entityId: 'missing' }]), /Copy source does not exist/);
    await assert.rejects(attempt([{ op: 'copy', entityId: 'existing', parentId: 'missing-parent' }]), /Parent node does not exist/);
    assert.deepEqual(readEntitySnapshot(state), original, 'refusals never write');

    // 6. Copy joins a cross-domain plan with UI and reverts with it.
    const copyMember = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'copy', entityId: 'existing', name: 'plan-copy', positionOffset: [3, 0, 0] }],
    });
    const uiMember = await session.proposeContent('ui', {
      expectedRevision: uiContentRevision(readUiContent(state)),
      patches: [{ nodeId: 'title', properties: { textContent: 'copy plan' } }],
    });
    const plan = await session.proposePlan([copyMember.proposalId, uiMember.proposalId]);
    assert.equal(plan.atomic, false);
    const planApplied = await session.applyPlan(plan.planId);
    if (planApplied.success !== true) console.error('PLAN_APPLY_FAILED', JSON.stringify(planApplied));
    assert.equal(planApplied.success, true, 'plan with copy applies');
    const planCopyId = copyMember.previews[0].operations[0].entityId as string;
    assert.ok(readEntitySnapshot(state).tree[planCopyId], 'plan copy exists');
    assert.equal(readUiContent(state).title.value.data.data.textContent, 'copy plan');
    assert.equal((await session.revertPlan(plan.planId)).success, true, 'plan revert');
    assert.deepEqual(readEntitySnapshot(state), original, 'plan copy reverted');
    assert.deepEqual(readUiContent(state), uiBefore, 'plan UI reverted');

    // 7. A stale copy proposal refuses to apply after later content changes.
    const stale = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'copy', entityId: 'existing', name: 'stale-copy' }],
    });
    const bump = await session.proposeContent('entityLifecycle', {
      expectedRevision: entityRevision(state),
      operations: [{ op: 'create', name: 'bump', parentId: ROOT_ID }],
    });
    assert.equal((await session.applyProposal(bump.proposalId)).success, true);
    await assert.rejects(session.applyProposal(stale.proposalId), /changed/);
    assert.equal((await session.revertProposal(bump.proposalId)).success, true);
    assert.equal(session.discardProposal(stale.proposalId).success, true);

    assert.ok(broadcasts > 0, 'copy writes broadcast to editors');
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
