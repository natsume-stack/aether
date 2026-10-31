import assert from 'node:assert/strict';

import { getPool } from '../server/local-player-identity';
import {
  assertSafeProviderUrl,
  createAdminAiProvider,
  createAiProvider,
  deleteAdminAiProvider,
  deleteAiProvider,
  getAiProviderSecret,
  initializeAiProviderStore,
  listAdminAiProviders,
  listAiProviders,
  readAiPreferences,
  resolveAiProvider,
  setAdminDefaultAiProvider,
  updateAiProvider,
  writeAiPreference,
} from '../server/ai-provider-store';

const AI_PROVIDER_TEST_NAME = '__check_user_provider__';
const AI_PROVIDER_ADMIN_TEST_NAME = '__check_admin_provider__';

process.env.BOX_DATABASE_URL ||= 'postgres://box@127.0.0.1:15432/box_db_dev';
process.env.AI_PROVIDER_SECRET ||= 'check-ai-provider-secret-0123456789abcdef';

const USER_ID = 1;
const API_KEY = 'sk-check-provider-abcdefghijklmnopqrstuvwxyz';

async function cleanup() {
  const db = getPool();
  if (!db) return;
  await db.query('DELETE FROM box_identity.ai_preferences WHERE user_id = $1 AND workflow = $2', [USER_ID, 'check.provider']);
  await db.query('DELETE FROM box_identity.ai_providers WHERE name IN ($1, $2)', [AI_PROVIDER_TEST_NAME, AI_PROVIDER_ADMIN_TEST_NAME]);
}

async function main() {
  await initializeAiProviderStore();
  await cleanup();
  let providerId = '';
  let adminId = '';
  try {
    await assert.rejects(assertSafeProviderUrl('http://example.com/v1'), /https/);
    await assert.rejects(assertSafeProviderUrl('https://127.0.0.1/v1'), /私有网络|本地/);

    const created = await createAiProvider(USER_ID, {
      name: AI_PROVIDER_TEST_NAME,
      protocol: 'chat-completions',
      baseUrl: 'https://example.com/v1',
      apiKey: API_KEY,
      defaultModel: 'model-a',
      models: ['model-a', { id: 'model-b', name: 'Model B' }],
      headers: { 'X-Check': '1' },
      capabilities: { tools: true, json: true },
    });
    providerId = created.id;
    assert.equal(created.owner, 'user');
    assert.equal(created.keyHint.endsWith('wxyz'), true);
    assert.equal(created.models.length, 2);
    assert.equal((created as any).apiKey, undefined, 'public row must not expose the key');

    const db = getPool()!;
    const raw = await db.query('SELECT api_key_cipher, api_key_iv, api_key_tag, key_hint FROM box_identity.ai_providers WHERE id = $1', [providerId]);
    assert.equal(Buffer.isBuffer(raw.rows[0].api_key_cipher), true);
    assert.equal(Buffer.from(raw.rows[0].api_key_cipher).toString('utf8').includes(API_KEY), false, 'ciphertext must not contain the plaintext key');

    const secret = await getAiProviderSecret(USER_ID, providerId);
    assert.equal(secret.apiKey, API_KEY);
    const resolved = await resolveAiProvider(USER_ID);
    assert.equal(resolved.id, providerId);

    await assert.rejects(
      createAiProvider(USER_ID, { name: AI_PROVIDER_TEST_NAME, protocol: 'chat-completions', baseUrl: 'https://example.com/v1', apiKey: 'x' }),
      /同名/,
    );

    const updated = await updateAiProvider(USER_ID, providerId, { name: AI_PROVIDER_TEST_NAME, defaultModel: 'model-b' });
    assert.equal(updated.defaultModel, 'model-b');
    assert.equal(updated.keyHint.endsWith('wxyz'), true, 'key hint survives a field update');
    assert.equal((await getAiProviderSecret(USER_ID, providerId)).apiKey, API_KEY, 'key survives a field update');

    const preference = await writeAiPreference(USER_ID, {
      workflow: 'check.provider', providerId, model: 'model-b', autonomy: 'autonomous',
    });
    assert.equal(preference.autonomy, 'autonomous');
    assert.equal((await readAiPreferences(USER_ID))['check.provider'].providerId, providerId);

    const admin = await createAdminAiProvider({
      name: AI_PROVIDER_ADMIN_TEST_NAME,
      protocol: 'chat-completions',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-admin-check-abcdefghijklmnopqrstuvwxyz',
      defaultModel: 'admin-model',
    });
    adminId = admin.id;
    assert.equal(admin.owner, 'admin');
    assert.equal(admin.isDefault, true, 'first admin provider becomes the default');
    assert.equal((await listAdminAiProviders()).some((row) => row.id === adminId), true);
    assert.equal((await listAiProviders(USER_ID)).some((row) => row.owner === 'admin'), true);
    await setAdminDefaultAiProvider(adminId);

    const listed = await listAiProviders(USER_ID);
    assert.equal(listed.some((row) => row.id === providerId), true);
    assert.equal(listed.every((row) => !('apiKey' in row)), true);

    assert.equal(await deleteAiProvider(USER_ID, providerId), true);
    assert.equal(await deleteAdminAiProvider(adminId), true);
    providerId = '';
    adminId = '';
    assert.deepEqual(await listAiProviders(USER_ID), []);

    console.log(JSON.stringify({ ok: true }, null, 2));
  } finally {
    if (providerId) await deleteAiProvider(USER_ID, providerId).catch(() => undefined);
    if (adminId) await deleteAdminAiProvider(adminId).catch(() => undefined);
    await cleanup().catch(() => undefined);
    await getPool()?.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
