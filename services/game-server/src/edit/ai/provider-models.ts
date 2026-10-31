export type ProviderModelRow = { id: string; name?: string };

/**
 * Model responses differ between gateways (cc-switch handles the same shapes):
 * OpenAI `data[].id`, Anthropic `data[].id`, Codex catalogs `models[].slug`,
 * and Google-style `models/...` names.
 */
export function normalizeModelRows(payload: any): ProviderModelRow[] {
  const rows = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  const seen = new Set<string>();
  const models: ProviderModelRow[] = [];
  for (const row of rows) {
    const name = typeof row?.display_name === 'string' ? row.display_name : undefined;
    let id = typeof row === 'string' ? row : row?.id ?? row?.slug ?? row?.model;
    if (typeof id !== 'string' && typeof row?.name === 'string') {
      id = row.name.startsWith('models/') ? row.name.slice('models/'.length) : row.name;
    }
    if (typeof id !== 'string' || !id.trim() || seen.has(id.trim())) continue;
    const value = id.trim();
    seen.add(value);
    const label = name || (typeof row?.name === 'string' && row.name !== value && !row.name.startsWith('models/') ? row.name : undefined);
    models.push(label ? { id: value, name: label } : { id: value });
  }
  return models.slice(0, 200);
}
