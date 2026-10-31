import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRDA } from '@box/schema/project/project-rda';
import {
  UITreeRDA,
  UITextRDA,
  UIBoxRDA,
  DEFAULT_SCREEN_ID,
  UIAutoLayoutRDA,
} from '@box/schema/project/ui-rda/defs';
import { TreeNodeType } from '@box/schema/project/murda-tree';
import { Semaphore } from '@box/utils/semaphore';
import { EditReplicaServer } from '../src/edit/replica/replica-server';
import {
  createUiContentDomain,
  readUiContent,
  uiContentRevision,
} from '../src/edit/ai/ui-content-domain';
import { AuthoringSession } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';
import { readContentOverview } from '../src/edit/ai/content-overview';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-ui-domain-'));
  const project = ProjectRDA.stateSchema.clone(ProjectRDA.stateSchema.identity);
  for (const [id, kind] of [
    ['title', 'text'],
    ['background', 'box'],
  ] as const) {
    const node = UITreeRDA.nodeSchema.alloc();
    node.id = id;
    node.name = id;
    node.type = TreeNodeType.node;
    node.parentId = DEFAULT_SCREEN_ID;
    node.value =
      kind === 'text'
        ? {
            type: 'element',
            data: {
              type: 'text',
              data: UITextRDA.stateSchema.clone(UITextRDA.stateSchema.identity),
            },
          }
        : {
            type: 'element',
            data: { type: 'box', data: UIBoxRDA.stateSchema.clone(UIBoxRDA.stateSchema.identity) },
          };
    project.uiTree[id] = node;
    project.uiTree[DEFAULT_SCREEN_ID].childrenIds.push(id);
  }
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
    _protocol: {
      broadcast: {
        project() {
          broadcasts++;
        },
      },
    },
    authoringProjectTransaction: EditReplicaServer.prototype.authoringProjectTransaction,
  };
  let session: AuthoringSession;
  const invoke = async (tool: string, args: any) =>
    tool === 'authoringApply'
      ? session.applyProposal(args.proposalId)
      : session.revertProposal(args.proposalId);
  const create = () => {
    const result = new AuthoringSession(invoke);
    result.registerDomain('ui', createUiContentDomain(state, replica));
    return result;
  };
  session = create();
  let journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
  session.attachJournal(journal);
  const current = () => uiContentRevision(readUiContent(state));
  try {
    const original = readUiContent(state);
    state.replica.project = { entitiesTree: { stale: { type: TreeNodeType.leaf } }, uiTree: {} };
    const overview = readContentOverview(state);
    assert.equal(overview.entityCount, 0, 'Root and stale cached entries are not persistent scene entities');
    assert.equal(overview.uiNodeCount, 3, 'UI counts screen/elements but excludes bookkeeping root');
    const before = current();
    const args = {
      expectedRevision: before,
      patches: [
        {
          nodeId: 'title',
          properties: {
            positionOffset: [5.3, 12],
            sizeRatio: [0.5, 0],
            textContent: '共同创作',
            textColor: [35, 74, 120],
            backgroundOpacity: 0.3,
          },
        },
      ],
    };
    const proposal = await session.proposeContent('ui', args);
    assert.equal(current(), before, 'proposal must not write');
    const review = proposal.previews[0];
    assert.equal(review.kind, 'ui');
    assert.equal(review.bindingIdentity, 'preserved-property-only');
    const quantized = review.changes[0].properties.find(
      (row: any) => row.key === 'positionOffset',
    ).after;
    assert.equal(quantized[0], Math.round(5.3 * 256) / 256, 'review shows actual schema precision');
    assert.equal(
      (await session.perform('authoringApply', { proposalId: proposal.proposalId }, 'apply'))
        .success,
      true,
    );
    const after = readUiContent(state);
    assert.deepEqual(after.background, original.background);
    assert.deepEqual(after[DEFAULT_SCREEN_ID], original[DEFAULT_SCREEN_ID]);
    assert.equal(after.title.name, original.title.name);
    assert.equal(after.title.parentId, original.title.parentId);
    assert.equal(after.title.value.data.data.textContent, '共同创作');
    const count = broadcasts;
    await session.perform('authoringApply', { proposalId: proposal.proposalId }, 'apply');
    assert.equal(broadcasts, count);
    assert.ok(
      session
        .events()
        .events.filter((row) => row.operationId === 'apply')
        .every((row) => row.kind === 'ui'),
    );
    const raw = state.replica.projectStore.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
    const saved = ProjectRDA.stateSchema.fromJSON(ProjectRDA.stateSchema.toJSON(raw));
    ProjectRDA.stateSchema.free(raw);
    state.replica.projectStore.free(ProjectRDA);
    state.replica.projectStore = ProjectRDA.createStore(saved);
    ProjectRDA.stateSchema.free(saved);
    journal.close();
    session = create();
    journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
    session.attachJournal(journal);
    assert.equal(session.proposal(proposal.proposalId).status, 'applied');
    assert.equal(
      (await session.perform('authoringRevert', { proposalId: proposal.proposalId }, 'revert'))
        .success,
      true,
    );
    assert.deepEqual(
      readUiContent(state),
      original,
      'semantic inverse survives serialized store and journal reopen',
    );
    await assert.rejects(
      session.proposeContent('ui', {
        expectedRevision: current(),
        patches: [{ nodeId: 'background', properties: { textContent: 'invalid' } }],
      }),
      { code: 'UI_PROPERTY_NOT_SUPPORTED' },
    );
    await assert.rejects(
      session.proposeContent('ui', {
        expectedRevision: current(),
        patches: [{ nodeId: DEFAULT_SCREEN_ID, properties: { visible: false } }],
      }),
      { code: 'UI_NODE_NOT_EDITABLE' },
    );
    await assert.rejects(
      session.proposeContent('ui', {
        expectedRevision: current(),
        patches: [{ nodeId: 'title', properties: { name: 'break-binding' } }],
      }),
    );
    await assert.rejects(
      session.proposeContent('ui', {
        expectedRevision: current(),
        patches: [{ nodeId: 'title', properties: { positionOffset: [Infinity, 0] } }],
      }),
    );
    const race = await session.proposeContent('ui', { ...args, expectedRevision: current() });
    await mutex.p();
    const pending = session.perform('authoringApply', { proposalId: race.proposalId }, 'race');
    await Promise.resolve();
    await Promise.resolve();
    const human = ProjectRDA.action(state.replica.projectStore)
      .uiTree.update('title')
      .update()
      .element.update()
      .text.textContent('human');
    state.replica.projectStore.apply(ProjectRDA, human);
    ProjectRDA.actionSchema.free(human);
    mutex.v();
    assert.equal((await pending).code, 'REVISION_CONFLICT');
    assert.equal(readUiContent(state).title.value.data.data.textContent, 'human');
    const preview = await session.proposeContent('ui', { ...args, expectedRevision: current() });
    state.game.state.replica.running = true;
    assert.equal(
      (await session.perform('authoringApply', { proposalId: preview.proposalId }, 'preview')).code,
      'PREVIEW_RUNNING',
    );
    state.game.state.replica.running = false;
    // A parent layout controlled by the engine cannot be bypassed by assigning
    // position values which the renderer would simply ignore.
    const snapshot = state.replica.projectStore.state(ProjectRDA, ProjectRDA.stateSchema.alloc());
    (snapshot.uiTree[DEFAULT_SCREEN_ID].value as any).data.layout = {
      type: 'autoLayout',
      data: UIAutoLayoutRDA.stateSchema.clone(UIAutoLayoutRDA.stateSchema.identity),
    };
    state.replica.projectStore.free(ProjectRDA);
    state.replica.projectStore = ProjectRDA.createStore(snapshot);
    ProjectRDA.stateSchema.free(snapshot);
    await assert.rejects(session.proposeContent('ui', { ...args, expectedRevision: current() }), {
      code: 'UI_AUTO_LAYOUT_POSITION',
    });
    fs.mkdirSync(path.resolve('../../.local-evidence'), { recursive: true });
    fs.writeFileSync(
      path.resolve('../../.local-evidence/ui-transactions-integration.json'),
      JSON.stringify(
        {
          scope:
            'real ProjectRDA fixture and production mutex method; not real-map/UI visual acceptance',
          passed: [
            'quantized review',
            'exact property apply',
            'stable IDs/names/hierarchy',
            'unrelated node preserved',
            'idempotency',
            'UI events',
            'serialized-store+journal inverse',
            'unsupported kind/property refused',
            'invalid schema refused',
            'human mutex race refused',
            'preview refused',
            'auto-layout ignored position refused',
          ],
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS UI property domain: actual RDA, production mutex, quantized review, serialized inverse and refusals',
    );
  } finally {
    journal.close();
    state.replica.projectStore.free(ProjectRDA);
    ProjectRDA.stateSchema.free(project);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
