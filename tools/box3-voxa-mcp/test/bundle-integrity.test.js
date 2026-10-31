import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectProjectSource, inspectResourceIntegrity, voxaContentHash } from '../src/bundle-integrity.js'

test('VOXA content multihash matches the local store empty-resource identifier', () => {
  assert.equal(voxaContentHash(Buffer.alloc(0)), 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
})

function fixture() {
  const resources = new Map(['model-data.bin', 'model-meta.bin', 'preview.bin'].map(name => [name, Buffer.from(name)]))
  const manifest = { format: 'box-voxa-project', formatVersion: 1,
    resources: [...resources].map(([name, bytes]) => ({ name, hash: voxaContentHash(bytes) })) }
  const meta = { dataHash: voxaContentHash(resources.get('model-data.bin')) }
  return { resources, manifest, meta }
}

test('a present dataHash is insufficient: altered runtime bytes, preview or declaration fail integrity', () => {
  const { resources, manifest, meta } = fixture()
  assert.equal(inspectResourceIntegrity(manifest, meta, resources).passed, true)
  const changed = new Map(resources); changed.set('model-data.bin', Buffer.from('tampered'))
  const invalid = inspectResourceIntegrity(manifest, meta, changed)
  assert.equal(invalid.dataHashPresent, true)
  assert.equal(invalid.dataHashMatches, false)
  assert.equal(invalid.passed, false)
  const badPreview = new Map(resources); badPreview.set('preview.bin', Buffer.from('stale preview bytes'))
  assert.equal(inspectResourceIntegrity(manifest, meta, badPreview).passed, false)
  const duplicate = { ...manifest, resources: [...manifest.resources, manifest.resources[0]] }
  assert.equal(inspectResourceIntegrity(duplicate, meta, resources).passed, false)
  const missing = { ...manifest, resources: manifest.resources.filter(row => row.name !== 'model-data.bin') }
  assert.equal(inspectResourceIntegrity(missing, meta, resources).passed, false)
  assert.equal(inspectResourceIntegrity(null, meta, resources).passed, false)
})

test('runtime-only, corrupt and unsupported source never become an editable project', () => {
  assert.equal(inspectProjectSource({}, null).editable, false)
  assert.equal(inspectProjectSource({ projectBytesToSchema() { throw new Error('bad binary') } }, Buffer.from('invalid')).editable, false)
  assert.equal(inspectProjectSource({ projectBytesToSchema: () => ({ version: 7, schema: {} }) }, Buffer.from('v7')).editable, false)
  const source = { nodes: { wing: { name: '左翼', type: 'skin', parentId: 'root' } }, voxels: { one: { id: 'one' } },
    palette: { items: [1, 2] }, animations: [{ name: 'flight' }], hitBox: {}, modelPivot: [0,0,0] }
  const result = inspectProjectSource({ projectBytesToSchema: () => ({ version: 10, schema: source }) }, Buffer.from('valid'))
  assert.equal(result.editable, true)
  assert.equal(result.nodeCount, 1)
  assert.equal(result.animationCount, 1)
  assert.equal(result.parts[0].name, '左翼')
  assert.equal('voxels' in result, false, 'read-only overview does not expose whole voxel payloads')
})

test('decodable source with absent voxel IDs or skin parented directly to bone is not editor-ready', () => {
  const schema = { nodes: { wing: { type: 1, parentId: 'bone', voxelId: 'wing' }, bone: { type: 3 } },
    voxels: { wing: { id: '' } }, palette: { items: [] }, animations: [] }
  const result = inspectProjectSource({ projectBytesToSchema: () => ({ version: 10, schema }) }, Buffer.from('source'))
  assert.equal(result.available, true)
  assert.equal(result.editable, false)
  assert.deepEqual(result.structuralIssues, ['voxel-resource-id-mismatch:wing', 'skin-parent-is-bone:wing'])
})
