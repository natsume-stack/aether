import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, test } from '@jest/globals'

import {
  createPlayerLauncherDownloadTicket,
  getPlayerLauncherPackageDescriptor,
  verifyPlayerLauncherDownloadTicket,
} from './player-launcher-map-packages'
import { getPlayResourceCacheManifest } from './play-resource-cache'
import { validateDescriptor } from '../../player-launcher/electron/security/package-descriptor'

const roots: string[] = []
const previousLibraryPath = process.env.BOX_PLAY_LIBRARY_PATH
const previousPermissionSecret = process.env.PERMISSION_TOKEN_SECRET
const previousRuntimeCachePath = process.env.BOX_RUNTIME_CACHE_PATH

function writeBlob(root: string, contents: string | Buffer) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
  const hash = crypto.createHash('sha256').update(bytes).digest('base64url')
  fs.writeFileSync(path.join(root, hash), bytes)
  return { hash, bytes }
}

function createPublishedWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-launcher-pack-'))
  roots.push(root)
  const data = path.join(root, 'launch-map', 'data')
  const blobs = path.join(data, 'blobs')
  fs.mkdirSync(blobs, { recursive: true })
  const publicAsset = writeBlob(blobs, 'public terrain fixture')
  const emptyAsset = writeBlob(blobs, Buffer.alloc(0))
  const uiImage = writeBlob(
    blobs,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLhiAAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  const privateAsset = writeBlob(blobs, 'private script fixture')
  const runtimeCacheRoot = path.join(root, 'runtime-cache')
  const derivedRoot = path.join(
    runtimeCacheRoot,
    'play',
    crypto.createHash('sha256').update('play\0permanent-map-001').digest('hex').slice(0, 32),
    'blobs',
  )
  fs.mkdirSync(derivedRoot, { recursive: true })
  const derivedAsset = writeBlob(derivedRoot, 'derived runtime model metadata')
  fs.writeFileSync(path.join(derivedRoot, privateAsset.hash), privateAsset.bytes)
  const permissionHash = 'permission-fixture'
  fs.writeFileSync(path.join(root, 'launch-map', 'manifest.json'), JSON.stringify({
    id: 'launch-map',
    permanentMapId: 'permanent-map-001',
    publicId: 'public-map',
    projectName: '测试地图',
    version: 'v4',
    permissionHash,
  }))
  fs.writeFileSync(path.join(data, 'project-state.json'), JSON.stringify({ permissionHash }))
  fs.writeFileSync(path.join(data, 'runtime-blobs.json'), JSON.stringify({ hashes: [publicAsset.hash, emptyAsset.hash, uiImage.hash, privateAsset.hash] }))
  fs.writeFileSync(path.join(data, 'private-blobs.json'), JSON.stringify({ hashes: [privateAsset.hash] }))
  process.env.BOX_PLAY_LIBRARY_PATH = root
  process.env.BOX_RUNTIME_CACHE_PATH = runtimeCacheRoot
  return { root, publicAsset, emptyAsset, privateAsset, derivedAsset, uiImage }
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
  if (previousLibraryPath === undefined) delete process.env.BOX_PLAY_LIBRARY_PATH
  else process.env.BOX_PLAY_LIBRARY_PATH = previousLibraryPath
  if (previousPermissionSecret === undefined) delete process.env.PERMISSION_TOKEN_SECRET
  else process.env.PERMISSION_TOKEN_SECRET = previousPermissionSecret
  if (previousRuntimeCachePath === undefined) delete process.env.BOX_RUNTIME_CACHE_PATH
  else process.env.BOX_RUNTIME_CACHE_PATH = previousRuntimeCachePath
})

