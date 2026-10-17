'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProjectCompatibility } = require('../src/project-compatibility');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-project-compatibility-'));
const sourceRoot = path.join(root, 'source');
const blobsRoot = path.join(sourceRoot, 'blobs');
const runtimeHash = `Qm${'1'.repeat(44)}`;
const previewHash = `Qm${'2'.repeat(44)}`;
const bannerHash = `Qm${'3'.repeat(44)}`;

try {
    fs.mkdirSync(blobsRoot, { recursive: true });
    fs.writeFileSync(
        path.join(sourceRoot, 'metadata.json'),
        JSON.stringify({
            entitiesTree: runtimeHash,
            previewImage: `${previewHash}.jpg`,
            bannerImages: [`${bannerHash}..png`],
            assets: {
                'audio/music.mp3': {
                    hash: runtimeHash,
                    previewImage: previewHash,
                    type: 6,
                },
            },
        }),
    );

    const missingRuntime = scanProjectCompatibility(sourceRoot);
    assert.deepStrictEqual(
        missingRuntime.errors.map((issue) => issue.hash),
        [runtimeHash],
        'only a missing runtime dependency should be reported',
    );

    fs.writeFileSync(path.join(blobsRoot, runtimeHash), 'runtime resource');
    const completeRuntime = scanProjectCompatibility(sourceRoot);
    assert.strictEqual(
        completeRuntime.summary.missingBlobCount,
        0,
        'display-only cloud images must not make an offline project incompatible',
    );
    assert.strictEqual(completeRuntime.level, 'compatible');
    console.log('project compatibility regression passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
