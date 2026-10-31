import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const project = process.argv[2];
assert.match(project || '', /^[a-z0-9-]+$/);
const base = `http://127.0.0.1:9967/${project}/`;
const evidenceFile = '.local-evidence/script-restart-smoke.json';
const evidence = { project, run: randomUUID(), at: new Date().toISOString(),
  scope: 'Temporary script comment edit in an existing community map; save/restart/inverse recovery. Does not prove creative or gameplay quality.' };
const hash = text => createHash('sha256').update(text).digest('hex');
async function record(stage) {
  evidence.stage = stage;
  await fs.mkdir('.local-evidence', { recursive: true });
  await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(stage);
}
async function request(route, body, headers = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const data = response.status === 204 ? {} : await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${data.code || data.message || 'request failed'}`);
  return data;
}
const readers = new Set(['listScripts', 'readScript', 'scriptCheck', 'authoringProposal', 'authoringOperation']);
async function tool(name, args = {}, operationId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { result } = await request('internal/ai-tool', { tool: name, args, operationId });
      assert.notEqual(result.success, false, `${result.code}: ${result.error}`);
      return result;
    } catch (error) {
      if (!readers.has(name) || !(error instanceof TypeError) || attempt >= 4) throw error;
      await pause(2000);
    }
  }
}
async function save() { assert.ok((await request('internal/save-local-project', {})).permissionHash); }
async function restart() {
  await request('__local_runtime/destroy', {});
  try { await request('__local_runtime/start', {}, { 'x-box-runtime-restart': '1' }); }
  catch (error) { if (!(error instanceof TypeError)) throw error; }
  for (let attempt = 0; attempt < 45; attempt++) {
    let status;
    try { status = await request('__local_runtime/status'); }
    catch (error) { if (!(error instanceof TypeError)) throw error; await pause(2000); continue; }
    assert.notEqual(status.phase, 'error');
    if (status.phase === 'ready') { await tool('listScripts'); return; }
    await pause(2000);
  }
  throw new Error('Runtime did not become ready; inspect evidence, do not replay writes');
}
async function allScripts() {
  const { scripts } = await tool('listScripts');
  const rows = [];
  for (const script of scripts) {
    const read = await tool('readScript', { fileId: script.id });
    rows.push({ name: read.name, isClient: read.isClient, hash: hash(read.content) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
try {
  const preview = await request('internal/creator-preview-runtime');
  assert.notEqual(preview.running, true);
  assert.notEqual(preview.phase, 'running');
  await save();
  if (!process.argv.includes('--current-runtime')) await restart();
  const { scripts } = await tool('listScripts');
  const target = scripts.find(file => file.name === 'index.js');
  assert.ok(target);
  const original = await tool('readScript', { fileId: target.id });
  evidence.fileId = target.id;
  evidence.name = target.name;
  evidence.originalHash = hash(original.content);
  evidence.before = await allScripts();
  const marker = `// BOX3 authoring recovery acceptance ${evidence.run}\n`;
  const args = { fileId: target.id, expectedRevision: original.revision, policy: 'no-new-errors',
    edits: [{ index: 0, deleteCount: 0, text: marker }] };
  const review = await tool('scriptCheck', args);
  assert.equal(review.sourceStillMatches, true);
  assert.equal(review.dependenciesStillMatch, true);
  assert.equal(review.check.accepted, true, JSON.stringify(review.check));
  evidence.validation = { policy: review.check.policy, clean: review.check.clean, comparison: review.check.comparison };
  await record('checked');
  const proposal = await tool('authoringProposeScript', args);
  evidence.proposalId = proposal.proposalId;
  assert.equal((await tool('authoringProposal', { proposalId: proposal.proposalId })).rollbackDurable, true);
  await record('proposed');
  await tool('authoringApply', { proposalId: proposal.proposalId }, `${evidence.run}:apply`);
  await record('applied');
  assert.equal((await tool('readScript', { fileId: target.id })).content, marker + original.content);
  await save();
  await record('applied-saved');
  await restart();
  assert.equal((await tool('readScript', { fileId: target.id })).content, marker + original.content);
  const recovered = await tool('authoringProposal', { proposalId: proposal.proposalId });
  assert.equal(recovered.status, 'applied');
  assert.equal(recovered.rollbackAvailable, true);
  await record('recovered');
  await tool('authoringRevert', { proposalId: proposal.proposalId }, `${evidence.run}:revert`);
  assert.equal((await tool('readScript', { fileId: target.id })).content, original.content);
  await save();
  await record('restored-saved');
  await restart();
  assert.equal((await tool('readScript', { fileId: target.id })).content, original.content);
  assert.deepEqual(await allScripts(), evidence.before);
  await record('restored-reopened-all-scripts-match');
} catch (error) {
  evidence.error = error.message;
  await record(`${evidence.stage || 'initial'}-inspection-required`);
  throw error;
}
