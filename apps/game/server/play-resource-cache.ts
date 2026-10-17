import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { findPlayWorld } from './play-worlds'

const SIGNING_KEY_FILE = 'resource-cache-signing-key.json'
const HASH_PATTERN = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|[A-Za-z0-9_-]{32,128})$/

export type PlayResourceCacheManifest = {
  worldId: string
  version: string
  hashes: string[]
  signature: {
    algorithm: 'ES256'
    publicKey: Record<string, string>
    value: string
  }
}

function libraryRoot() {
  const root = String(process.env.BOX_PLAY_LIBRARY_PATH || '').trim()
  if (!root) throw new Error('游玩地图库未配置')
  return root
}

function signingKeyPath() {
  return path.join(libraryRoot(), SIGNING_KEY_FILE)
}

function atomicWrite(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

type SigningKey = {
  privateKey: string
  publicKey: Record<string, string>
}

/**
 * The private key remains on the Play host. Its public counterpart is safe to
 * return to a browser and lets the worker reject altered manifests before it
 * writes anything into Cache Storage.
 */
function getOrCreateSigningKey(): SigningKey {
  try {
    const stored = JSON.parse(fs.readFileSync(signingKeyPath(), 'utf8')) as Partial<SigningKey>
    if (
      typeof stored.privateKey === 'string' &&
      stored.publicKey &&
      stored.publicKey.kty === 'EC' &&
      stored.publicKey.crv === 'P-256'
    ) {
      return stored as SigningKey
    }
    throw new Error('密钥格式无效')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法读取资源清单签名密钥：${(error as Error).message}`)
    }
  }
  // This repository still carries an older Node type declaration that does
  // not expose the `ec` overload or JWK encoding. Node 22 supports both;
  // keep the boundary narrow instead of weakening the runtime algorithm.
  const generateEcPair = crypto.generateKeyPairSync as unknown as (
    type: 'ec',
    options: { namedCurve: string },
  ) => {
    publicKey: { export(options: unknown): unknown }
    privateKey: { export(options: unknown): unknown }
  }
  const pair = generateEcPair('ec', { namedCurve: 'prime256v1' })
  const key = {
    privateKey: String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' })),
    publicKey: pair.publicKey.export({ format: 'jwk' }) as Record<string, string>,
  }
  atomicWrite(signingKeyPath(), key)
  return key
}

export function getPlayResourceSigningIdentity() {
  const key = getOrCreateSigningKey()
  const keyId = crypto
    .createHash('sha256')
    .update(JSON.stringify(key.publicKey))
    .digest('base64url')
  return { keyId, publicKey: key.publicKey }
}

export function signPlayResourcePayload(payload: string) {
  const key = getOrCreateSigningKey()
  const signer = crypto.createSign('SHA256')
  signer.update(payload)
  signer.end()
  return signer.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
}

function manifestPayload(worldId: string, version: string, hashes: string[]) {
  return JSON.stringify({ worldId, version, hashes })
}

function signManifest(worldId: string, version: string, hashes: string[]) {
  const { keyId, publicKey } = getPlayResourceSigningIdentity()
  return {
    algorithm: 'ES256' as const,
    keyId,
    publicKey,
    value: signPlayResourcePayload(manifestPayload(worldId, version, hashes)),
  }
}

function readHashList(file: string) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { hashes?: unknown }
    if (!Array.isArray(value.hashes) || !value.hashes.every((hash) => typeof hash === 'string' && HASH_PATTERN.test(hash))) {
      throw new Error('资源索引格式无效')
    }
    return value.hashes
  } catch (error) {
    throw new Error(`无法读取发布资源索引：${(error as Error).message}`)
  }
}

function derivedRuntimePath(mapId: string) {
  const root = path.resolve(
    String(process.env.BOX_RUNTIME_CACHE_PATH || path.join(process.cwd(), 'runtime-cache')),
  )
  const digest = crypto
    .createHash('sha256')
    .update(`play\0${mapId || 'default'}`)
    .digest('hex')
    .slice(0, 32)
  return path.join(root, 'play', digest, 'blobs')
}

/**
 * The Play runtime writes pre-baked public model metadata and similar derived
 * assets outside a published world's immutable data directory. They are still
 * content-addressed, so only accept direct blob filenames that are valid
 * hashes. A runtime may have no derived assets yet; that is not an error.
 */
function readDerivedHashList(mapId: string) {
  const blobs = derivedRuntimePath(mapId)
  try {
    return fs
      .readdirSync(blobs, { withFileTypes: true })
      .filter((entry) => entry.isFile() && HASH_PATTERN.test(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`无法读取运行时派生资源：${(error as Error).message}`)
  }
}

export function getPlayResourceCacheDerivedAssets(mapId: string) {
  const blobs = derivedRuntimePath(mapId)
  return readDerivedHashList(mapId).map((hash) => ({
    hash,
    path: path.join(blobs, hash),
  }))
}

/**
 * Builds a strict static-resource whitelist for a published world. Every
 * script and publication-control blob is listed in private-blobs.json and is
 * removed here before the browser is ever told what it may persist locally.
 */
export function getPlayResourceCacheManifest(reference: string): PlayResourceCacheManifest {
  const world = findPlayWorld(reference)
  if (!world) throw new Error('地图不存在')
  const dataRoot = path.join(libraryRoot(), world.id, 'data')
  const runtime = readHashList(path.join(dataRoot, 'runtime-blobs.json'))
  const privateHashes = new Set(readHashList(path.join(dataRoot, 'private-blobs.json')))
  // A public access ID can be changed by the owner. The permanent map ID is
  // immutable and therefore keeps a player's verified resource cache reusable
  // across access-ID changes.
  const mapId = world.permanentMapId
  // Derived files are generated only by the Play runtime and are exposed by
  // the same read-only content router. Include them after a runtime has loaded
  // the world, while preserving the private publication deny-list as a hard
  // boundary for every browser cache manifest.
  const derived = getPlayResourceCacheDerivedAssets(mapId).map(({ hash }) => hash)
  const hashes = [...new Set([...runtime, ...derived].filter((hash) => !privateHashes.has(hash)))].sort()
  const version = crypto
    .createHash('sha256')
    .update(JSON.stringify({ worldId: mapId, version: world.version, hashes }))
    .digest('hex')
    .slice(0, 24)
  return { worldId: mapId, version, hashes, signature: signManifest(mapId, version, hashes) }
}
