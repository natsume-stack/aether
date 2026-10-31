import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildLocalTerrainTools } from '../tools/box3-agent-mcp/src/local-terrain.js';

// Explicit existing project only. One cell is changed temporarily and restored.
const projectId = process.argv[2];
if (!projectId || !/^[a-z0-9-]+$/.test(projectId)) throw new Error('Supply an existing local project ID');
const base = `http://127.0.0.1:${process.env.BOX_EDIT_RUNTIME_PORT || '9967'}/${projectId}/internal/`;
const run = randomUUID();
const evidence = { projectId, run, at: new Date().toISOString(), checks: [] };
const check = name => { evidence.checks.push(name); console.log(`PASS ${name}`); };
async function request(route, body) {
  const res = await fetch(base + route, { method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000) });
  const data = await res.json();
  assert.ok(res.ok, `HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function call(tool, args = {}, operationId) {
  const { result } = await request('ai-tool', { tool, args, ...(operationId ? { operationId } : {}) });
  assert.notEqual(result.success, false, JSON.stringify(result));
  return result;
}
const status = await request('creator-preview-runtime');
assert.notEqual(status.running, true);
assert.notEqual(status.phase, 'running');
const info = await call('terrainInfo');
assert.equal(info.previewRunning, false);
const point = [1, Math.min(60, info.shape[1] - 2), 1];
const region = { min: point, max: point };
const before = await call('terrainRead', { region, limit: 1 });
assert.equal(before.cells.length, 1);
const old = before.cells[0].b;
const catalog = await call('blockCatalog', { limit: 10 });
const block = catalog.blocks.find(b => b.valid && b.id !== (old & 0xfff)).id;
const localOperator = buildLocalTerrainTools({ mapAuthoring: (name, args) => call(name, args) })[0];
const localDraft = await localOperator.handler({ region, kind: 'fill', block });
assert.ok(localDraft.data.proposalId);
assert.equal(localDraft.data.changed, 1);
assert.equal((await call('terrainRead', { region, limit: 1 })).cells[0].b, old);
check('local operator compiles existing content into a non-writing proposal');
const stale = await fetch(base + 'ai-tool', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'authoringPropose', args: { expectedRevision: 'stale-source', steps: [{ tool: 'terrainApply', args: { region, block } }] } }), signal: AbortSignal.timeout(15000) });
assert.equal(stale.status, 409);
assert.equal((await stale.json()).code, 'REVISION_CONFLICT');
check('stale source proposal is refused with HTTP 409');
const proposal = await call('authoringPropose', { steps: [{ tool: 'terrainApply', args: { region, block } }] });
check('proposal dry-run');
let applied = false;
try {
  const args = { proposalId: proposal.proposalId };
  const a = await call('authoringApply', args, `${run}:apply`);
  applied = true;
  const duplicate = await call('authoringApply', args, `${run}:apply`);
  assert.deepEqual(a, duplicate);
  assert.equal((await call('terrainRead', { region, limit: 1 })).cells[0].b, block);
  check('apply, exact readback and idempotent replay');
  const receipt = await call('authoringOperation', { operationId: `${run}:apply` });
  assert.equal(receipt.status, 'completed');
  const events = await call('authoringEvents', { after: 0 });
  assert.equal(events.events.filter(e => e.operationId === `${run}:apply` && e.status === 'completed').length, 1);
  check('queryable receipt and one completion event');
  assert.ok((await request('save-local-project', {})).permissionHash);
  check('save applied state');
} finally {
  if (applied) {
    await call('authoringRevert', { proposalId: proposal.proposalId }, `${run}:revert`);
    assert.equal((await call('terrainRead', { region, limit: 1 })).cells[0].b, old);
    assert.ok((await request('save-local-project', {})).permissionHash);
    check('rollback restores exact cell and saves restored state');
  }
}
evidence.cell = { point, before: old, temporary: block, restored: old };
await fs.mkdir('.local-evidence', { recursive: true });
await fs.writeFile('.local-evidence/authoring-runtime-smoke.json', JSON.stringify(evidence, null, 2));
