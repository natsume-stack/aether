'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-publish-voxa-'));
const projectsRoot = path.join(temporaryRoot, 'projects');
const voxaRoot = path.join(temporaryRoot, 'voxa');
const templateRoot = path.join(temporaryRoot, 'template');
const referencedHash = `Qm${'1'.repeat(44)}`;
const permissionHash = `Qm${'2'.repeat(44)}`;
const versionControlHash = `Qm${'3'.repeat(44)}`;
const projectHash = `Qm${'4'.repeat(44)}`;
const scriptAssetsHash = `Qm${'5'.repeat(44)}`;
const assetIndexHash = `Qm${'6'.repeat(44)}`;
const missingPreviewName = `Qm${'7'.repeat(44)}.png`;
const scriptHash = `Qm${'8'.repeat(44)}`;
const binaryFalsePositive = '_aIQSRIQSRoppqoppqFphqFphqrtsurtsuQHSIQHSIK';
const binaryChildHash = 'A'.repeat(43);
const voxaPayload = Buffer.concat([
    Buffer.from([1]),
    Buffer.from([43]),
    Buffer.from(binaryFalsePositive),
    Buffer.from([1]),
    Buffer.from([43]),
    Buffer.from(binaryChildHash),
    Buffer.from([1]),
]);

process.env.BOX_LOCAL_PROJECTS_PATH = projectsRoot;
process.env.BOX_LOCAL_VOXA_DATA_PATH = voxaRoot;
process.env.BOX_LOCAL_TEMPLATE_DATA_PATH = templateRoot;
(async () => {
    try {
        const projectRoot = path.join(projectsRoot, 'voxa-publish');
        const sourceRoot = path.join(projectsRoot, 'voxa-publish', 'source');
        const sourceBlobRoot = path.join(sourceRoot, 'blobs');
        const statePath = path.join(sourceRoot, 'project-state.json');
        fs.mkdirSync(sourceBlobRoot, { recursive: true });
        fs.mkdirSync(path.join(templateRoot, 'blobs'), { recursive: true });
        fs.writeFileSync(
            path.join(templateRoot, 'runtime-blobs.json'),
            JSON.stringify({ formatVersion: 1, hashes: [] }),
        );
        const manager = require('../src/project-manager');
        fs.writeFileSync(
            path.join(projectRoot, 'project.json'),
            JSON.stringify({
                formatVersion: 1,
                id: 'voxa-publish',
                name: 'VOXA publish regression',
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
                releases: [],
                mapGroupId: 'voxa-publish',
                mapRole: 'main',
                mainProjectId: 'voxa-publish',
            }),
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, permissionHash),
            JSON.stringify({
                accessLevel: 1,
                versionControl: versionControlHash,
            }),
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, versionControlHash),
            JSON.stringify({
                branches: { master: { headHash: projectHash } },
            }),
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, projectHash),
            JSON.stringify({
                scriptAssets: scriptAssetsHash,
                assets: assetIndexHash,
            }),
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, scriptAssetsHash),
            JSON.stringify({
                'index.js': { type: 1, hash: scriptHash },
            }),
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, scriptHash),
            '// -------------------------------------------\nmodule.exports = {}\n',
        );
        fs.writeFileSync(
            path.join(sourceBlobRoot, assetIndexHash),
            JSON.stringify({
                'lut/test.lut': {
                    type: 3,
                    hash: '',
                    previewImage: missingPreviewName,
                },
            }),
        );
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                formatVersion: 1,
                permissionHash,
                extraProjectHash: referencedHash,
            }),
        );

        fs.mkdirSync(path.join(voxaRoot, 'blobs'), { recursive: true });
        fs.writeFileSync(path.join(voxaRoot, 'blobs', referencedHash), voxaPayload);
        fs.writeFileSync(path.join(voxaRoot, 'blobs', binaryChildHash), 'nested VOXA dependency');

        manager.publishProject('voxa-publish', 'v1');
        const bundle = await manager.exportPlayBundle('voxa-publish@v1');

        assert.deepEqual(
            fs.readFileSync(path.join(sourceRoot, 'blobs', referencedHash)),
            voxaPayload,
            'publishing should materialize referenced VOXA blobs into the editable project',
        );
        assert.deepEqual(
            fs.readFileSync(
                path.join(
                    projectsRoot,
                    'voxa-publish',
                    'releases',
                    'v1',
                    'data',
                    'blobs',
                    referencedHash,
                ),
            ),
            voxaPayload,
            'the immutable play release should contain the referenced VOXA blob',
        );
        assert.equal(
            fs.readFileSync(path.join(sourceRoot, 'blobs', binaryChildHash), 'utf8'),
            'nested VOXA dependency',
            'real length-delimited VOXA dependencies should still be discovered',
        );
        assert.equal(
            fs.existsSync(path.join(sourceRoot, 'blobs', binaryFalsePositive)),
            false,
            'binary payload bytes must not be invented as resource hashes',
        );
        assert.equal(
            fs.statSync(bundle.archivePath).isFile(),
            true,
            'the published release should remain exportable as a play bundle',
        );
        fs.rmSync(bundle.archivePath, { force: true });
        fs.rmSync(bundle.temporaryRoot, { recursive: true, force: true });

        console.log('VOXA publish regression checks passed.');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
