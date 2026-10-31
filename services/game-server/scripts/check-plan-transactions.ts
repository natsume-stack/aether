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
import { createEntityContentDomain, entityRevision, readEntitySnapshot } from '../src/edit/ai/entity-content-domain';
import { createUiContentDomain, readUiContent, uiContentRevision } from '../src/edit/ai/ui-content-domain';
import { AuthoringSession, ContentDomain } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';

/**
 * Cross-domain plan integration against a real ProjectRDA.
 *
 * What this proves: two different content domains can be reviewed as one plan,
 * applied in order under the production project mutex, compensated when a later
 * member fails, and reverted in reverse when the caller changes its mind.
 * What this does not prove: cross-domain atomicity (there is none), or that the
 * map looks right afterwards.
 */
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-plan-tx-'));
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);

  const asset = AssetEntryRDA.stateSchema.clone(AssetEntryRDA.stateSchema.identity);
  asset.type = AssetType.VOXEL_MODEL;
  asset.hash = 'fixture-content';
  project.assets['mesh/fixture.vb'] = asset;

  for (const id of ['hero']) {
    const node = EntitiesTreeRDA.nodeSchema.alloc();
    node.id = id;
    node.name = id;
    node.parentId = ROOT_ID;
    node.type = TreeNodeType.leaf;
    node.value = EntitySeedRDA.stateSchema.clone(EntitySeedRDA.stateSchema.identity);
    node.value.name = id;
    node.value.position = [1, 2, 3];
    node.value.scale = [1, 1, 1];
    node.value.orientation = [0, 0, 0, 1];
    node.value.mesh = 'mesh/fixture.vb';
    project.entitiesTree[id] = node;
    project.entitiesTree[ROOT_ID].childrenIds.push(id);
  }

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

  const session = new AuthoringSession(async () => ({ success: false, code: 'UNUSED' }));
  const uiDomain = createUiContentDomain(state, replica);
  const entityDomain = createEntityContentDomain(state, replica);
  session.registerDomain('ui', uiDomain);
  session.registerDomain('entities', entityDomain);
  const journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
  session.attachJournal(journal);

  const uiBefore = readUiContent(state);
  const entitiesBefore = readEntitySnapshot(state);

  try {
    // 1. Two domains, one plan: apply → revert restores both.
    const uiProposal = await session.proposeContent('ui', {
      expectedRevision: uiContentRevision(readUiContent(state)),
      patches: [{ nodeId: 'title', properties: { textContent: '共同创作', textColor: [40, 120, 90] } }],
    });
    const entityProposal = await session.proposeContent('entities', {
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { position: [9, 8, 7], name: '向导' } }],
    });
    assert.notEqual(uiContentRevision(readUiContent(state)), 'mutated-by-proposal');
    assert.deepEqual(readEntitySnapshot(state), entitiesBefore, 'proposals never write');

    const plan = await session.proposePlan([uiProposal.proposalId, entityProposal.proposalId]);
    assert.equal(plan.atomic, false);
    assert.equal(plan.members.length, 2);

    const applied = await session.applyPlan(plan.planId);
    assert.equal(applied.success, true);
    assert.equal(readUiContent(state).title.value.data.data.textContent, '共同创作');
    assert.deepEqual(readEntitySnapshot(state).tree.hero.value.position, [9, 8, 7]);
    assert.equal(session.plan(plan.planId).status, 'applied');
    assert.equal(session.plan(plan.planId).appliedCount, 2);

    const reverted = await session.revertPlan(plan.planId);
    assert.equal(reverted.success, true);
    assert.deepEqual(readUiContent(state), uiBefore, 'UI restored by plan revert');
    assert.deepEqual(readEntitySnapshot(state), entitiesBefore, 'entities restored by plan revert');
    assert.equal(session.plan(plan.planId).status, 'reverted');

    // 2. A stale member refuses the whole plan before anything is written.
    const staleUi = await session.proposeContent('ui', {
      expectedRevision: uiContentRevision(readUiContent(state)),
      patches: [{ nodeId: 'title', properties: { textContent: 'stale' } }],
    });
    const freshEntity = await session.proposeContent('entities', {
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { position: [4, 4, 4] } }],
    });
    // Simulate a concurrent edit of the entity domain after the proposal was
    // prepared: write through the same production transaction a human save or
    // another agent would use, then apply the now-stale plan.
    const bump = await entityDomain.prepare({
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { position: [6, 6, 6] } }],
    });
    await entityDomain.apply(bump.step, bump.baseRevision);
    await assert.rejects(session.applyPlan((await session.proposePlan([staleUi.proposalId, freshEntity.proposalId])).planId), /changed after its proposal/);
    assert.equal(readUiContent(state).title.value.data.data.textContent, uiBefore.title.value.data.data.textContent);
    assert.deepEqual(readEntitySnapshot(state).tree.hero.value.position, [6, 6, 6]);
    const restore = await entityDomain.prepare({
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { position: [1, 2, 3] } }],
    });
    await entityDomain.apply(restore.step, restore.baseRevision);
    assert.deepEqual(readEntitySnapshot(state).tree.hero.value.position, [1, 2, 3]);

    // 3. A failing member compensates the members already applied.
    const okUi = await session.proposeContent('ui', {
      expectedRevision: uiContentRevision(readUiContent(state)),
      patches: [{ nodeId: 'title', properties: { textContent: '将被补偿' } }],
    });
    const okEntity = await session.proposeContent('entities', {
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { position: [2, 3, 4] } }],
    });
    session.registerDomain('entities', {
      ...entityDomain,
      apply: async () => ({ success: false, code: 'DOMAIN_REFUSED' }),
    } as ContentDomain);
    const failing = await session.applyPlan((await session.proposePlan([okUi.proposalId, okEntity.proposalId])).planId);
    assert.equal(failing.success, false);
    assert.equal(failing.code, 'PLAN_MEMBER_FAILED');
    assert.deepEqual(failing.compensated, [okUi.proposalId]);
    assert.deepEqual(readUiContent(state), uiBefore, 'earlier member compensated');
    assert.equal(session.plan(failing.planId).status, 'compensated');
    assert.equal(session.plan(failing.planId).appliedCount, 0);
    session.registerDomain('entities', entityDomain);

    // 4. An unapplied plan can be discarded without touching content.
    const d1 = await session.proposeContent('ui', {
      expectedRevision: uiContentRevision(readUiContent(state)),
      patches: [{ nodeId: 'title', properties: { textContent: '草稿' } }],
    });
    const d2 = await session.proposeContent('entities', {
      expectedRevision: entityRevision(state),
      patches: [{ entityId: 'hero', properties: { name: '草稿实体' } }],
    });
    const draft = await session.proposePlan([d1.proposalId, d2.proposalId]);
    const discarded = await session.discardPlan(draft.planId);
    assert.deepEqual(discarded.discarded.sort(), [d1.proposalId, d2.proposalId].sort());
    assert.equal(session.plan(draft.planId).status, 'discarded');
    assert.deepEqual(readUiContent(state), uiBefore);
    assert.deepEqual(readEntitySnapshot(state), entitiesBefore);
    assert.equal(session.proposal(d1.proposalId).status, 'discarded');

    assert.ok(broadcasts > 0, 'applied changes broadcast to editors');
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
