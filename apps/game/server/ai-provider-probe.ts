import {
  assertSafeProviderUrl,
  AiProviderError,
  type AiProviderModel,
  type AiProviderSecret,
} from './ai-provider-store';

import { providerModelsUrls, providerRequestUrl } from '../../../services/game-server/src/edit/ai/provider-url';
import { normalizeModelRows } from '../../../services/game-server/src/edit/ai/provider-models';
import { safeProviderFetch } from '../../../services/game-server/src/edit/ai/provider-http';

const ANTHROPIC_VERSION = '2023-06-01';
const PROBE_TIMEOUT_MS = 20_000;
const ERROR_BODY_MAX_CHARS = 512;

export type ProviderTestResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  message: string;
};

function authHeaders(provider: AiProviderSecret) {
  const common = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
  if (provider.protocol === 'anthropic-messages') {
    return { ...common, 'x-api-key': provider.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return { ...common, Authorization: `Bearer ${provider.apiKey}` };
}

function redact(provider: AiProviderSecret, value: string) {
  let text = String(value || '');
  const secrets = [provider.apiKey, ...Object.values(provider.headers || {})];
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('***');
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_MAX_CHARS);
}

function providerMessage(provider: AiProviderSecret, raw: string) {
  const text = redact(provider, raw);
  if (!text) return '';
  try {
    const payload = JSON.parse(raw);
    const detail = payload?.error?.message ?? payload?.message ?? payload?.error ?? payload?.detail;
    if (typeof detail === 'string' && detail.trim()) return redact(provider, detail);
  } catch {
    // Not JSON: fall through to the truncated body.
  }
  return text;
}

function describeError(error: unknown) {
  const value = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  const code = String(value?.cause?.code || value?.code || '');
  const message = String(value?.cause?.message || value?.message || error || '');
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/i.test(code) || /certificate|self-signed/i.test(message)) {
    return 'HTTPS 证书校验失败：当前运行环境不信任该服务器的证书';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return '域名解析失败：请检查 Base URL 或运行环境的 DNS';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(code)) return '无法连接 Base URL：连接被拒绝或超时';
  return message || 'AI provider request failed';
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
    const base = await assertSafeProviderUrl(provider.baseUrl);
    let body: Record<string, unknown>;
    if (provider.protocol === 'chat-completions') {
      body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false };
    } else if (provider.protocol === 'responses') {
      body = { model, input: 'ping', max_output_tokens: 16 };
    } else {
      body = { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
    }
    const response = await safeProviderFetch(providerRequestUrl(base, provider.protocol), {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const detail = providerMessage(provider, text);
      return {
        ok: false, status: response.status, latencyMs, model,
        message: `HTTP ${response.status}${detail ? `：${detail}` : '：provider refused the request'}`,
      };
    }
    return { ok: true, status: response.status, latencyMs, model, message: '连接成功' };
  } catch (error) {
    return { ok: false, status: 0, latencyMs: Date.now() - started, model, message: describeError(error).slice(0, 240) };
  }
}

/** Tries the cc-switch candidate list; only 404/405 fall through to the next endpoint. */
export async function fetchProviderModels(provider: AiProviderSecret): Promise<AiProviderModel[]> {
  let base: string;
  try {
    base = await assertSafeProviderUrl(provider.baseUrl);
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError('MODELS_UNAVAILABLE', describeError(error), 502);
  }
  let lastStatus = 0;
  for (const url of providerModelsUrls(base)) {
    let response: Response;
    try {
      response = await safeProviderFetch(url, {
        method: 'GET',
        headers: authHeaders(provider),
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiProviderError('MODELS_UNAVAILABLE', describeError(error), 502);
    }
    if (response.status === 404 || response.status === 405) {
      lastStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = providerMessage(provider, text);
      throw new AiProviderError(
        'MODELS_UNAVAILABLE',
        `模型列表不可用（HTTP ${response.status}${detail ? `：${detail}` : ''}）`,
        response.status === 401 ? 401 : 502,
      );
    }
    const payload = await response.json().catch(() => ({}));
    return normalizeModelRows(payload);
  }
  throw new AiProviderError(
    'MODELS_UNAVAILABLE',
    lastStatus ? `模型列表不可用（HTTP ${lastStatus}）` : '模型列表不可用（没有可用的候选端点）',
    502,
  );
}
