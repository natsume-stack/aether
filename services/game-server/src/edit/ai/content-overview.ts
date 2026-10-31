import { TreeNodeType } from '@box/schema/project/murda-tree';
import type { EditServerState } from '../edit-server-schema';
import { readEntitySnapshot, entitySnapshotRevision } from './entity-content-domain';
import { readUiContent, uiContentRevision } from './ui-content-domain';

/** Metadata-only response from authoritative stores. Root/group bookkeeping
 * nodes are not scene entities; no script bodies or camera actions required.
 */
export function readContentOverview(state: EditServerState) {
  const entities = readEntitySnapshot(state);
  const ui = readUiContent(state);
  return {
    entityCount: Object.values(entities.tree).filter(node => node.type === TreeNodeType.leaf).length,
    uiNodeCount: Object.values(ui).filter(node => node.value).length,
    contentRevisions: {
      entities: entitySnapshotRevision(entities),
      ui: uiContentRevision(ui),
    },
    assets: Object.keys(entities.assets).filter(name => /^(mesh|gltf)\//.test(name)),
  };
}
