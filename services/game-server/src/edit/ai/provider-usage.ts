/** Normalized prompt-cache accounting across OpenAI-compatible, DeepSeek and Anthropic payloads. */
export type ProviderUsage = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  cacheMiss: number;
};

function numberFrom(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function parseProviderUsage(protocol: string, payload: any): ProviderUsage {
  const usage = payload?.usage ?? payload?.response?.usage ?? payload?.message?.usage ?? {};
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const input = numberFrom(usage.prompt_tokens, usage.input_tokens, usage.inputTokens);
  const output = numberFrom(usage.completion_tokens, usage.output_tokens, usage.outputTokens);
  const cached = numberFrom(
    details.cached_tokens,
    usage.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
  );
  const cacheWrite = numberFrom(usage.cache_creation_input_tokens, usage.cache_write_tokens);
  const explicitMiss = numberFrom(usage.prompt_cache_miss_tokens);
  const cacheMiss = explicitMiss || (input > cached ? input - cached : 0);
  if (protocol === 'anthropic-messages') {
    // Anthropic reports uncached input separately from cache reads/writes.
    const total = numberFrom(usage.input_tokens) + cached + cacheWrite;
    return { input: total || input, output, cached, cacheWrite, cacheMiss: Math.max(0, (total || input) - cached) };
  }
  return { input, output, cached, cacheWrite, cacheMiss };
}

export function cacheHitRate(usage: ProviderUsage) {
  if (!usage.input) return 0;
  return Math.min(1, usage.cached / usage.input);
}
