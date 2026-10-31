import { tool } from 'ai';
import { z } from 'zod';
import { EditServerState } from '../edit-server-schema';
import { previewScript, scriptRevision, scriptReviewRevision } from './script-preview';
import { checkScriptIsolated } from './script-check-worker';
import type { CodeEditorServerController } from '../code-editor/code-editor-server-controller';
import { readLiveScripts, readLiveUi } from './script-live-state';

/** Read-only review capabilities, distinct from legacy script mutation tools. */
export function createScriptReviewTools(state: EditServerState, controller?: CodeEditorServerController) {
  return {
    scriptCheck: tool({
      description: 'Read-only candidate TypeScript and UI binding check in a bounded worker. Uses live script/UI snapshots and shipped declarations. Does not execute code; unavailable is not a pass.',
      inputSchema: z.object({ fileId: z.string(), expectedRevision: z.string(),
        policy: z.enum(['strict', 'no-new-errors']).default('strict'),
        edits: z.array(z.object({ index: z.number().int().min(0), deleteCount: z.number().int().min(0), text: z.string().max(500000) })).min(1).max(64) }),
      execute: async ({ fileId, expectedRevision, edits, policy }) => {
        const file = readLiveScripts(state, controller).find(file => file.fileId === fileId);
        if (!file) return { success: false, code: 'FILE_NOT_FOUND', error: 'File not found' };
        const draft = previewScript(file, expectedRevision, edits);
        const uiTree = readLiveUi(state);
        const files = readLiveScripts(state, controller);
        const reviewRevision = scriptReviewRevision(files, uiTree);
        const check = await checkScriptIsolated({ ...file }, files, draft.content, uiTree, policy);
        const current = readLiveScripts(state, controller).find(file => file.fileId === fileId);
        return { success: true, fileId, baseRevision: draft.baseRevision, check,
          reviewRevision, dependenciesStillMatch: reviewRevision === scriptReviewRevision(readLiveScripts(state, controller), readLiveUi(state)),
          sourceStillMatches: !!current && scriptRevision(current) === draft.baseRevision, applied: false, persisted: false };
      },
    }),
    scriptPreview: tool({
      description: 'Preview bounded script edits against the exact readScript revision. Does not write or typecheck. Indices are UTF-16 offsets in the original source.',
      inputSchema: z.object({ fileId: z.string(), expectedRevision: z.string(),
        edits: z.array(z.object({ index: z.number().int().min(0), deleteCount: z.number().int().min(0), text: z.string().max(500000) })).min(1).max(64) }),
      execute: async ({ fileId, expectedRevision, edits }) => {
        const file = readLiveScripts(state, controller).find(file => file.fileId === fileId);
        if (!file) return { success: false, code: 'FILE_NOT_FOUND', error: 'File not found' };
        return previewScript(file, expectedRevision, edits);
      },
    }),
  };
}
