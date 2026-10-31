import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Logger } from 'pino';
import { safeProviderFetch } from './provider-http';

export type ResolvedProviderProtocol = 'chat-completions' | 'responses' | 'anthropic-messages';
export type ResolvedProvider = {
  id: string;
  owner: 'user' | 'admin';
  name: string;
  protocol: ResolvedProviderProtocol;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  defaultModel: string;
  models: Array<{ id: string; name?: string }>;
  capabilities?: { tools: boolean; json: boolean; vision: boolean };
};
export type ModelSelection = {
  providerId?: string;
  model?: string;
  autonomy?: 'review' | 'autonomous';
};


function internalPlayerServiceUrl() {
  const value = (process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').trim();
  if (!value) throw new Error('BOX_PLAYER_SERVICE_INTERNAL_URL is not configured');
  return value.replace(/\/$/, '');
}

function internalSecret() {
  const value = (process.env.PERMISSION_TOKEN_SECRET || '').trim();
  if (!value) throw new Error('PERMISSION_TOKEN_SECRET is not configured');
  return value;
}

/**
 * The identity service owns provider rows and decryption. The edit runtime asks
 * it over loopback with the shared secret; the browser never receives a key.
 */
export async function resolveUserProvider(
  userId: string,
  providerId: string | undefined,
  logger?: Logger,
): Promise<ResolvedProvider> {
  let response: Response;
  try {
    response = await fetch(`${internalPlayerServiceUrl()}/api/player-ai-internal/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${internalSecret()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, providerId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    logger?.error({ error }, 'Provider resolution request failed');
    throw new Error('AI 渠道解析失败：玩家服务不可达');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger?.warn({ status: response.status }, 'Provider resolution refused');
    throw new Error(`AI 渠道解析失败（HTTP ${response.status}）${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const payload = await response.json().catch(() => ({})) as { provider?: ResolvedProvider };
  const provider = payload.provider;
  if (!provider?.id || !provider.apiKey || !provider.baseUrl || !provider.protocol) {
    throw new Error('AI 渠道解析返回不完整');
  }
  return provider;
}

export function providerLanguageModel(provider: ResolvedProvider, requestedModel?: string): LanguageModel {
  const model = String(requestedModel || provider.defaultModel || provider.models[0]?.id || '').trim();
  if (!model) throw new Error('请先为渠道选择模型');
  const headers = provider.headers || {};
  if (provider.protocol === 'chat-completions') {
    return createOpenAICompatible({
      baseURL: provider.baseUrl,
      fetch: safeProviderFetch,
      apiKey: provider.apiKey,
      name: provider.name || 'provider',
      headers,
    }).chatModel(model);
  }
  if (provider.protocol === 'responses') {
    return createOpenAI({
      baseURL: provider.baseUrl,
      fetch: safeProviderFetch,
      apiKey: provider.apiKey,
      headers,
    }).responses(model);
  }
  if (provider.protocol !== 'anthropic-messages') throw new Error('Unsupported AI protocol');
  return createAnthropic({
    baseURL: provider.baseUrl,
    fetch: safeProviderFetch,
    apiKey: provider.apiKey,
    headers,
  }).messages(model);
}

/** `model` stays a MuUTF8 on the wire for compatibility; new clients send JSON. */
export function parseModelSelection(raw: string): ModelSelection {
  const value = String(raw || '').trim();
  if (!value) return {};
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        return {
          providerId: typeof parsed.providerId === 'string' && parsed.providerId ? parsed.providerId : undefined,
          model: typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined,
          autonomy: parsed.autonomy === 'autonomous' ? 'autonomous' : 'review',
        };
      }
    } catch {
      // fall through to a legacy model id
    }
  }
  return { model: value };
}

/** Rechecked at every autonomous mutation so the administrator can stop a running task. */
export async function assertAiExecutionAllowed(userId: string, mapId: string): Promise<void> {
  const response = await fetch(`${internalPlayerServiceUrl()}/api/player-ai-internal/policy`, {
    method: 'POST', headers: {Authorization: `Bearer ${internalSecret()}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({userId, mapId}), signal: AbortSignal.timeout(5_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('AI execution policy unavailable');
  const result = await response.json() as {allowed?: boolean};
  if (result.allowed !== true) throw new Error('AI execution disabled by administrator');
}

export async function aiExecutionEvent(userId:string,input:Record<string,unknown>):Promise<{runId?:string}> {
  const response=await fetch(`${internalPlayerServiceUrl()}/api/player-ai-internal/execution`,{
    method:'POST',headers:{Authorization:`Bearer ${internalSecret()}`,'Content-Type':'application/json'},
    body:JSON.stringify({userId,...input}),signal:AbortSignal.timeout(5000),redirect:'error',
  });
  if(!response.ok) throw new Error(`AI execution ledger refused request (HTTP ${response.status})`);
  return response.json() as Promise<{runId?:string}>;
}
