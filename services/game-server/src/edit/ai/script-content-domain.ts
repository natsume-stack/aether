import type { ContentDomain } from './authoring-session';
import { authoringError } from './authoring-session';
import { checkScriptIsolated } from './script-check-worker';
import { previewScript, scriptRevision, scriptReviewRevision } from './script-preview';
import { readLiveScripts, readLiveUi } from './script-live-state';
import type { EditServerState } from '../edit-server-schema';
import type { CodeEditorServerController } from '../code-editor/code-editor-server-controller';
import { getConfigSync } from '../../../config/server';
import { localSharedScriptLockOwnerId } from '../replica/local-shared-script-state';

export function createScriptContentDomain(state: EditServerState, controller: CodeEditorServerController): ContentDomain {
  const snapshot = () => ({ files: readLiveScripts(state, controller), ui: readLiveUi(state) });
  const revision = () => { const current = snapshot(); return scriptReviewRevision(current.files, current.ui); };
  const refusal = (code: string, error: string) => ({ success: false, code, error, mutationStarted: false });
  const running = () => !!state.game.state.replica.running;
  const writePermission = (source: { isShare: boolean; isUploading: boolean; lockedMapId: number }) => {
    if (source.isUploading) return refusal('SCRIPT_BUSY', 'Script sharing/upload is in progress');
    if (source.isShare) {
      const config = getConfigSync();
      const owner = config?.method === 'local' ? localSharedScriptLockOwnerId(config.containerName || '') : config?.contentId;
      if (!owner || source.lockedMapId !== owner) return refusal('SCRIPT_LOCK_REQUIRED', 'Acquire the shared script lock before modifying it');
    }
    return undefined;
  };

  async function prepare(args: Record<string, any>) {
    const { files, ui } = snapshot();
    const source = files.find(file => file.fileId === args.fileId);
    if (!source) throw authoringError('FILE_NOT_FOUND', 'Script no longer exists');
    const denied = writePermission(source);
    if (denied) throw authoringError(denied.code, denied.error);
    const draft = previewScript(source, args.expectedRevision, args.edits);
    const baseRevision = scriptReviewRevision(files, ui);
    const policy = args.policy || 'strict';
    const check = await checkScriptIsolated(source, files, draft.content, ui, policy);
    if (!check.available || !check.accepted) throw authoringError(check.code || 'SCRIPT_CHECK_FAILED', 'Candidate did not meet script and UI checking policy; inspect scriptCheck diagnostics');
    if (revision() !== baseRevision) throw authoringError('REVISION_CONFLICT', 'Project changed while checking script');
    // Merge adjacent inverse edits, including multiple deletions at one output
    // offset. This makes the inverse unambiguous in original-candidate offsets.
    const inverse: { index: number; deleteCount: number; text: string }[] = [];
    let delta = 0;
    for (const change of draft.changes) {
      const next = { index: change.index + delta, deleteCount: change.text.length, text: change.removed };
      const previous = inverse[inverse.length - 1];
      if (previous && next.index === previous.index + previous.deleteCount) {
        previous.deleteCount += next.deleteCount;
        previous.text += next.text;
      } else inverse.push(next);
      delta += change.text.length - change.deleteCount;
    }
    return { baseRevision, step: { fileId: source.fileId, expectedRevision: draft.baseRevision, edits: args.edits, policy },
      preview: { kind: 'script', fileId: source.fileId, name: source.name, changed: draft.changed,
        validation: { policy, clean: check.clean, comparison: check.comparison },
        ranges: draft.changes.map(change => ({ index: change.index, line: change.line,
          deleted: change.deleteCount, inserted: change.text.length, before: change.removed, after: change.text })) },
      undoToken: JSON.stringify({ version: 1, fileId: source.fileId, expectedRevision: draft.resultRevision,
        resultRevision: draft.baseRevision, edits: inverse }) };
  }

  async function commit(step: Record<string, any>, expected: string, restoring: boolean) {
    if (running()) return refusal('PREVIEW_RUNNING', 'Stop preview before changing scripts');
    if (revision() !== expected) return refusal('REVISION_CONFLICT', 'Project changed before script commit');
    const { files, ui } = snapshot();
    const source = files.find(file => file.fileId === step.fileId);
    if (!source) return refusal('FILE_NOT_FOUND', 'Script no longer exists');
    const denied = writePermission(source);
    if (denied) return denied;
    const draft = previewScript(source, step.expectedRevision, step.edits);
    // Restoring uses the server-held inverse of the exact checked edit and
    // requires the entire post-apply project revision, so no later edit is lost.
    if (!restoring) {
      const check = await checkScriptIsolated(source, files, draft.content, ui, step.policy || 'strict');
      if (!check.available || !check.accepted) return refusal(check.code || 'SCRIPT_CHECK_FAILED', 'Script checking policy failed or unavailable');
    } else if (draft.resultRevision !== step.resultRevision) return refusal('INVALID_UNDO_TOKEN', 'Inverse does not match original script identity');
    // No await between this authoritative check, CRDT action creation and dispatch.
    if (running()) return refusal('PREVIEW_RUNNING', 'Preview started while checking');
    if (revision() !== expected) return refusal('REVISION_CONFLICT', 'Project changed while checking script');
    const currentSource = readLiveScripts(state, controller).find(file => file.fileId === step.fileId);
    if (!currentSource) return refusal('FILE_NOT_FOUND', 'Script no longer exists');
    const currentDenied = writePermission(currentSource);
    if (currentDenied) return currentDenied;
    const replica = controller.fileDictReplica;
    const store = replica?.store.keyIndex[source.fileId];
    if (!store || !replica.state) return refusal('STATE_UNAVAILABLE', 'Authoritative script store unavailable');
    // Map update builders reuse their outer action object. Bind afresh for each
    // operation so a later insert cannot overwrite an earlier remove action.
    const action = () => replica.action().update(source.fileId).text(store.value.stores.text);
    const actions: ReturnType<ReturnType<typeof action>['insert']>[] = [];
    for (const change of draft.changes) {
      if (change.deleteCount) actions.push(action().remove(change.index, change.deleteCount));
      if (change.text) actions.push(action().insert(change.index, change.text));
    }
    for (const operation of actions) replica.dispatch(operation);
    const current = readLiveScripts(state, controller).find(file => file.fileId === source.fileId);
    if (!current || scriptRevision(current) !== draft.resultRevision) {
      return { success: false, code: 'WRITE_NOT_APPLIED', mutationStarted: true, error: 'Script readback differs; inspect actual content' };
    }
    return { success: true, newRevision: revision(), mutationStarted: actions.length > 0 };
  }

  return { revision, prepare, apply: (step, expected) => commit(step, expected, false),
    revert: (token, expected) => {
      const inverse = JSON.parse(token);
      if (inverse.version !== 1) return Promise.resolve(refusal('INVALID_UNDO_TOKEN', 'Unsupported inverse version'));
      return commit(inverse, expected, true);
    } };
}
