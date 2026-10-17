import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LocalMapStore, LocalStoreError } from '../src/local-store.js'
import { isCidV0 } from '../src/cid.js'
import { seedProject } from '../mock/engine.js'

function tempProjectsRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-projects-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('readRevision walks the same three files the engine walks', (t) => {
  const root = tempProjectsRoot(t)
  const seeded = seedProject(root, {
    directory: 'yunhai-test',
    permanentMapId: '4c326f298de10dadc3f7',
    name: '测试图',
    localScripts: { 'index.js': 'server' },
  })
  const store = new LocalMapStore(root)
  const revision = store.readRevision('yunhai-test')
  assert.equal(revision.headHash, seeded.projectHash)
  assert.equal(revision.permissionHash, seeded.permissionHash)
  assert.equal(revision.branchName, 'master')
  // Both addresses the engine accepts must resolve to the same directory.
  assert.deepEqual(
    store.readRevision('4c326f298de10dadc3f7'),
    revision,
    'permanentMapId 与目录名必须解析到同一个工程',
  )
})

test('map-local entry scripts are readable from disk and type bits are enforced', (t) => {
  const root = tempProjectsRoot(t)
  seedProject(root, {
    directory: 'maplocal',
    permanentMapId: 'aaaaaaaaaaaaaaaaaaaaaa',
    name: '入口脚本图',
    localScripts: { 'index.js': 'server', 'clientIndex.js': 'client' },
  })
  const store = new LocalMapStore(root)
  const script = store.readMapLocalScript('maplocal', 'index.js', 'server')
  assert.equal(script.shared, false)
  assert.match(script.content, /^\/\/ index\.js/)
  assert.equal(script.nameForm.form, 'cidv0')
  assert.equal(script.contentVerified, true)
  assert.ok(store.listMapLocalScripts('maplocal').length === 2)
  assert.throws(
    () => store.readMapLocalScript('maplocal', 'index.js', 'client'),
    (error) => error instanceof LocalStoreError && error.code === 'LOCAL_SCRIPT_SIDE_MISMATCH',
  )
  assert.throws(
    () => store.readMapLocalScript('maplocal', 'nope.js', 'server'),
    (error) => error.code === 'LOCAL_SCRIPT_NOT_FOUND',
  )
})

/**
 * REAL DATA: a map imported from the cloud stores its blobs under URL-safe
 * SHA-256 names, and those names live in the SAME directory as the CIDv0 ones
 * the factory writer produces (measured census in test/cid.test.js: 254 CIDv0
 * + 123 URL-safe in one real blobs directory). The optimistic lock and the
 * read-back both have to survive that, or every imported map looks broken.
 */
test('the disk chain reads an imported map whose blobs are URL-safe SHA-256 named', (t) => {
  const root = tempProjectsRoot(t)
  const seeded = seedProject(root, {
    directory: 'imported',
    permanentMapId: 'cccccccccccccccccccc',
    name: '云导入图',
    blobNameForm: 'sha256-url',
    localScripts: { 'index.js': 'server', 'clientIndex.js': 'client' },
  })
  assert.ok(!isCidV0(seeded.projectHash), 'seed 出来的整条版本链都必须是 URL-safe 名字')
  assert.equal(seeded.projectHash.length, 43)
  const store = new LocalMapStore(root)
  const revision = store.readRevision('imported')
  assert.equal(revision.headHash, seeded.projectHash, '乐观锁令牌就是这个 43 字符名字')
  const server = store.readMapLocalScript('imported', 'index.js', 'server')
  assert.equal(server.nameForm.form, 'sha256-url')
  assert.equal(server.contentVerified, true)
  assert.equal(server.nameForm.expected, server.hash)
  const client = store.readMapLocalScript('imported', 'clientIndex.js', 'client')
  assert.equal(client.contentVerified, true)
  assert.equal(client.size, Buffer.byteLength(client.content, 'utf8'))
  assert.deepEqual(
    store.listMapLocalScripts('imported').map((item) => [item.entry, item.side, item.type]),
    [
      ['clientIndex.js', 'client', 7],
      ['index.js', 'server', 1],
    ],
  )
})

/**
 * `size` and the digest come from the raw bytes, so a blob that no longer
 * matches its own name is surfaced instead of being handed to the caller as
 * clean content. It must not throw on the read path: the factory reader only
 * checks existence, and claiming the map is broken would be a false alarm.
 */
test('a blob whose bytes drifted from its name is reported as unverified', (t) => {
  const root = tempProjectsRoot(t)
  const seeded = seedProject(root, {
    directory: 'drifty',
    permanentMapId: 'dddddddddddddddddddd',
    name: '坏 blob 图',
    localScripts: { 'index.js': 'server' },
  })
  const store = new LocalMapStore(root)
  const before = store.readMapLocalScript('drifty', 'index.js', 'server')
  assert.equal(before.contentVerified, true)
  fs.writeFileSync(`${root}/drifty/source/blobs/${before.hash}`, '// silently different\n', 'utf8')
  const after = store.readMapLocalScript('drifty', 'index.js', 'server')
  assert.equal(after.nameForm.verifiable, true)
  assert.equal(after.nameForm.verified, false)
  assert.equal(after.contentVerified, false)
  assert.equal(after.nameForm.actual, before.hash)
  assert.notEqual(after.nameForm.expected, after.nameForm.actual)
})

test('an asset with an unknown type bit is not guessed to be the server side', (t) => {
  const root = tempProjectsRoot(t)
  const seeded = seedProject(root, {
    directory: 'weirdtype',
    permanentMapId: 'eeeeeeeeeeeeeeeeeeee',
    name: '异常类型位图',
    localScripts: { 'index.js': 'server' },
  })
  // Rewrite the script index with a type that is neither 1 nor 7
  // (AssetType: internals/schema/group-project/rda.ts:19-37).
  const assetsFile = `${root}/weirdtype/source/blobs/${seeded.scriptAssetsHash}`
  const assets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'))
  assets['index.js'].type = 5
  fs.writeFileSync(assetsFile, JSON.stringify(assets), 'utf8')
  const store = new LocalMapStore(root)
  assert.equal(store.listMapLocalScripts('weirdtype')[0].side, 'unknown')
  assert.throws(
    () => store.readMapLocalScript('weirdtype', 'index.js', 'server'),
    (error) => error.code === 'LOCAL_SCRIPT_SIDE_MISMATCH',
  )
})

test('unavailable and unknown projects fail loudly instead of silently', (t) => {
  const root = tempProjectsRoot(t)
  const missing = new LocalMapStore('')
  assert.equal(missing.available, false)
  assert.match(missing.unavailableReason(), /BOX_MAP_PROJECTS_ROOT/)
  assert.throws(
    () => new LocalMapStore(root).readRevision('no-such-map'),
    (error) => error.code === 'LOCAL_PROJECT_NOT_FOUND',
  )
})

test('a map without permissionHash is reported as needing an editor save', (t) => {
  const root = tempProjectsRoot(t)
  const dir = path.join(root, 'blank')
  fs.mkdirSync(path.join(dir, 'source', 'blobs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ id: 'blank', permanentMapId: '' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'source', 'project-state.json'), JSON.stringify({ formatVersion: 1 }), 'utf8')
  assert.throws(
    () => new LocalMapStore(root).readRevision('blank'),
    (error) => error.code === 'MISSING_PERMISSION_HASH',
  )
})
