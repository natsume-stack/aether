import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

const project = process.argv[2];
assert.match(project || '', /^[a-z0-9-]+$/);
const base = `http://127.0.0.1:9967/${project}/`;
async function request(route, body, headers = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const data = response.status === 204 ? {} : await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${data.code || data.message || 'request failed'}`);
  return data;
}
async function tool(name, args = {}) {
  // This script only sends read-only tools. Never use this retry for mutations.
  for (let attempt = 0; ; attempt++) {
    try {
      const { result } = await request('internal/ai-tool', { tool: name, args });
      assert.notEqual(result.success, false, result.code || result.error);
      return result;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 4) throw error;
      await pause(2000);
    }
  }
}
if (process.argv.includes('--restart')) {
  const preview = await request('internal/creator-preview-runtime');
  assert.notEqual(preview.running, true);
  assert.notEqual(preview.phase, 'running');
  assert.ok((await request('internal/save-local-project', {})).permissionHash);
  await request('__local_runtime/destroy', {});
  try { await request('__local_runtime/start', {}, { 'x-box-runtime-restart': '1' }); }
  catch (error) { if (!(error instanceof TypeError)) throw error; }
  let ready = false;
  for (let i = 0; i < 45; i++) {
    let status;
    try { status = await request('__local_runtime/status'); }
    catch (error) { if (!(error instanceof TypeError)) throw error; await pause(2000); continue; }
    if (status.phase === 'ready') { ready = true; break; }
    assert.notEqual(status.phase, 'error');
    await pause(2000);
  }
  assert.equal(ready, true);
}
const listed = await tool('listScripts');
const entry = listed.scripts.find(file => file.name === 'index.js') || listed.scripts[0];
assert.ok(entry);
const original = await tool('readScript', { fileId: entry.id });
assert.match(original.revision, /^[a-f0-9]{64}$/);
const args = { fileId: entry.id, expectedRevision: original.revision,
  policy: process.argv.includes('--compatible') ? 'no-new-errors' : 'strict',
  edits: [{ index: 0, deleteCount: 0, text: '' }] };
const preview = await tool('scriptPreview', args);
assert.equal(preview.content, original.content);
assert.equal(preview.changed, false);
const checked = await tool('scriptCheck', args);
if (process.argv.includes('--compatible')) assert.equal(checked.check.accepted, true, JSON.stringify(checked.check));
assert.equal(checked.sourceStillMatches, true);
assert.equal(checked.dependenciesStillMatch, true);
const after = await tool('readScript', { fileId: entry.id });
assert.equal(after.content, original.content);
assert.equal(after.revision, original.revision);
const stale = await fetch(base + 'internal/ai-tool', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'scriptPreview', args: { ...args, expectedRevision: 'stale' } }), signal: AbortSignal.timeout(15000) });
assert.equal(stale.status, 409);
const evidence = { at: new Date().toISOString(), project, fileId: entry.id, name: entry.name, scriptCount: listed.scripts.length,
  scope: 'Real map read-only preview/check; no script application, no claim that existing project passes static checks',
  checks: ['live preview mounted', 'no-op preview exact', 'source and dependencies still current', 'script unchanged', 'stale source HTTP 409'],
  gate: { available: checked.check.available, passed: checked.check.passed, mode: checked.check.mode,
    accepted: checked.check.accepted, clean: checked.check.clean, policy: checked.check.policy, comparison: checked.check.comparison,
    code: checked.check.code, diagnosticCount: checked.check.diagnosticCount ?? checked.check.diagnostics?.length,
    diagnosticCodes: [...new Set((checked.check.diagnostics || []).map(row => row.code))],
    bindingErrors: checked.check.bindings?.errorCount, bindingWarnings: checked.check.bindings?.warningCount,
    bindingCodes: [...new Set((checked.check.bindings?.problems || []).map(row => row.code))] } };
await fs.mkdir('.local-evidence', { recursive: true });
await fs.writeFile('.local-evidence/script-review-live.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
