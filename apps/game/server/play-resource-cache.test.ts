import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from '@jest/globals'

import {
  getPlayResourceCacheManifest,
} from './play-resource-cache'

const roots: string[] = []

function hash(character: string) {
  return character.repeat(43)
}

function createWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-resource-cache-test-'))
  roots.push(root)
  const id = 'cached-map'
  const data = path.join(root, id, 'data')
  fs.mkdirSync(path.join(data, 'blobs'), { recursive: true })
  const permissionHash = hash('p')
  fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify({
    id,
    permanentMapId: '10000000000000000001',
    publicId: 'cached-map',
    projectName: '缓存测试地图',
    version: 'v1',
    permissionHash,
    mapGroupId: id,
    mapRole: 'main',
    mainProjectId: id,
  }))
  fs.writeFileSync(path.join(data, 'project-state.json'), JSON.stringify({ permissionHash }))
  fs.writeFileSync(path.join(data, 'runtime-blobs.json'), JSON.stringify({
    formatVersion: 1,
    hashes: [hash('a'), hash('b'), hash('c')],
  }))
  fs.writeFileSync(path.join(data, 'private-blobs.json'), JSON.stringify({
    formatVersion: 1,
    hashes: [hash('b')],
  }))
  const derived = path.join(
    root,
    'runtime-cache',
    'play',
    crypto.createHash('sha256').update('play\0' + '10000000000000000001').digest('hex').slice(0, 32),
    'blobs',
  )
  fs.mkdirSync(derived, { recursive: true })
  const derivedHash = hash('d')
  fs.writeFileSync(path.join(derived, derivedHash), '{"generated":true}')
  // Non-hash files in runtime storage must never become browser cache entries.
  fs.writeFileSync(path.join(derived, 'build-cache.json'), '{}')
  process.env.BOX_PLAY_LIBRARY_PATH = root
  process.env.BOX_RUNTIME_CACHE_PATH = path.join(root, 'runtime-cache')
  return { id, staticHashes: [hash('a'), hash('c'), derivedHash], privateHash: hash('b') }
}

afterEach(() => {
  delete process.env.BOX_PLAY_LIBRARY_PATH
  delete process.env.BOX_RUNTIME_CACHE_PATH
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Play resource cache manifest', () => {
  test('publishes signed static blobs by default but never private script blobs', () => {
    const world = createWorld()
    const manifest = getPlayResourceCacheManifest(world.id)

    expect(manifest.worldId).toBe('10000000000000000001')
    expect(manifest.hashes).toEqual(world.staticHashes)
    expect(manifest.hashes).not.toContain(world.privateHash)
    expect(manifest.version).toHaveLength(24)
    expect(
      crypto.verify(
        'SHA256',
        Buffer.from(JSON.stringify({ worldId: manifest.worldId, version: manifest.version, hashes: manifest.hashes })),
        { key: crypto.createPublicKey({ key: manifest.signature.publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(manifest.signature.value, 'base64url'),
      ),
    ).toBe(true)
  })
})
import crypto from 'crypto'
