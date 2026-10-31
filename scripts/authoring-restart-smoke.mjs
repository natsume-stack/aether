import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

// Run authoring-runtime-smoke first. It restores and saves its temporary cell.
const project = process.argv[2];
const prior = JSON.parse(await fs.readFile('.local-evidence/authoring-runtime-smoke.json', 'utf8'));
assert.equal(project, prior.projectId);
const base = `http://127.0.0.1:${process.env.BOX_EDIT_RUNTIME_PORT || '9967'}/${encodeURIComponent(project)}/`;
async function request(route, body, headers = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const data = response.status === 204 ? {} : await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const tool = async (name, args = {}, operationId) => (await request('internal/ai-tool', { tool: name, args, operationId })).result;
const history = await tool('authoringHistory');
assert.equal(history.durable, true);
const id = `${prior.run}:apply`;
const before = await tool('authoringOperation', { operationId: id });
const verifyOnly = process.argv.includes('--verify-only');
assert.equal(before.status, verifyOnly ? 'recovered' : 'completed');
const oldRuntime = verifyOnly ? before.result.previousRuntimeId : before.runtimeId;
if (!verifyOnly) {
const preview = await request('internal/creator-preview-runtime');
assert.notEqual(preview.running, true);
assert.notEqual(preview.phase, 'running');
assert.ok((await request('internal/save-local-project', {})).permissionHash);
await request('__local_runtime/destroy', {});
await request('__local_runtime/start', {}, { 'x-box-runtime-restart': '1' });
// Poll a read-only lifecycle endpoint instead of retrying the start/write.
let ready = false;
for (let attempt = 0; attempt < 45; attempt++) {
  const status = await request('__local_runtime/status');
  if (status.phase === 'ready') { ready = true; break; }
  if (status.phase === 'error') throw new Error('Runtime failed to start');
  await pause(2000);
}
assert.equal(ready, true, 'Runtime did not become ready');
}
const after = await tool('authoringOperation', { operationId: id });
assert.notEqual(after.runtimeId, oldRuntime);
assert.equal(after.status, 'recovered');
assert.equal(after.result.code, 'PREVIOUS_RUNTIME_OPERATION');
assert.equal(after.result.historicalOutcome.success, true);
assert.equal(after.result.inspectRequired, true);
const duplicate = await tool('authoringApply', { proposalId: after.result.historicalOutcome.proposalId }, id);
assert.equal(duplicate.code, 'PREVIOUS_RUNTIME_OPERATION');
const region = { min: prior.cell.point, max: prior.cell.point };
const cell = (await tool('terrainRead', { region, limit: 1 })).cells[0];
assert.equal(cell.b, prior.cell.before);
const recoveredHistory = await tool('authoringHistory');
assert.ok(recoveredHistory.events.some(row => row.runtimeId === oldRuntime && row.payload.operationId === id));
await fs.writeFile('.local-evidence/authoring-restart-smoke.json', JSON.stringify({
  project, oldRuntime, newRuntime: after.runtimeId, operationId: id,
  checks: ['historical receipt recovered', 'same-ID replay prevented', 'restored saved cell retained', 'old event history readable'],
  at: new Date().toISOString(),
}, null, 2));
console.log('PASS durable receipts, no replay, saved content and historical events across real runtime restart');
