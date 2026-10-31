import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { createMapLabels } from './map-labels';

test('updates cache display names without discarding legacy local preferences', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-map-labels-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filename = path.join(root, 'map-labels.json');
    fs.writeFileSync(
        filename,
        JSON.stringify({
            version: 2,
            favoriteMapIds: ['legacy-map'],
            servers: { server: { maps: {}, recent: { permanentMapId: 'legacy-map' } } },
        }),
    );
    const labels = createMapLabels(filename);
    labels.remember('server', [{ permanentMapId: 'map-town', name: '星梦小镇' }]);
    const reopened = createMapLabels(filename);
    assert.equal(reopened.name('server', 'map-town'), '星梦小镇');
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(stored.favoriteMapIds, ['legacy-map']);
    assert.equal(stored.servers.server.recent.permanentMapId, 'legacy-map');
});
