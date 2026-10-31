import { createHash } from 'node:crypto'

// VOXA's local content store uses a base58 SHA256 multihash (not UnixFS).
export function voxaContentHash(bytes) {
  const input = Buffer.concat([Buffer.from([0x12, 0x20]), createHash('sha256').update(bytes).digest()])
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = BigInt(`0x${input.toString('hex')}`)
  let encoded = ''
  while (value) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n }
  return encoded
}

/** Separate integrity/editability from heuristic visual-density thresholds.
 * A public runtime model alone has no editable project, regardless of score.
 */
export function inspectProjectSource(vp, bytes) {
  if (!bytes) return { available: false, editable: false, reason: 'source-project-missing' }
  try {
    const decoded = vp.projectBytesToSchema(new Uint8Array(bytes))
    if (!decoded?.schema || decoded.version !== 10) return { available: true, editable: false,
      version: decoded?.version ?? null, reason: 'source-version-not-supported-for-local-editing' }
    const schema = decoded.schema
    if (!schema.nodes || !schema.voxels || !schema.palette || !Array.isArray(schema.animations))
      throw new Error('Incomplete decoded source schema')
    const nodeEntries = Object.entries(schema.nodes)
    const structuralIssues = []
    for (const [id, voxel] of Object.entries(schema.voxels)) {
      if (voxel.id !== id) structuralIssues.push(`voxel-resource-id-mismatch:${id}`)
    }
    for (const [id, node] of nodeEntries) {
      if (node.type === 1 && !schema.voxels[node.voxelId]) structuralIssues.push(`missing-voxel-resource:${id}`)
      if ((node.type === 1 || node.type === 2) && schema.nodes[node.parentId]?.type === 3)
        structuralIssues.push(`skin-parent-is-bone:${id}`)
    }
    return { available: true, editable: structuralIssues.length === 0, version: decoded.version,
      structuralIssues,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      nodeCount: nodeEntries.length, voxelResourceCount: Object.keys(schema.voxels).length,
      paletteItems: schema.palette.items?.length ?? 0, animationCount: schema.animations.length,
      parts: nodeEntries.slice(0, 128).map(([id, node]) => ({ id, name: node.name,
        type: node.type, parentId: node.parentId })), partsTruncated: nodeEntries.length > 128,
      scope: 'decodable v10 source; not proof of source/runtime equivalence, editable permissions, or visual quality' }
  } catch (error) {
    return { available: false, editable: false, reason: 'source-project-invalid', error: String(error.message || error).slice(0, 200) }
  }
}

export function inspectResourceIntegrity(manifest, meta, resources) {
  const data = resources.get('model-data.bin')
  const rows = Array.isArray(manifest?.resources) ? manifest.resources : []
  const names = new Set()
  const declared = rows.map(value => {
    const row = value || {}
    const duplicate = names.has(row.name)
    names.add(row.name)
    const bytes = resources.get(row.name)
    const actual = bytes ? voxaContentHash(bytes) : null
    return { name: row.name, expectedHash: row.hash, actualHash: actual,
      ok: !duplicate && typeof row.hash === 'string' && actual !== null && actual === row.hash }
  })
  const manifestOk = manifest?.format === 'box-voxa-project' && manifest?.formatVersion === 1
    && declared.length > 0 && declared.every(row => row.ok)
    && ['model-data.bin', 'model-meta.bin', 'preview.bin'].every(name => names.has(name))
  const dataHashMatches = !!data && typeof meta?.dataHash === 'string' && voxaContentHash(data) === meta.dataHash
  return { manifestOk, resources: declared, dataHashPresent: !!meta?.dataHash,
    dataHashMatches, passed: manifestOk && dataHashMatches }
}
