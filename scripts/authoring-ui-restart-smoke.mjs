import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2];
const client = authoringSmokeClient(project, ['uiContext', 'authoringProposal', 'terrainInfo']);
const evidence = {
  project,
  scope:
    'temporary property edit of a preexisting real UI element; not responsive-layout, binding runtime or creative visual acceptance',
  run: randomUUID(),
  at: new Date().toISOString(),
  stage: 'initial-inspection-required',
};
await fs.mkdir('.local-evidence', { recursive: true });
async function record(stage) {
  evidence.stage = stage;
  await fs.writeFile('.local-evidence/ui-restart-smoke.json', JSON.stringify(evidence, null, 2));
  console.log(stage);
}
await record(evidence.stage);
await client.stopped();
await client.save();
await client.restart();
const before = await client.tool('uiContext', { limit: 256, offset: 0 });
assert.equal(before.truncated, false);
const node = before.nodes.find(
  (node) =>
    node.value?.type === 'element' && Array.isArray(node.value.data?.data?.position?.offset),
);
assert.ok(node, 'No actual existing UI element; do not fabricate a target');
const original = node.value.data.data.position.offset;
evidence.node = {
  id: node.id,
  name: node.name,
  parentId: node.parentId,
  kind: node.value.data.type,
  positionOffset: original,
};
evidence.beforeRevision = before.revision;
const terrain = await client.tool('terrainInfo');
evidence.terrainRevision = terrain.revision;
const proposal = await client.tool('authoringProposeUi', {
  expectedRevision: before.revision,
  patches: [{ nodeId: node.id, properties: { positionOffset: [original[0] + 0.25, original[1]] } }],
});
evidence.proposalId = proposal.proposalId;
assert.equal((await client.tool('uiContext', { limit: 256, offset: 0 })).revision, before.revision);
await record('proposed-source-unchanged');
const applied = await client.tool(
  'authoringApply',
  { proposalId: proposal.proposalId },
  `ui-apply-${evidence.run}`,
);
evidence.appliedRevision = applied.revision;
await record('applied-save-required');
await client.save();
await record('applied-saved');
await client.restart();
const reopened = await client.tool('uiContext', { limit: 256, offset: 0 });
assert.equal(
  reopened.revision,
  evidence.appliedRevision,
  'Saved/reopened UI must match reviewed result',
);
const recovered = await client.tool('authoringProposal', { proposalId: proposal.proposalId });
assert.equal(recovered.rollbackAvailable, true);
assert.equal(recovered.rollbackDurable, true);
await record('reopened-inverse-available');
await client.tool(
  'authoringRevert',
  { proposalId: proposal.proposalId },
  `ui-revert-${evidence.run}`,
);
await record('restored-save-required');
await client.save();
await client.restart();
const restored = await client.tool('uiContext', { limit: 256, offset: 0 });
assert.equal(restored.revision, before.revision);
assert.deepEqual(
  restored.nodes,
  before.nodes,
  'All original UI node bodies, names, types, parents and order restored',
);
assert.equal((await client.tool('terrainInfo')).revision, terrain.revision);
await record('restored-reopened-all-ui-match');
