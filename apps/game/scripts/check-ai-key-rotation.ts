import assert from 'node:assert/strict';
import {encryptAiProviderKey,decryptAiProviderKey} from '../server/ai-provider-secrets';
const saved={...process.env};
const row=(value:ReturnType<typeof encryptAiProviderKey>)=>({key_version:value.version,ciphertext:value.ciphertext,iv:value.iv,tag:value.tag});
try {
  process.env.AI_PROVIDER_SECRET='engineering-key-version-one-at-least-32';process.env.AI_PROVIDER_SECRET_VERSION='1';delete process.env.AI_PROVIDER_SECRET_PREVIOUS;
  const old=encryptAiProviderKey('not-a-real-upstream-key');
  process.env.AI_PROVIDER_SECRET='engineering-key-version-two-at-least-32';process.env.AI_PROVIDER_SECRET_VERSION='2';
  assert.throws(()=>decryptAiProviderKey(row(old)));
  process.env.AI_PROVIDER_SECRET_PREVIOUS=JSON.stringify({'1':'engineering-key-version-one-at-least-32'});
  const migrated=encryptAiProviderKey(decryptAiProviderKey(row(old)));assert.equal(migrated.version,2);
  delete process.env.AI_PROVIDER_SECRET_PREVIOUS;
  assert.throws(()=>decryptAiProviderKey(row(old)));assert.equal(decryptAiProviderKey(row(migrated)),'not-a-real-upstream-key');
  migrated.tag[0]^=1;assert.throws(()=>decryptAiProviderKey(row(migrated)));
  console.log(JSON.stringify({ok:true,checks:['unknown-old-version-denied','migration','old-key-retirement','ciphertext-integrity']}));
} finally {for(const key of ['AI_PROVIDER_SECRET','AI_PROVIDER_SECRET_VERSION','AI_PROVIDER_SECRET_PREVIOUS']) {if(saved[key]===undefined) delete process.env[key];else process.env[key]=saved[key];}}
