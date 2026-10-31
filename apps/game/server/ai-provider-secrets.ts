import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Provider API keys are encrypted with a process secret, never with a value
 * stored beside the ciphertext. AES-256-GCM authenticates the ciphertext; the
 * key version stays in the row so a future rotation can re-wrap without losing
 * the plaintext during migration.
 */
const ALGORITHM = 'aes-256-gcm';
const LEGACY_KEY_VERSION = 1;
const IV_BYTES = 12;

export type EncryptedProviderKey = {
  version: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  hint: string;
};

export function aiProviderKeyVersion():number {
  const version=Number(process.env.AI_PROVIDER_SECRET_VERSION || 1);
  if(!Number.isSafeInteger(version) || version<1 || version>2147483647) throw new Error('Invalid AI provider key version');
  return version;
}
function providerKey(version=aiProviderKeyVersion()) {
  let secret=(process.env.AI_PROVIDER_SECRET || '').trim();
  if(version!==aiProviderKeyVersion()) {
    let previous:unknown;
    try {previous=JSON.parse(process.env.AI_PROVIDER_SECRET_PREVIOUS || '{}');} catch {throw new Error('Invalid AI provider keyring configuration');}
    if(!previous || typeof previous!=='object' || Array.isArray(previous)) throw new Error('Invalid AI provider keyring configuration');
    secret=String((previous as Record<string,unknown>)[String(version)] || '').trim();
  }
  if(secret.length<32) throw new Error('AI provider encryption key version is unavailable');
  return createHash('sha256').update(secret,'utf8').digest();
}
export function isAiProviderSecretConfigured() {
  try {providerKey();return true;} catch {return false;}
}

export function aiProviderKeyHint(plaintext: string) {
  const value = String(plaintext || '');
  return value.length <= 4 ? '****' : `\u2026${value.slice(-4)}`;
}

export function encryptAiProviderKey(plaintext: string): EncryptedProviderKey {
  const value = String(plaintext || '');
  if (!value) throw new Error('API key is required');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, providerKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: aiProviderKeyVersion(),
    ciphertext,
    iv,
    tag: cipher.getAuthTag(),
    hint: aiProviderKeyHint(value),
  };
}

export function decryptAiProviderKey(row: {
  key_version?: number | string;
  ciphertext: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  tag: Buffer | Uint8Array;
}) {
  const version=Number(row.key_version ?? LEGACY_KEY_VERSION);
  if(!Number.isSafeInteger(version) || version<1) throw new Error('Invalid AI provider key version');
  const decipher = createDecipheriv(ALGORITHM, providerKey(version), Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.tag));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext)),
    decipher.final(),
  ]).toString('utf8');
}
