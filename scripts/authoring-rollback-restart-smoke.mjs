import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const project = process.argv[2];
assert.match(project || '', /^[a-z0-9-]+$/);
const base = `http://127.0.0.1:9967/${project}/`;
const evidenceFile = '.local-evidence/authoring-rollback-restart-smoke.json';
async function request(route, body, headers = {}) {
  console.log(`REQUEST ${route}${body?.tool ? ` ${body.tool}` : ''}`);
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const data = response.status === 204 ? {} : await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
async function tool(name, args = {}, operationId) {
  const readonly = ['terrainInfo','terrainRead','blockCatalog','authoringProposal'].includes(name);
  let data;
  for (let attempt = 0; ; attempt++) {
    try { data = await request('internal/ai-tool', { tool: name, args, operationId }); break; }
    catch (error) {
      if (!readonly || attempt >= 4 || !(error instanceof TypeError)) throw error;
      await pause(2000);
    }
  }
  const { result } = data;
  assert.notEqual(result.success, false, JSON.stringify(result));
  return result;
}
async function restart() {
  await request('__local_runtime/destroy', {});
  try { await request('__local_runtime/start', {}, { 'x-box-runtime-restart': '1' }); }
  catch (error) { if (!(error instanceof TypeError)) throw error; console.log('Start connection interrupted; inspect lifecycle without resending start'); }
  for (let i = 0; i < 45; i++) {
    let status;
    try { status = await request('__local_runtime/status'); }
    catch (error) { if (!(error instanceof TypeError)) throw error; await pause(2000); continue; }
    if (status.phase === 'ready') { await tool('terrainInfo'); return; }
    assert.notEqual(status.phase, 'error');
    await pause(2000);
  }
  throw new Error('Runtime startup timeout; inspect evidence before any write retry');
}
// Load new server modules before introducing a temporary edit.
const preview = await request('internal/creator-preview-runtime');
assert.notEqual(preview.running, true);
assert.notEqual(preview.phase, 'running');
assert.ok((await request('internal/save-local-project', {})).permissionHash);
if (!process.argv.includes('--current-runtime')) await restart();
console.log('Runtime ready with current modules');
const region = { min: [1,60,1], max: [1,60,1] };
const original = (await tool('terrainRead', { region, limit: 1 })).cells[0].b;
const catalog = await tool('blockCatalog', { limit: 10 });
const block = catalog.blocks.find(b => b.valid && b.id !== (original & 0xfff)).id;
const run = randomUUID();
const proposal = await tool('authoringPropose', { steps: [{ tool: 'terrainApply', args: { region, block } }] });
assert.equal((await tool('authoringProposal', { proposalId: proposal.proposalId })).rollbackDurable, true);
const evidence = { project, run, proposalId: proposal.proposalId, region, original, block, stage: 'proposed', at: new Date().toISOString() };
async function record(stage) { evidence.stage = stage; await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2)); console.log(stage); }
await record('proposed');
// No blind retries or raw terrain compensation on ambiguous errors. The evidence
// retains the proposal and exact cell for inspection/recovery if this fails.
await tool('authoringApply', { proposalId: proposal.proposalId }, `${run}:apply`);
await record('applied');
assert.equal((await tool('terrainRead', { region, limit: 1 })).cells[0].b, block);
assert.ok((await request('internal/save-local-project', {})).permissionHash);
await record('applied-saved');
await restart();
const recovered = await tool('authoringProposal', { proposalId: proposal.proposalId });
assert.equal(recovered.status, 'applied');
assert.equal(recovered.rollbackAvailable, true);
assert.equal((await tool('terrainRead', { region, limit: 1 })).cells[0].b, block);
await tool('authoringRevert', { proposalId: proposal.proposalId }, `${run}:revert`);
assert.equal((await tool('terrainRead', { region, limit: 1 })).cells[0].b, original);
assert.ok((await request('internal/save-local-project', {})).permissionHash);
await record('restored-saved');
console.log('PASS saved terrain edit survives restart and recovered inverse restores exact original cell');
