import assert from 'node:assert/strict';

import { cacheHitRate, parseProviderUsage } from '../src/edit/ai/provider-usage';

const deepseek = parseProviderUsage('chat-completions', {
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 },
});
assert.deepEqual(deepseek, { input: 1000, output: 50, cached: 800, cacheWrite: 0, cacheMiss: 200 });
assert.equal(Math.round(cacheHitRate(deepseek) * 100), 80);

const openai = parseProviderUsage('chat-completions', {
  usage: { prompt_tokens: 2000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1500 } },
});
assert.equal(openai.cached, 1500);
assert.equal(openai.cacheMiss, 500);

const responses = parseProviderUsage('responses', {
  response: { usage: { input_tokens: 2000, output_tokens: 100, input_tokens_details: { cached_tokens: 1200 } } },
});
assert.equal(responses.input, 2000);
assert.equal(responses.cached, 1200);

const anthropic = parseProviderUsage('anthropic-messages', {
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 200 },
});
assert.deepEqual(anthropic, { input: 1200, output: 20, cached: 900, cacheWrite: 200, cacheMiss: 300 });

const empty = parseProviderUsage('chat-completions', {});
assert.deepEqual(empty, { input: 0, output: 0, cached: 0, cacheWrite: 0, cacheMiss: 0 });

console.log('provider usage cache accounting passed');
