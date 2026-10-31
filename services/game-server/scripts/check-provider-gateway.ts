import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateText } from 'ai';

import { providerLanguageModel } from '../src/edit/ai/provider-gateway';

/**
 * cc-switch parity: whichever form the operator pastes, the SDK must hit
 * `{root}/v1/{chat/completions|responses|messages}` exactly once.
 */
async function main() {
  (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
  process.env.AI_PROVIDER_ALLOW_PRIVATE = 'true';
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.url || ''));
    request.resume();
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'mock unauthorized' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const expected: Array<[('chat-completions' | 'responses' | 'anthropic-messages'), string, string]> = [
    ['chat-completions', origin, '/v1/chat/completions'],
    ['chat-completions', `${origin}/v1`, '/v1/chat/completions'],
    ['chat-completions', `${origin}/v1/chat/completions`, '/v1/chat/completions'],
    ['responses', origin, '/v1/responses'],
    ['anthropic-messages', origin, '/v1/messages'],
    ['anthropic-messages', `${origin}/anthropic`, '/anthropic/v1/messages'],
  ];

  try {
    for (const [protocol, baseUrl, path] of expected) {
      seen.length = 0;
      try {
        await generateText({
          model: providerLanguageModel({
            id: 'mock',
            owner: 'user',
            name: 'mock',
            protocol,
            baseUrl,
            apiKey: 'sk-mock',
            headers: {},
            defaultModel: 'mock-model',
            models: [{ id: 'mock-model' }],
          }, 'mock-model'),
          prompt: 'ping',
          maxRetries: 0,
        });
        assert.fail(`${protocol} should fail against the 401 mock`);
      } catch (error) {
        assert.ok(error, 'request must reach the mock');
      }
      assert.deepEqual(seen, [path], `${protocol} ${baseUrl} must request ${path}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(JSON.stringify({ ok: true, checks: ['base-root', 'v1-idempotent', 'full-endpoint', 'responses', 'anthropic', 'compat-suffix'] }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
