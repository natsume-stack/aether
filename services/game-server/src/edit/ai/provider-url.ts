/**
 * Provider endpoint derivation ported from cc-switch (farion1231/cc-switch):
 * - a pasted full endpoint is reduced to its API root
 * - an API root without a version segment gets `/v1`
 * - model listing tries the cc-switch candidate order, including compat suffixes
 */
export type ProviderProtocol = 'chat-completions' | 'responses' | 'anthropic-messages';

const VERSION_SEGMENT = /^v\d+$/i;
const FULL_ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/models'];
const COMPAT_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
];

export function providerEndsWithVersion(url: string) {
  const last = url.replace(/\/+$/, '').split('/').pop() || '';
  return VERSION_SEGMENT.test(last);
}

/** Accepts an API root (`https://host`, `https://host/v1`) or a pasted full endpoint. */
export function normalizeProviderBaseUrl(raw: string) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Base URL 不能为空');
  const lower = base.toLowerCase();
  for (const suffix of FULL_ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return base;
}

/** SDK base URL always carries a version segment so every protocol appends its own path. */
export function providerApiBaseUrl(raw: string) {
  const base = normalizeProviderBaseUrl(raw);
  return providerEndsWithVersion(base) ? base : `${base}/v1`;
}

export function providerProtocolPath(protocol: ProviderProtocol) {
  if (protocol === 'chat-completions') return '/chat/completions';
  if (protocol === 'responses') return '/responses';
  return '/messages';
}

export function providerRequestUrl(raw: string, protocol: ProviderProtocol) {
  return `${providerApiBaseUrl(raw)}${providerProtocolPath(protocol)}`;
}

function stripCompatSuffix(base: string) {
  const lower = base.toLowerCase();
  for (const suffix of COMPAT_SUFFIXES) {
    if (lower.endsWith(suffix)) return base.slice(0, -suffix.length).replace(/\/+$/, '');
  }
  return '';
}

/** Model-list endpoint candidates, tried in order; 404/405 falls through to the next. */
export function providerModelsUrls(raw: string) {
  const base = normalizeProviderBaseUrl(raw);
  const candidates: string[] = [];
  if (providerEndsWithVersion(base)) {
    candidates.push(`${base}/models`);
    if (!base.toLowerCase().endsWith('/v1')) candidates.push(`${base}/v1/models`);
  } else {
    candidates.push(`${base}/v1/models`);
  }
  const root = stripCompatSuffix(base);
  if (root && /^https?:\/\//i.test(root)) {
    candidates.push(`${root}/v1/models`, `${root}/models`);
    if (base.toLowerCase().endsWith('/apps/anthropic')) {
      candidates.push(`${root}/compatible-mode/v1/models`);
    }
  }
  const unique: string[] = [];
  for (const url of candidates) {
    if (!unique.includes(url)) unique.push(url);
  }
  return unique.slice(0, 4);
}
