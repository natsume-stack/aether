import assert from 'node:assert/strict';

import {
  normalizeProviderBaseUrl,
  providerApiBaseUrl,
  providerEndsWithVersion,
  providerModelsUrls,
  providerRequestUrl,
} from '../src/edit/ai/provider-url';
import { normalizeModelRows } from '../src/edit/ai/provider-models';

assert.equal(normalizeProviderBaseUrl('https://ai.mosslab.internal/'), 'https://ai.mosslab.internal');
assert.equal(normalizeProviderBaseUrl('  https://host/v1//  '), 'https://host/v1');
assert.equal(normalizeProviderBaseUrl('https://host/v1/chat/completions'), 'https://host/v1');
assert.equal(normalizeProviderBaseUrl('https://host/chat/completions'), 'https://host');
assert.equal(normalizeProviderBaseUrl('https://host/openai/v1/models'), 'https://host/openai/v1');
assert.throws(() => normalizeProviderBaseUrl('   '));

assert.equal(providerEndsWithVersion('https://host/v1'), true);
assert.equal(providerEndsWithVersion('https://host/paas/v4'), true);
assert.equal(providerEndsWithVersion('https://host/v1beta'), false);
assert.equal(providerEndsWithVersion('https://host/anthropic'), false);

assert.equal(providerApiBaseUrl('https://ai.mosslab.internal'), 'https://ai.mosslab.internal/v1');
assert.equal(providerApiBaseUrl('https://ai.mosslab.internal/v1'), 'https://ai.mosslab.internal/v1');
assert.equal(providerApiBaseUrl('https://host/api/coding/paas/v4'), 'https://host/api/coding/paas/v4');
assert.equal(providerApiBaseUrl('https://host/anthropic'), 'https://host/anthropic/v1');

assert.equal(
  providerRequestUrl('https://ai.mosslab.internal', 'chat-completions'),
  'https://ai.mosslab.internal/v1/chat/completions',
);
assert.equal(
  providerRequestUrl('https://ai.mosslab.internal/v1/chat/completions', 'chat-completions'),
  'https://ai.mosslab.internal/v1/chat/completions',
);
assert.equal(
  providerRequestUrl('https://host/v1', 'responses'),
  'https://host/v1/responses',
);
assert.equal(
  providerRequestUrl('https://api.anthropic.com', 'anthropic-messages'),
  'https://api.anthropic.com/v1/messages',
);
assert.equal(
  providerRequestUrl('https://host/anthropic', 'anthropic-messages'),
  'https://host/anthropic/v1/messages',
);

assert.deepEqual(providerModelsUrls('https://ai.mosslab.internal'), ['https://ai.mosslab.internal/v1/models']);
assert.deepEqual(providerModelsUrls('https://host/v1/'), ['https://host/v1/models']);
assert.deepEqual(providerModelsUrls('https://host/api/coding/paas/v4'), [
  'https://host/api/coding/paas/v4/models',
  'https://host/api/coding/paas/v4/v1/models',
]);
assert.deepEqual(providerModelsUrls('https://host/anthropic'), [
  'https://host/anthropic/v1/models',
  'https://host/v1/models',
  'https://host/models',
]);
assert.deepEqual(providerModelsUrls('https://host/apps/anthropic'), [
  'https://host/apps/anthropic/v1/models',
  'https://host/v1/models',
  'https://host/models',
  'https://host/compatible-mode/v1/models',
]);

assert.deepEqual(normalizeModelRows({ data: [{ id: 'gpt-4', owned_by: 'openai' }, { id: 'gpt-4' }] }), [
  { id: 'gpt-4' },
]);
assert.deepEqual(
  normalizeModelRows({ models: [{ slug: 'glm-4' }, { id: 'kimi' }, { name: 'models/gemini-x' }] }),
  [{ id: 'glm-4' }, { id: 'kimi' }, { id: 'gemini-x' }],
);
assert.deepEqual(normalizeModelRows({ data: [{ id: 'a', display_name: 'A' }] }), [{ id: 'a', name: 'A' }]);
assert.deepEqual(normalizeModelRows({ data: [] }), []);
assert.deepEqual(normalizeModelRows(null), []);

console.log('provider endpoint checks passed');
