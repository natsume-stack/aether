'use strict';

const assert = require('node:assert/strict');

const {
    selectCreatorModelAssets,
    selectCreatorAssetIndex,
    selectCreatorUiTree,
} = require('../src/project-manager');

const modelAssets = selectCreatorModelAssets(
    {
        'lut/Filmic.lut': { hash: 'lut-hash', type: 3 },
        'mesh/legacy.vb': { hash: 'legacy-hash', type: 1 },
    },
    {
        projectModelPathsByMap: {
            'map-demo': ['mesh/New-model.vb', 'mesh/吉吉喵哭.vb'],
            'another-map': ['mesh/椰子树.vb'],
        },
        modelProjects: {
            'New-model': 'new-model-hash',
            '吉吉喵哭': 'cat-model-hash',
            '椰子树': 'palm-model-hash',
        },
        modelPreviews: {
            'New-model': 'new-model-preview',
            '吉吉喵哭': 'cat-model-preview',
            '椰子树': 'palm-model-preview',
        },
    },
    'map-demo',
);

assert.deepEqual(Object.keys(modelAssets).sort(), [
    'mesh/New-model.vb',
    'mesh/legacy.vb',
    'mesh/吉吉喵哭.vb',
    'mesh/椰子树.vb',
]);
assert.deepEqual(modelAssets['mesh/New-model.vb'], {
    hash: 'new-model-hash',
    previewImage: 'new-model-preview',
});
assert.deepEqual(modelAssets['mesh/吉吉喵哭.vb'], {
    hash: 'cat-model-hash',
    previewImage: 'cat-model-preview',
});
assert.deepEqual(modelAssets['mesh/椰子树.vb'], {
    hash: 'palm-model-hash',
    previewImage: 'palm-model-preview',
});
assert.equal(modelAssets['lut/Filmic.lut'], undefined);

const uiTree = selectCreatorUiTree(
    { ROOT_ID: { childrenIds: ['OLD_SCREEN'] } },
    { groupProjectMetaData: { hashes: { uiTree: 'latest-ui-tree' } } },
    (hash) => {
        assert.equal(hash, 'latest-ui-tree');
        return {
            'ROOT_ID': { childrenIds: ['DEFAULT_SCREEN_ID'] },
            'DEFAULT_SCREEN_ID': { childrenIds: ['box-1'] },
            'box-1': { childrenIds: ['input-1'] },
            'input-1': { childrenIds: [] },
        };
    },
);
assert.deepEqual(uiTree.ROOT_ID.childrenIds, ['DEFAULT_SCREEN_ID']);
assert.deepEqual(uiTree['box-1'].childrenIds, ['input-1']);

const pictureAssets = selectCreatorAssetIndex(
    { 'old-image.png': { hash: 'old-image' } },
    { groupProjectMetaData: { hashes: { pictureAssets: 'latest-pictures' } } },
    'pictureAssets',
    (hash) => {
        assert.equal(hash, 'latest-pictures');
        return { 'new-image.png': { hash: 'new-image' } };
    },
);
assert.deepEqual(pictureAssets, { 'new-image.png': { hash: 'new-image' } });

const audioAssets = selectCreatorAssetIndex(
    { 'old-audio.mp3': { hash: 'old-audio' } },
    { groupProjectMetaData: { hashes: { audioAssets: 'latest-audio' } } },
    'audioAssets',
    (hash) => {
        assert.equal(hash, 'latest-audio');
        return { 'new-audio.mp3': { hash: 'new-audio' } };
    },
);
assert.deepEqual(audioAssets, { 'new-audio.mp3': { hash: 'new-audio' } });

console.log('creator resource manifest regression passed');
