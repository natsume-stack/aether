import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAssetTools } from '../src/asset-library.js';

test('asset search preserves provenance and separates downloadable samples from metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'box3-assets-'));
  try {
    const rows = [
      { id: 'local', name: '五菱', author: 'creator', kind: 'model', available: 'runtime-model-sample', editableProject: false, rights: { status: 'unknown' } },
      { id: 'remote', name: '五菱', author: 'creator', kind: 'model', available: 'metadata-only' },
    ];
    await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify({ format: 'box3-asset-catalog/1', entries: rows }));
    const tool = buildAssetTools({ corpusRoot: root })[0];
    const result = await tool.handler({ query: '五菱 creator', localOnly: true });
    assert.deepEqual(result.data.entries, [rows[0]]);
    await assert.rejects(tool.handler({ limit: 500 }));
    await assert.rejects(buildAssetTools({})[0].handler({}), { code: 'ASSET_LIBRARY_NOT_CONFIGURED' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
