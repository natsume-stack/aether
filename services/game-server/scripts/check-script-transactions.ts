import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileDictRDA, FileRDA } from '@box/schema/code-editor/code-editor-common-state';
import { UITreeRDA } from '@box/schema/project/ui-rda/defs';
import { createScriptTools } from '../src/edit/ai/entity-tools';
import { coordinateAuthoring, authoringSessionFor } from '../src/edit/ai/authoring-tools';
import { AuthoringSession } from '../src/edit/ai/authoring-session';
import { AuthoringJournal } from '../src/edit/ai/authoring-journal';
import { createScriptContentDomain } from '../src/edit/ai/script-content-domain';
import { readLiveScripts } from '../src/edit/ai/script-live-state';
import { CodeEditorServerController } from '../src/edit/code-editor/code-editor-server-controller';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-script-tx-'));
  const original = 'world.say("old");\n';
  const source = { ...FileRDA.stateSchema.identity, fileId: 'f1', name: 'index.js', text: original };
  const store = FileDictRDA.createStore({ f1: source });
  const uiStore = UITreeRDA.createStore({});
  const state: any = { codeEditor: { fileDict: { f1: { ...source } } },
    replica: { project: { uiTree: {} }, projectStore: { stores: { uiTree: uiStore } } },
    game: { state: { replica: { running: false } } } };
  let dispatched = 0;
  const controller: any = { fileDictReplica: { store, action: () => FileDictRDA.action(store),
    state: () => store.state(FileDictRDA, FileDictRDA.stateSchema.alloc()),
    dispatch: (action: any) => { store.apply(FileDictRDA, action); dispatched++; } } };
  const legacy = createScriptTools(state, controller, { info() {} } as any);
  const tools = coordinateAuthoring(state, legacy);
  const invoke = (name: keyof typeof tools, args: any, operationId: string = name) => (tools[name].execute as any)(args, { toolCallId: operationId, messages: [] });
  const first = authoringSessionFor(state)!;
  const journal = new AuthoringJournal(path.join(root, 'map.jsonl'));
  first.attachJournal(journal);
  try {
    const read = await invoke('readScript', { fileId: 'f1' });
    const edits = [{ index: 11, deleteCount: 3, text: 'new' }];
    const proposal = await invoke('authoringProposeScript', { fileId: 'f1', expectedRevision: read.revision, edits });
    assert.equal(proposal.domain, 'script');
    assert.deepEqual(proposal.previews[0].ranges[0], { index: 11, line: 1, deleted: 3, inserted: 3, before: 'old', after: 'new' });
    assert.equal(dispatched, 0);
    const args = { proposalId: proposal.proposalId };
    const applied = await invoke('authoringApply', args, 'apply');
    assert.equal(applied.success, true, JSON.stringify({ applied, actual: readLiveScripts(state, controller)[0].text }));
    assert.equal(readLiveScripts(state, controller)[0].text, 'world.say("new");\n');
    assert.equal(state.codeEditor.fileDict.f1.text, original, 'Fixture intentionally leaves deferred cache stale');
    const savedTexts: string[] = [];
    await CodeEditorServerController.prototype.saveScripts.call({ fileDictReplica: controller.fileDictReplica,
      _state: { buildSystem: { storeContentToS3: async (data: Buffer) => { savedTexts.push(data.toString()); return 'saved'; } } } } as any);
    assert.deepEqual(savedTexts, ['world.say("new");\n']);
    assert.equal((await invoke('readScript', { fileId: 'f1' })).content, 'world.say("new");\n');
    const count = dispatched;
    assert.deepEqual(await invoke('authoringApply', args, 'apply'), applied);
    assert.equal(dispatched, count);
    assert.equal(first.events().events.filter(row => row.operationId === 'apply').every(row => row.kind === 'script'), true);
    assert.equal(fs.readFileSync(path.join(root, 'map.jsonl'), 'utf8').includes('world.say'), false);
    journal.close();
    const restored: AuthoringSession = new AuthoringSession(async (tool, args) => tool === 'authoringApply'
      ? restored.applyProposal(args.proposalId) : restored.revertProposal(args.proposalId));
    restored.registerDomain('script', createScriptContentDomain(state, controller));
    const restoredJournal = new AuthoringJournal(path.join(root, 'map.jsonl'));
    restored.attachJournal(restoredJournal);
    try {
      assert.equal(restored.proposal(proposal.proposalId).domain, 'script');
      assert.equal(restored.proposal(proposal.proposalId).status, 'applied');
      await restored.revertProposal(proposal.proposalId);
      assert.equal(readLiveScripts(state, controller)[0].text, original);
      const multiRead = await invoke('readScript', { fileId: 'f1' });
      const multi = await restored.proposeContent('script', { fileId: 'f1', expectedRevision: multiRead.revision, edits: [
        { index: 11, deleteCount: 1, text: 'a' }, { index: 12, deleteCount: 1, text: '' }, { index: 13, deleteCount: 1, text: 'b' },
      ] });
      const multiApply = await restored.perform('authoringApply', { proposalId: multi.proposalId }, 'multi-apply');
      assert.equal(multiApply.success, true, JSON.stringify(multiApply));
      assert.equal(readLiveScripts(state, controller)[0].text, 'world.say("ab");\n');
      await restored.perform('authoringRevert', { proposalId: multi.proposalId }, 'multi-revert');
      assert.equal(readLiveScripts(state, controller)[0].text, original);
      const beforeInvalid = dispatched;
      await assert.rejects(restored.proposeContent('script', { fileId: 'f1', expectedRevision: multiRead.revision,
        edits: [{ index: 0, deleteCount: original.length, text: 'world.notARealAPI();\n' }] }), { code: 'SCRIPT_CHECK_FAILED' });
      assert.equal(dispatched, beforeInvalid);
      const raceRead = await invoke('readScript', { fileId: 'f1' });
      const race = await restored.proposeContent('script', { fileId: 'f1', expectedRevision: raceRead.revision, edits });
      const pending = restored.perform('authoringApply', { proposalId: race.proposalId }, 'race-apply');
      const humanTimer = setTimeout(() => controller.fileDictReplica.dispatch(controller.fileDictReplica.action().update('f1')
        .text(store.keyIndex.f1.value.stores.text).insert(0, '//during\n')), 10);
      try {
        const result = await pending;
        assert.equal(result.code, 'REVISION_CONFLICT');
        assert.equal(result.inspectRequired, false);
        assert.equal(readLiveScripts(state, controller)[0].text, '//during\n' + original);
      } finally { clearTimeout(humanTimer); }
      controller.fileDictReplica.dispatch(controller.fileDictReplica.action().update('f1').text(store.keyIndex.f1.value.stores.text).remove(0, 9));
      assert.equal(readLiveScripts(state, controller)[0].text, original);
      const current = await invoke('readScript', { fileId: 'f1' });
      const staleProposal = await restored.proposeContent('script', { fileId: 'f1', expectedRevision: current.revision, edits });
      state.game.state.replica.running = true;
      const blocked = await restored.perform('authoringApply', { proposalId: staleProposal.proposalId }, 'preview-block');
      assert.equal(blocked.code, 'PREVIEW_RUNNING');
      assert.equal(restored.proposal(staleProposal.proposalId).status, 'proposed');
      state.game.state.replica.running = false;
      controller.fileDictReplica.dispatch(controller.fileDictReplica.action().update('f1').text(store.keyIndex.f1.value.stores.text).insert(0, '//human\n'));
      assert.equal(state.codeEditor.fileDict.f1.text, original);
      const conflict = await restored.perform('authoringApply', { proposalId: staleProposal.proposalId }, 'stale-apply');
      assert.equal(conflict.code, 'REVISION_CONFLICT');
      assert.equal(readLiveScripts(state, controller)[0].text, '//human\n' + original);
      await (legacy.updateScript.execute as any)({ fileId: 'f1', operations: [
        { type: 'remove', index: 0, count: 8 }, { type: 'insert', index: 0, text: '//agent\n' },
      ] });
      assert.equal(readLiveScripts(state, controller)[0].text, '//agent\n' + original, 'Legacy builder fix preserves both independent actions');
      const legacyText = 'world.oldMissing();\n';
      controller.fileDictReplica.dispatch(controller.fileDictReplica.action().set('f1', { ...source, text: legacyText }));
      const legacyRead = await invoke('readScript', { fileId: 'f1' });
      const legacyArgs = { fileId: 'f1', expectedRevision: legacyRead.revision,
        edits: [{ index: 0, deleteCount: 0, text: '// safe local continuation\n' }] };
      await assert.rejects(restored.proposeContent('script', legacyArgs), { code: 'SCRIPT_CHECK_FAILED' });
      const compatible = await restored.proposeContent('script', { ...legacyArgs, policy: 'no-new-errors' });
      assert.equal(compatible.previews[0].validation.clean, false);
      assert.equal(compatible.previews[0].validation.comparison.introducedErrorCount, 0);
      assert.equal((await restored.perform('authoringApply', { proposalId: compatible.proposalId }, 'compatible-apply')).success, true);
      assert.equal(readLiveScripts(state, controller)[0].text, '// safe local continuation\n' + legacyText);
      assert.equal((await restored.perform('authoringRevert', { proposalId: compatible.proposalId }, 'compatible-revert')).success, true);
      assert.equal(readLiveScripts(state, controller)[0].text, legacyText);
      controller.fileDictReplica.dispatch(controller.fileDictReplica.action().set('f1', { ...source, isShare: true, lockedMapId: 0 }));
      const shared = await invoke('readScript', { fileId: 'f1' });
      await assert.rejects(restored.proposeContent('script', { fileId: 'f1', expectedRevision: shared.revision, edits }), { code: 'SCRIPT_LOCK_REQUIRED' });
    } finally { restoredJournal.close(); }
  } finally { journal.close(); store.free(FileDictRDA); uiStore.free(UITreeRDA); fs.rmSync(root, { recursive: true, force: true }); }
  const evidenceRoot = path.resolve(process.cwd(), '../../.local-evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(evidenceRoot, 'script-transactions-integration.json'), JSON.stringify({
    at: new Date().toISOString(), scope: 'Local fixture using actual FileDictRDA and UITreeRDA stores; not a live community-map application',
    passed: true, checks: ['checked proposal', 'localized CRDT apply and exact readback', 'operation deduplication',
      'fresh-store save despite stale cache', 'durable inverse recovery', 'adjacent edit inverse',
      'invalid API refused before write', 'concurrent human edit protected', 'preview running refused',
      'stale-cache conflict refused', 'independent legacy action builders', 'shared lock required',
      'exact text diff review', 'strict rejects legacy diagnostics', 'explicit baseline policy apply and exact inverse'],
  }, null, 2));
  console.log('PASS real script CRDT: checked proposal, apply, exact readback, deduplication, durable inverse recovery and stale-cache conflict refusal');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
