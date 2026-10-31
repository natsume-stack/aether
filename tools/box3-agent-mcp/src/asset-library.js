import fs from 'node:fs/promises';
import path from 'node:path';

export function buildAssetTools(config) {
  return [{
    name: 'asset_library_search',
    description: 'Search the configured local map/model metadata catalogue. Returns attribution, rights and availability; published v7 model data is not an editable source project. Does not download or import anything.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 200 }, kind: { type: 'string', enum: ['map', 'model', 'skin', 'music'] },
      localOnly: { type: 'boolean' }, animated: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ query = '', kind, localOnly = false, animated, limit = 20 }) => {
      if (!config.corpusRoot) throw Object.assign(new Error('Set BOX_AGENT_CORPUS_ROOT to the local corpus directory containing catalog.json'), { code: 'ASSET_LIBRARY_NOT_CONFIGURED' });
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
      const file = path.join(config.corpusRoot, 'catalog.json');
      if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('Catalogue exceeds 16 MiB');
      const catalog = JSON.parse(await fs.readFile(file, 'utf8'));
      if (catalog.format !== 'box3-asset-catalog/1' || !Array.isArray(catalog.entries)) throw new Error('Unsupported asset catalogue');
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const results = catalog.entries.filter(row => (!kind || row.kind === kind)
        && (!localOnly || row.available !== 'metadata-only')
        && (animated === undefined || row.animated === animated)
        && terms.every(term => `${row.name} ${row.author} ${row.id}`.toLocaleLowerCase().includes(term)));
      return { summary: `${results.length} matching assets`, data: { total: results.length, entries: results.slice(0, limit), truncated: results.length > limit } };
    },
  }];
}
