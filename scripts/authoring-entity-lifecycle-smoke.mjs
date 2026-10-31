#!/usr/bin/env node
/**
 * Real-map acceptance for entity lifecycle: create → save → restart → visible →
 * durable inverse → delete → save → restart → gone.
 *
 *   node scripts/authoring-entity-lifecycle-smoke.mjs pvp-4e55bb-imported [mesh]
 *
 * The map ends exactly as it started (0 entities). This proves lifecycle
 * create/delete and persistence, not that the entity looks right in-game.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2];
const evidencePath = path.join('.local-evidence', 'authoring-entity-lifecycle-smoke.json');
const stages = [];
const record = (stage, data = {}) => { stages.push({ stage, at: new Date().toISOString(), ...data }); };

const client = authoringSmokeClient(project, ['terrainInfo', 'entityContext', 'authoringContext', 'authoringProposal']);

try {
  await client.restart('terrainInfo');
  const catalogue = await client.request('internal/ai-tool');
  const names = (catalogue.tools || []).map(t => (typeof t === 'string' ? t : t.name));
  assert.ok(names.includes('authoringProposeEntityLifecycle'), 'lifecycle tool is not exposed on the live runtime');
  record('runtime-ready', { tools: names.length });

  const context = await client.tool('authoringContext', {});
  const before = await client.tool('entityContext', { limit: 256 });
  const mesh = process.argv[3]
    || (context.assets || []).find((name) => name.startsWith('gltf/') || name.startsWith('mesh/'));
  assert.ok(mesh, 'project has no model asset to reference');
  record('context', { entities: before.total, entitiesRevision: before.revision, mesh });

  const proposal = await client.tool('authoringProposeEntityLifecycle', {
    expectedRevision: before.revision,
    operations: [{ op: 'create', name: 'Coauthor Rest', position: [8, 24, 8], mesh, tags: ['coauthor'] }],
  });
  const createdId = proposal.previews[0].operations[0].entityId;
  assert.ok(createdId, 'preview must report the created entity id');
  assert.equal((await client.tool('entityContext', { limit: 1 })).total, before.total, 'proposal must not write');
  record('proposal', { proposalId: proposal.proposalId, createdId });

  assert.equal((await client.tool('authoringApply', { proposalId: proposal.proposalId }, `lifecycle-create-${proposal.proposalId}`)).success, true);
  const afterCreate = await client.tool('entityContext', { limit: 256 });
  assert.equal(afterCreate.total, before.total + 1, 'one entity added');
  const added = (afterCreate.entities || []).find(e => e.id === createdId);
  assert.equal(added.value.name, 'Coauthor Rest');
  assert.deepEqual(added.value.position, [8, 24, 8]);
  await client.save();
  record('created-saved', { entities: afterCreate.total });

  await client.restart('terrainInfo');
  const reopened = await client.tool('entityContext', { limit: 256 });
  assert.equal(reopened.total, before.total + 1, 'created entity survives save + runtime restart');
  assert.ok((reopened.entities || []).some(e => e.id === createdId), 'created entity keeps its id across restart');
  record('reopened', { entities: reopened.total });

  const reverted = await client.tool('authoringRevert', { proposalId: proposal.proposalId }, `lifecycle-revert-${proposal.proposalId}`);
  assert.equal(reverted.success, true);
  assert.equal((await client.tool('entityContext', { limit: 256 })).total, before.total, 'inverse removed the created entity');
  await client.save();
  record('reverted-saved');

  await client.restart('terrainInfo');
  const final = await client.tool('entityContext', { limit: 256 });
  assert.equal(final.total, before.total, 'map returns to its original entity count');
  assert.equal(final.revision, before.revision, 'entity revision returns to its original value');
  record('restored-reopened');

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ok: true, project, mesh, createdId, stages }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, stages: stages.map(s => s.stage) }));
} catch (error) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ok: false, project, error: error.message, stages }, null, 2)}\n`);
  throw error;
}
