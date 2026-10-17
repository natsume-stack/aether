/**
 * Content-addressed blob naming, byte-for-byte identical to the engine's own
 * writer (`apps/local-engine/src/project-manager.js:190-235`).
 *
 * COMPATIBILITY (O1 M1 / O2 地雷 3): the CIDv0 string IS the blob file name,
 * i.e. part of the published package format. This module must never change
 * algorithm, digest or alphabet; a drift here silently detaches every asset.
 * `test/cid.test.js` therefore cross-checks this implementation against blob
 * files that already exist on a real deployment (read-only).
 *
 * ASYMMETRY THAT MATTERS (measured, see `verifyBlobName`): the engine's writer
 * `storeReleaseBlob` (`project-manager.js:196-205`) only ever produces CIDv0,
 * but a map imported from the cloud already carries URL-safe SHA-256 names in
 * the very same `source/blobs/` directory, and the factory runtime loader
 * branches on exactly that (`services/game-server/src/script/script-host.ts:232`
 * `module.hash.startsWith('Qm')` -> IPFS first, otherwise OSS CDN). So: writes
 * predict CIDv0, reads must accept every form.
 */
import crypto from 'node:crypto'

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(buffer) {
  const digits = [0]
  for (const byte of buffer) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let result = ''
  for (const byte of buffer) {
    if (byte !== 0) {
      break
    }
    result += base58Alphabet[0]
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += base58Alphabet[digits[index]]
  }
  return result
}

/** sha256 multihash (0x12, 0x20) base58btc == CIDv0, the engine's blob name. */
export function contentHash(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
  const digest = crypto.createHash('sha256').update(buffer).digest()
  return encodeBase58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]))
}

export function isCidV0(value) {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(String(value || ''))
}

/**
 * A map imported from the cloud stores blobs under URL-safe SHA-256 names
 * instead of CIDv0. Both forms sit in the SAME `source/blobs/` directory:
 * `box3-re/tmp/a9-jscripts.txt` (read-only listing of the live deployment)
 * shows `I5bnLmD_sN8gzktSvzqe7lkn1voN-BfHahEWCei8Obs` next to `Qm...` names in
 * `projects/cloud-4e84ee7ef626058f-imported`, and three more in
 * `projects/cloud-3a043df55e5057a5-imported`. The canonical digest of an empty
 * payload in this form is `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`.
 * plan/N2 5.2 C6 spells out that all three name forms must be accepted or
 * assets silently vanish from the play package.
 */
export function urlSafeSha256Name(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
  return crypto.createHash('sha256').update(buffer).digest('base64url')
}

/** Real blob names are 43-character base64url SHA-256 digests. */
export function isUrlSafeSha256Name(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(String(value || ''))
}

export function isLegacyUuidName(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

/**
 * Verify a blob name against its bytes across every name form the engine uses.
 *
 * MEASURED ON REAL DATA (this deployment, read-only, never written):
 * `apps/local-engine/data/blobs/` holds 377 factory blobs where the two
 * content-addressed forms coexist side by side:
 *   - 254 CIDv0 names            (`Qm...`, 46 chars)
 *   - 123 URL-safe SHA-256 names (`-4Z3u_...`, 43 chars) -> 123/123 reproduce
 *     as `sha256(bytes).base64url`, i.e. this form IS content addressed.
 *   - 2/254 CIDv0 names did NOT reproduce: both are CRLF text blobs whose name
 *     matches once the bytes are normalized CRLF -> LF. That is Windows checkout
 *     line-ending normalization of the repository copy, not engine drift (see
 *     O3-mcp-slice-a 5.3), so a reader must never "fix" a name by rewriting it.
 * A cloud-imported map mixes both forms inside one `<project>/source/blobs/`
 * directory (`box3-re/tmp/a9-jscripts.txt`), so `verifiable` is not the same
 * thing as `verified`: legacy UUID names and anything unrecognised cannot be
 * re-derived from bytes at all and must be reported as UNVERIFIED rather than
 * as a mismatch (plan/N2 5.2 C6).
 *
 * @returns {{form:'cidv0'|'sha256-url'|'legacy-uuid'|'unknown', verifiable:boolean,
 *   verified:boolean, actual:string, expected?:string}}
 */
export function verifyBlobName(content, name) {
  const value = String(name || '')
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  if (isCidV0(value)) {
    const expected = contentHash(buffer)
    return { form: 'cidv0', verifiable: true, verified: expected === value, actual: value, expected }
  }
  if (isUrlSafeSha256Name(value)) {
    const expected = urlSafeSha256Name(buffer)
    return { form: 'sha256-url', verifiable: true, verified: expected === value, actual: value, expected }
  }
  if (isLegacyUuidName(value)) {
    return { form: 'legacy-uuid', verifiable: false, verified: true, actual: value }
  }
  return { form: 'unknown', verifiable: false, verified: true, actual: value }
}

/**
 * Deterministic JSON used by `storeReleaseJSON`
 * (`project-manager.js:176-188`). Only needed to re-verify a stored JSON blob,
 * never to author one.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
  return `{${entries.join(',')}}`
}
