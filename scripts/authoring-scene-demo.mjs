#!/usr/bin/env node
/**
 * Visible co-authoring demo on a real map: a small rest pavilion (platform,
 * four pillars, roof, lantern) plus one placed prop, proposed → applied → saved.
 *
 *   node scripts/authoring-scene-demo.mjs pvp-4e55bb-imported [--revert]
 *
 * Coordinates are absolute and printed with every step so a human can inspect
 * the result in the editor. --revert undoes everything this script created
 * (it remembers the proposal ids in .local-evidence/authoring-scene-demo.json).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2] || 'pvp-4e55bb-imported';
const revert = process.argv.includes('--revert');
const evidencePath = path.join('.local-evidence', 'authoring-scene-demo.json');
const evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : {};
const stages = [];
const record = (stage, data = {}) => stages.push({ stage, at: new Date().toISOString(), ...data });

const client = authoringSmokeClient(project, ['terrainInfo', 'terrainRead', 'entityContext', 'authoringContext', 'authoringProposal']);

const CENTER = [40, 40];
const GROUND = 28;
const FLOOR = GROUND + 1;
const PLATFORM = { min: [CENTER[0] - 3, FLOOR, CENTER[1] - 3], max: [CENTER[0] + 3, FLOOR, CENTER[1] + 3] };
const PILLARS = [[-3, -3], [-3, 3], [3, -3], [3, 3]];
const ROOF = { min: [CENTER[0] - 2, FLOOR + 3, CENTER[1] - 2], max: [CENTER[0] + 2, FLOOR + 3, CENTER[1] + 2] };
const LANTERN = [CENTER[0], FLOOR + 1, CENTER[1]];

try {
  await client.restart('terrainInfo');
  await client.stopped();

  if (revert) {
    for (const entry of evidence.proposals || []) {
      const status = (await client.tool('authoringProposal', { proposalId: entry.proposalId })).status;
      if (status !== 'applied') { record('skip', { id: entry.proposalId, status }); continue; }
      await client.tool('authoringRevert', { proposalId: entry.proposalId }, `demo-revert-${entry.proposalId}`);
      record('reverted', { id: entry.proposalId });
    }
    await client.save();
    fs.writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, revertedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, reverted: true }));
    process.exit(0);
  }

  const info = await client.tool('terrainInfo', {});
  const steps = [
    { tool: 'terrainApply', args: { region: PLATFORM, block: 'light_grey_stone_brick' } },
    ...PILLARS.map(([dx, dz]) => ({ tool: 'terrainApply',
      args: { region: { min: [CENTER[0] + dx, FLOOR + 1, CENTER[1] + dz], max: [CENTER[0] + dx, FLOOR + 2, CENTER[1] + dz] }, block: 'wood' } })),
    { tool: 'terrainApply', args: { region: ROOF, block: 'brick_red' } },
    { tool: 'terrainApply', args: { region: { min: LANTERN, max: LANTERN }, block: 'indigo_light' } },
  ];
  const terrain = await client.tool('authoringPropose', { expectedRevision: info.revision, steps });
  assert.equal(terrain.success, true);
  const previewChanged = terrain.previews.reduce((sum, p) => sum + (p.changed || 0), 0);
  record('terrain-proposed', { proposalId: terrain.proposalId, changed: previewChanged });
  assert.equal((await client.tool('authoringApply', { proposalId: terrain.proposalId }, `demo-terrain-${terrain.proposalId}`)).success, true);
  record('terrain-applied');

  const context = await client.tool('authoringContext', {});
  const mesh = (context.assets || []).find(name => name.startsWith('gltf/')) || (context.assets || []).find(name => name.startsWith('mesh/'));
  const entities = await client.tool('entityContext', { limit: 1 });
  let entityProposal = null;
  if (mesh) {
    entityProposal = await client.tool('authoringProposeEntityLifecycle', {
      expectedRevision: entities.revision,
      operations: [{ op: 'create', name: 'Pavilion Lamp', position: [CENTER[0] + 1, FLOOR + 1, CENTER[1] + 1], mesh, tags: ['coauthor', 'demo'] }],
    });
    assert.equal((await client.tool('authoringApply', { proposalId: entityProposal.proposalId }, `demo-prop-${entityProposal.proposalId}`)).success, true);
    record('prop-applied', { proposalId: entityProposal.proposalId, mesh });
  }

  await client.save();
  record('saved');

  const after = await client.tool('terrainInfo', {});
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify({
    ok: true, project, ...evidence,
    center: CENTER, ground: GROUND,
    proposals: [...(evidence.proposals || []), { proposalId: terrain.proposalId, kind: 'terrain' }, ...(entityProposal ? [{ proposalId: entityProposal.proposalId, kind: 'entity' }] : [])],
    stages, finalRevision: after.revision,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, changed: previewChanged, stages: stages.map(s => s.stage) }));
} catch (error) {
  fs.writeFileSync(evidencePath, `${JSON.stringify({ ok: false, project, error: error.message, stages }, null, 2)}\n`);
  throw error;
}
