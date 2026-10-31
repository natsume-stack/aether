import { authoringSmokeClient } from './lib/authoring-smoke-client.mjs';

const project = process.argv[2] || 'pvp-4e55bb-imported';
const client = authoringSmokeClient(project, ['terrainInfo', 'entityContext', 'authoringProposal']);

const flat = (o, p = '') => Object.entries(o || {}).flatMap(([k, v]) =>
  v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, JSON.stringify(v)]]);

await client.restart('terrainInfo');
const before = await client.tool('entityContext', { limit: 64 });
const proposal = await client.tool('authoringProposeEntityLifecycle', {
  expectedRevision: before.revision,
  operations: [{ op: 'create', name: 'Probe', position: [1, 2, 3], mesh: 'gltf/5格' }],
});
const id = proposal.previews[0].operations[0].entityId;
const applied = await client.tool('authoringApply', { proposalId: proposal.proposalId }, `probe-${proposal.proposalId}`);
if (applied.success !== true) { console.log('APPLY', JSON.stringify(applied)); process.exit(1); }
const mem = (await client.tool('entityContext', { limit: 64 })).entities.find(e => e.id === id);
await client.save();
await client.restart('terrainInfo');
const after = await client.tool('entityContext', { limit: 64 });
const disk = after.entities.find(e => e.id === id);

const f1 = Object.fromEntries(flat(mem));
const f2 = Object.fromEntries(flat(disk));
console.log('proposalRevision', (await client.tool('authoringProposal', { proposalId: proposal.proposalId })).revision);
console.log('revisionAfterRestart', after.revision);
for (const key of new Set([...Object.keys(f1), ...Object.keys(f2)])) {
  if (f1[key] !== f2[key]) console.log('DIFF', key, '| memory', f1[key], '| disk', f2[key]);
}

// Clean up: delete the probe with a fresh proposal so the map ends unchanged.
const cleanup = await client.tool('authoringProposeEntityLifecycle', {
  expectedRevision: after.revision, operations: [{ op: 'delete', entityId: id }],
});
await client.tool('authoringApply', { proposalId: cleanup.proposalId }, `probe-cleanup-${cleanup.proposalId}`);
await client.save();
console.log('cleaned', (await client.tool('entityContext', { limit: 64 })).total);
