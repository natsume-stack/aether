import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2];
const { tool, save, stopped, restart } = authoringSmokeClient(project, ['terrainInfo', 'entityContext', 'authoringProposal', 'authoringOperation']);
const evidenceFile = '.local-evidence/entity-restart-smoke.json';
const evidence = { project, run: randomUUID(), at: new Date().toISOString(),
  scope: 'Temporary 0.25-unit position edit of one existing real-map entity, exact property/hierarchy/model preservation and saved inverse recovery; not creative scene quality acceptance' };
async function record(stage) {
  evidence.stage = stage;
  await fs.mkdir('.local-evidence', { recursive: true });
  await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(stage);
}
async function allEntities() {
  const first = await tool('entityContext', { limit: 256 });
  const entities = [...first.entities];
  for (let offset = 256; offset < first.total; offset += 256) {
    const next = await tool('entityContext', { limit: 256, offset });
    assert.equal(next.revision, first.revision, 'Scene changed during paged source read');
    entities.push(...next.entities);
  }
  return { entities, revision: first.revision };
}
try {
  await stopped();
  await save();
  if (!process.argv.includes('--current-runtime')) await restart();
  const original = await allEntities();
  evidence.sourceCount = original.entities.length;
  evidence.lockedCount = original.entities.filter(node => node.value.editLock).length;
  const target = original.entities.find(node => !node.value.editLock && node.value.position.every(Number.isFinite));
  assert.ok(target, 'No unlocked existing entity available; do not create a substitute and claim existing-object acceptance');
  const position = [...target.value.position]; position[0] += 0.25;
  evidence.before = original;
  evidence.entityId = target.id;
  const proposal = await tool('authoringProposeEntities', { expectedRevision: original.revision,
    patches: [{ entityId: target.id, properties: { position } }] });
  evidence.proposalId = proposal.proposalId;
  assert.deepEqual(await allEntities(), original, 'Proposal must not mutate scene');
  assert.equal((await tool('authoringProposal', { proposalId: proposal.proposalId })).rollbackDurable, true);
  await record('proposed');
  await tool('authoringApply', { proposalId: proposal.proposalId }, `${evidence.run}:apply`);
  const applied = await allEntities();
  const expected = structuredClone(original.entities);
  expected.find(node => node.id === target.id).value.position = position;
  assert.deepEqual(applied.entities, expected, 'Only target position changes; all other properties/IDs/hierarchy/model references stay exact');
  evidence.appliedRevision = applied.revision;
  await record('applied');
  await save();
  await record('applied-saved');
  await restart();
  assert.deepEqual(await allEntities(), applied);
  assert.equal((await tool('authoringProposal', { proposalId: proposal.proposalId })).status, 'applied');
  await record('recovered');
  await tool('authoringRevert', { proposalId: proposal.proposalId }, `${evidence.run}:revert`);
  assert.deepEqual(await allEntities(), original);
  await save();
  await record('restored-saved');
  await restart();
  assert.deepEqual(await allEntities(), original);
  await record('restored-reopened-all-entities-match');
} catch (error) {
  evidence.error = error.message;
  await record(`${evidence.stage || 'initial'}-inspection-required`);
  throw error;
}