describe('player launcher map package descriptors', () => {
  test('launcher accepts the server-signed descriptor containing an empty public blob', () => {
    const fixture = createPublishedWorld()
    const descriptor = getPlayerLauncherPackageDescriptor('public-map')
    expect(descriptor.required).toContainEqual({
      hash: fixture.emptyAsset.hash,
      size: 0,
      kind: 'static',
      contentType: 'application/octet-stream',
    })
    const trustedKey = {
      keyId: descriptor.signature.keyId,
      publicKey: descriptor.signature.publicKey,
    }
    expect(validateDescriptor(JSON.stringify(descriptor), JSON.stringify(trustedKey))).toEqual(descriptor)
  })

  test('describes image resources with an image MIME type for native WebViews', () => {
    const fixture = createPublishedWorld()
    const descriptor = getPlayerLauncherPackageDescriptor('public-map')
    const image = descriptor.required.find(({ hash }) => hash === fixture.uiImage.hash)

    expect(image?.contentType).toBe('image/png')
  })

  test('signs a stable public-asset allowlist and rejects private hashes', () => {
    const fixture = createPublishedWorld()
    const descriptor = getPlayerLauncherPackageDescriptor('public-map')
    const unsigned = {
      formatVersion: descriptor.formatVersion,
      permanentMapId: descriptor.permanentMapId,
      accessId: descriptor.accessId,
      releaseVersion: descriptor.releaseVersion,
      required: descriptor.required,
      optional: descriptor.optional,
    }
    const digest = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('base64url')
    const signed = { ...unsigned, manifestDigest: descriptor.manifestDigest }
    const keyId = crypto.createHash('sha256').update(JSON.stringify(descriptor.signature.publicKey)).digest('base64url')

    expect(descriptor.manifestDigest).toBe(digest)
    expect(descriptor.permanentMapId).toBe('permanent-map-001')
    expect(descriptor.releaseVersion).toBe('v4')
    expect(descriptor.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: fixture.publicAsset.hash, size: fixture.publicAsset.bytes.length }),
      expect.objectContaining({ hash: fixture.derivedAsset.hash, size: fixture.derivedAsset.bytes.length }),
    ]))
    expect(descriptor.required.map(({ hash }) => hash)).not.toContain(fixture.privateAsset.hash)
    expect(descriptor.signature.keyId).toBe(keyId)
    expect(crypto.verify(
      'SHA256',
      Buffer.from(JSON.stringify(signed)),
      { key: crypto.createPublicKey({ key: descriptor.signature.publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(descriptor.signature.value, 'base64url'),
    )).toBe(true)
    const manifest = getPlayResourceCacheManifest('public-map')
    expect(manifest.hashes).toEqual(expect.arrayContaining([
      fixture.publicAsset.hash, fixture.derivedAsset.hash, fixture.uiImage.hash,
    ]))
    expect(manifest.hashes).not.toContain(fixture.privateAsset.hash)
  })

  test('refuses unsafe and oversized package indexes', () => {
    const fixture = createPublishedWorld()
    const data = path.join(fixture.root, 'launch-map', 'data')
    fs.writeFileSync(path.join(data, 'runtime-blobs.json'), JSON.stringify({ hashes: ['../secret'] }))
    expect(() => getPlayerLauncherPackageDescriptor('launch-map')).toThrow('发布资源索引格式无效')
  })

  test('download tickets bind the current player, map digest, and short expiry', () => {
    process.env.PERMISSION_TOKEN_SECRET = 'player-launcher-test-secret-long-enough'
    const claims = {
      subjectId: 'player-1',
      permanentMapId: 'permanent-map-001',
      manifestDigest: 'manifest-1',
    }
    const { ticket, expiresAt } = createPlayerLauncherDownloadTicket(claims, 1_000)
    expect(expiresAt).toBe(1_300)
    expect(verifyPlayerLauncherDownloadTicket(ticket, claims, 1_001)).toBe(true)
    expect(verifyPlayerLauncherDownloadTicket(ticket, { ...claims, subjectId: 'player-2' }, 1_001)).toBe(false)
    expect(verifyPlayerLauncherDownloadTicket(ticket, { ...claims, manifestDigest: 'manifest-2' }, 1_001)).toBe(false)
    expect(verifyPlayerLauncherDownloadTicket(ticket, claims, 1_300)).toBe(false)
  })
})
