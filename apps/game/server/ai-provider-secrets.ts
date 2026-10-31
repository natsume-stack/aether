import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Provider API keys are encrypted with a process secret, never with a value
 * stored beside the ciphertext. AES-256-GCM authenticates the ciphertext; the
 * key version stays in the row so a future rotation can re-wrap without losing
 * the plaintext during migration.
 */
const ALGORITHM = 'aes-256-gcm';
const KEY_VERSION = 1;
const IV_BYTES = 12;

export type EncryptedProviderKey = {
  version: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  hint: string;
};

function providerSecret() {
  const value = (process.env.AI_PROVIDER_SECRET || '').trim();
  if (value.length < 32) {
    throw new Error('AI_PROVIDER_SECRET must contain at least 32 characters');
  }
  return value;
}

function providerKey() {
  return createHash('sha256').update(providerSecret(), 'utf8').digest();
}

export function isAiProviderSecretConfigured() {
  return (process.env.AI_PROVIDER_SECRET || '').trim().length >= 32;
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
    version: KEY_VERSION,
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
  if (Number(row.key_version ?? KEY_VERSION) !== KEY_VERSION) {
    throw new Error(`Unsupported AI provider key version: ${row.key_version}`);
  }
  const decipher = createDecipheriv(ALGORITHM, providerKey(), Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.tag));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext)),
    decipher.final(),
  ]).toString('utf8');
}
