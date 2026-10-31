import { FileDictRDA } from '@box/schema/code-editor/code-editor-common-state';
import { UITreeRDA } from '@box/schema/project/ui-rda/defs';
import type { EditServerState } from '../edit-server-schema';
import type { CodeEditorServerController } from '../code-editor/code-editor-server-controller';

/** Replica change callbacks are deferred; CAS must read the actual RDA store. */
export function readLiveScripts(state: EditServerState, controller?: CodeEditorServerController) {
  const replica = controller?.fileDictReplica;
  if (!replica?.state) return Object.values(state.codeEditor.fileDict).map(file => ({ ...file }));
  const raw = replica.state() as typeof FileDictRDA.stateSchema.identity;
  try { return Object.values(raw).map(file => ({ ...file })); }
  finally { FileDictRDA.stateSchema.free(raw); }
}

export function readLiveUi(state: EditServerState) {
  const store = state.replica.projectStore?.stores.uiTree;
  if (!store) return structuredClone(state.replica.project.uiTree);
  const raw = store.state(UITreeRDA, UITreeRDA.stateSchema.alloc());
  try { return structuredClone(raw); }
  finally { UITreeRDA.stateSchema.free(raw); }
}
