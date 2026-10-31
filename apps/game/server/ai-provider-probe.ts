import {
  assertSafeProviderUrl,
  AiProviderError,
  type AiProviderModel,
  type AiProviderSecret,
} from './ai-provider-store';

import { safeProviderFetch } from '../../../services/game-server/src/edit/ai/provider-http';

const ANTHROPIC_VERSION = '2023-06-01';
const PROBE_TIMEOUT_MS = 20_000;

export type ProviderTestResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  message: string;
};

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function authHeaders(provider: AiProviderSecret) {
  const common = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
  if (provider.protocol === 'anthropic-messages') {
    return { ...common, 'x-api-key': provider.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return { ...common, Authorization: `Bearer ${provider.apiKey}` };
}

async function safeFetch(provider: AiProviderSecret, path: string, init: RequestInit) {
  const safeBase = await assertSafeProviderUrl(provider.baseUrl);
  return safeProviderFetch(endpoint(safeBase, path), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

function selectedModel(provider: AiProviderSecret, requested?: string) {
  const model = String(requested || provider.defaultModel || provider.models[0]?.id || '').trim();
  if (!model) throw new AiProviderError('MODEL_REQUIRED', '请先为渠道选择模型');
  return model;
}

/** Smallest legal request; the provider's status is reported verbatim. */
export async function testProviderConnection(
  provider: AiProviderSecret,
  requestedModel?: string,
): Promise<ProviderTestResult> {
  const model = selectedModel(provider, requestedModel);
  const started = Date.now();
  try {
    let path: string;
    let body: Record<string, unknown>;
    if (provider.protocol === 'chat-completions') {
      path = '/chat/completions';
      body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false };
    } else if (provider.protocol === 'responses') {
      path = '/responses';
      body = { model, input: 'ping', max_output_tokens: 16 };
    } else {
      path = '/messages';
      body = { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
    }
    const response = await safeFetch(provider, path, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - started;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        ok: false, status: response.status, latencyMs, model,
        message: `HTTP ${response.status}: provider refused the request`,
      };
    }
    return { ok: true, status: response.status, latencyMs, model, message: '连接成功' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, latencyMs: Date.now() - started, model, message: message.slice(0, 240) };
  }
}

function normalizeModelRows(payload: any): AiProviderModel[] {
  const rows = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  const seen = new Set<string>();
  const models: AiProviderModel[] = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.model;
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
    const value = id.trim();
    seen.add(value);
    const name = typeof row?.display_name === 'string' ? row.display_name
      : typeof row?.name === 'string' && row.name !== value ? row.name : undefined;
    models.push(name ? { id: value, name } : { id: value });
  }
  return models.slice(0, 200);
}

export async function fetchProviderModels(provider: AiProviderSecret): Promise<AiProviderModel[]> {
  try {
    const response = await safeFetch(provider, '/models', {
      method: 'GET',
      headers: authHeaders(provider),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiProviderError(
        'MODELS_UNAVAILABLE',
        `模型列表不可用（HTTP ${response.status}）`,
        response.status === 401 ? 401 : 502,
      );
    }
    const payload = await response.json().catch(() => ({}));
    return normalizeModelRows(payload);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('MODELS_UNAVAILABLE', (error as Error).message || '无法获取模型列表', 502);
  }
}
