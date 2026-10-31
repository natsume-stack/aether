import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthoringTools } from '../src/authoring-tools.js';

test('script review is available in readonly mode and forwards source revision without browser actions', async () => {
  const calls = [];
  const tools = buildAuthoringTools({ mapAuthoring: async (...args) => { calls.push(args); return { applied: false }; } }, { allowWrite: false });
  const preview = tools.find(t => t.name === 'map_script_preview');
  const edits = [{ index: 0, deleteCount: 0, text: '// comment\n' }];
  await preview.handler({ projectId: 'p1', fileId: 'f1', expectedRevision: 'hash', edits });
  assert.equal(preview.annotations.readOnlyHint, true);
  assert.deepEqual(calls, [['scriptPreview', { fileId: 'f1', expectedRevision: 'hash', edits }, { projectId: 'p1', operationId: undefined }]]);
  const check = tools.find(t => t.name === 'map_script_check');
  assert.equal(check.annotations.readOnlyHint, true);
  await check.handler({ projectId: 'p1', fileId: 'f1', expectedRevision: 'hash', edits });
  assert.equal(calls[1][0], 'scriptCheck');
});

test('runtime proposal tools forward operation ID without requiring browser observe', async () => {
  const calls = [];
  const client = { mapAuthoring: async (...args) => { calls.push(args); return { success: true }; } };
  const tools = buildAuthoringTools(client, { allowWrite: true });
  const apply = tools.find(t => t.name === 'map_apply_proposal');
  await apply.handler({ projectId: 'p1', proposalId: 'proposal', operationId: 'stable' });
  assert.deepEqual(calls, [['authoringApply', { proposalId: 'proposal' }, { projectId: 'p1', operationId: 'stable' }]]);
  assert.equal(apply.annotations.readOnlyHint, false);
});

test('script proposal preserves explicit compatibility policy while application remains write-gated', async () => {
  const calls = [];
  const tools = buildAuthoringTools({ mapAuthoring: async (...args) => { calls.push(args); return {}; } }, { allowWrite: false });
  const args = { fileId: 'f1', expectedRevision: 'revision', policy: 'no-new-errors',
    edits: [{ index: 0, deleteCount: 0, text: '// addition\n' }] };
  for (const [name, runtime] of [['map_script_check', 'scriptCheck'], ['map_propose_script', 'authoringProposeScript']]) {
    const tool = tools.find(item => item.name === name);
    assert.deepEqual(tool.inputSchema.properties.policy.enum, ['strict', 'no-new-errors']);
    await tool.handler(args);
    assert.equal(calls.at(-1)[0], runtime);
    assert.deepEqual(calls.at(-1)[1], args);
  }
});

test('readonly mode refuses apply, rollback, save and preview before transport', async () => {
  const tools = buildAuthoringTools({}, { allowWrite: false });
  for (const name of ['map_apply_proposal', 'map_revert_proposal', 'map_runtime_save', 'map_runtime_preview']) {
    await assert.rejects(tools.find(t => t.name === name).handler({ proposalId: 'p', operationId: 'op', action: 'stop' }), { code: 'WRITE_DISABLED' });
  }
});

test('runtime lifecycle uses authenticated map routes and exposes no force-save bypass', async () => {
  const calls = [];
  const tools = buildAuthoringTools({ mapRuntimeAction: async (...args) => { calls.push(args); return { permissionHash: 'saved' }; } }, { allowWrite: true });
  const save = tools.find(t => t.name === 'map_runtime_save');
  assert.equal(save.inputSchema.properties.force, undefined);
  await save.handler({ projectId: 'p1' });
  await tools.find(t => t.name === 'map_runtime_preview').handler({ projectId: 'p1', action: 'stop' });
  assert.deepEqual(calls, [['save', {}, 'p1'], ['preview', { action: 'stop' }, 'p1']]);
});

test('bounded entity context and entity proposal forward stable IDs and revision without browser state', async () => {
  const calls = [];
  const tools = buildAuthoringTools({ mapAuthoring: async (...args) => { calls.push(args); return {}; } }, { allowWrite: false });
  await tools.find(tool => tool.name === 'map_entities').handler({ ids: ['entity-1'], limit: 1 });
  assert.equal(calls[0][0], 'entityContext');
  const patch = { expectedRevision: 'entity-and-asset-revision', patches: [{ entityId: 'entity-1', properties: { position: [3, 4, 5] } }] };
  await tools.find(tool => tool.name === 'map_propose_entities').handler(patch);
  assert.equal(calls[1][0], 'authoringProposeEntities');
  assert.deepEqual(calls[1][1], patch);
});

test('discard is a stable write-gated proposal action, not a rollback or browser command', async()=>{
  const calls=[];
  const tool=buildAuthoringTools({mapAuthoring:async(...args)=>{calls.push(args);return{status:'discarded'};}},{allowWrite:true}).find(t=>t.name==='map_discard_proposal');
  await tool.handler({projectId:'p',proposalId:'draft',operationId:'discard-stable'});
  assert.deepEqual(calls,[['authoringDiscard',{proposalId:'draft'},{projectId:'p',operationId:'discard-stable'}]]);
  const readonly=buildAuthoringTools({}, {allowWrite:false}).find(t=>t.name==='map_discard_proposal');
  await assert.rejects(readonly.handler({proposalId:'draft',operationId:'stable'}),{code:'WRITE_DISABLED'});
});

test('UI context and property proposals forward IDs/revision without changing binding identities',async()=>{
  const calls=[];
  const tools=buildAuthoringTools({mapAuthoring:async(...args)=>{calls.push(args);return{};}},{allowWrite:false});
  await tools.find(t=>t.name==='map_ui_nodes').handler({ids:['title'],limit:1});
  assert.equal(calls[0][0],'uiContext');
  const args={expectedRevision:'ui-r1',patches:[{nodeId:'title',properties:{positionOffset:[16,24],textContent:'续作'}}]};
  await tools.find(t=>t.name==='map_propose_ui').handler(args);
  assert.equal(calls[1][0],'authoringProposeUi');assert.deepEqual(calls[1][1],args);
});
