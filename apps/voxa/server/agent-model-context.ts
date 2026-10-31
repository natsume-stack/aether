import { projectBytesToSchema, projectV10 } from '@box/voxa-project';

/** Persisted source context, independent of an attached browser. No voxel
 * payloads, credentials or lock ownership tokens are returned. */
export function summarizeAgentModelSource(bytes: Uint8Array, offset = 0, limit = 128, paletteOffset = 0) {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('MODEL_SOURCE_SCOPE_TOO_LARGE');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128 ||
    !Number.isSafeInteger(paletteOffset) || paletteOffset < 0)
    throw new Error('INVALID_CONTEXT_PAGE');
  const decoded = projectBytesToSchema(bytes);
  if (decoded?.version !== 10) throw new Error('MODEL_SOURCE_VERSION_UNSUPPORTED');
  // The package decoder's version is numeric rather than a discriminated union.
  const source = decoded.schema as typeof projectV10.ProjectDataV10Schema.identity;
  const entries = Object.entries(source.nodes);
  if (entries.length > 4096 || source.palette.items.length > 4096 || source.animations.length > 128)
    throw new Error('MODEL_SOURCE_SCOPE_TOO_LARGE');
  const issues: string[] = [];
  for (const [id, resource] of Object.entries(source.voxels))
    if (resource.id !== id) issues.push(`voxel-resource-id-mismatch:${id}`);
  for (const [id,node] of entries) {
    if (node.voxelId && !source.voxels[node.voxelId]) issues.push(`missing-voxel-resource:${id}`);
    if ((node.type === 1 || node.type === 2) && source.nodes[node.parentId]?.type === 3)
      issues.push(`skin-parent-is-bone:${id}`);
  }
  const parts = entries.slice(offset, offset + limit).map(([id, node]) => {
    return { id, name: node.name, type: node.type, parentId: node.parentId,
      childrenIds: node.childrenIds, boneId: node.boneId, skinId: node.skinId, voxelId: node.voxelId,
      position: Array.from(node.position), pivot: Array.from(node.pivot),
      orientation: Array.from(node.quaternion), scale: Array.from(node.scale) };
  });
  return { sourceVersion: decoded.version, totalParts: entries.length, offset, parts,
    nextOffset: offset + parts.length < entries.length ? offset + parts.length : null,
    structuralIssues: issues.slice(0,128),
    paletteCount: source.palette.items.length,
    paletteOffset,
    palette: source.palette.items.slice(paletteOffset,paletteOffset+64).map(item => ({ id: item.id,
      rgb: Array.from(item.rgb), emissive: item.material.emissive })),
    nextPaletteOffset: paletteOffset+64 < source.palette.items.length ? paletteOffset+64 : null,
    animations: source.animations.map(animation => ({ id: animation.id, name: animation.name,
      channelCount: Object.keys(animation.nodes).length, channels: Object.keys(animation.nodes).slice(0,128),
      channelsTruncated: Object.keys(animation.nodes).length > 128,
      keyframeCount: Object.values(animation.nodes).reduce((n,node) => n + node.keyframeList.length, 0) })),
    modelPivot: source.modelPivot ? Array.from(source.modelPivot) : null,
    scope: 'persisted source context; excludes unsaved editor changes, raw voxels and runtime/source equivalence claims' };
}
