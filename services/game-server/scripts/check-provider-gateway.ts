import assert from 'node:assert/strict';
import { generateText } from 'ai';

import { providerLanguageModel } from '../src/edit/ai/provider-gateway';

const base = {
  id: 'mock',
  owner: 'user' as const,
  name: 'mock',
  baseUrl: 'http://127.0.0.1:19199/v1',
  apiKey: 'sk-mock',
  headers: {},
  defaultModel: 'mock-model',
  models: [{ id: 'mock-model' }],
};

async function main() {
  for (const protocol of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
    const result = await generateText({
      model: providerLanguageModel({ ...base, protocol }, 'mock-model'),
      prompt: 'ping',
    });
    console.log(protocol, JSON.stringify(result.text));
    assert.equal(result.text.trim(), 'pong');
  }
  console.log(JSON.stringify({ ok: true }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
