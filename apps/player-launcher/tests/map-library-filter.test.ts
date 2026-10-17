import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterMapLibrary } from '../src/features/maps/search';

const worlds = [
    { id: 'town', permanentMapId: 'permanent-town', name: '星梦小镇', author: '作者甲' },
    { id: 'arena', permanentMapId: 'permanent-arena', name: '竞技场', author: '作者乙' },
];

test('map library tabs use the Play public access IDs for favorite collections', () => {
    assert.deepEqual(filterMapLibrary(worlds, '', 'all', [], []), worlds);
    assert.deepEqual(filterMapLibrary(worlds, '', 'recent', [worlds[1]], []), [worlds[1]]);
    assert.deepEqual(filterMapLibrary(worlds, '', 'favorites', [], ['town']), [worlds[0]]);
});

test('search also narrows the selected map-library category', () => {
    assert.deepEqual(filterMapLibrary(worlds, '小镇', 'favorites', [], ['town']), [worlds[0]]);
    assert.deepEqual(filterMapLibrary(worlds, '竞技', 'favorites', [], ['town']), []);
});
