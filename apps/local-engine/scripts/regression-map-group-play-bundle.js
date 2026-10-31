'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-map-group-play-'));
const projectsRoot = path.join(temporaryRoot, 'projects');
const templateDataRoot = path.join(temporaryRoot, 'template-data');
process.env.BOX_LOCAL_PROJECTS_PATH = projectsRoot;
process.env.BOX_LOCAL_TEMPLATE_DATA_PATH = templateDataRoot;

fs.mkdirSync(templateDataRoot, { recursive: true });

const manager = require('../src/project-manager');

function hash(character) {
    return `Qm${character.repeat(44)}`;
}

const legacyModelHash = '27e4efc3-4a6f-44f3-af42-ed27f0aae251';
const legacyPreviewHash = '7f03d38b-bb34-4f6b-8ca2-3c6cfd2a9bc2';

function saveProject(id, characters) {
    const sourceRoot = path.join(projectsRoot, id, 'source');
    const blobRoot = path.join(sourceRoot, 'blobs');
    const permissionHash = hash(characters[0]);
    const versionControlHash = hash(characters[1]);
    const projectHash = hash(characters[2]);
    const scriptAssetsHash = hash(characters[3]);
    const scriptHash = hash(characters[4]);
    const assetIndexHash = hash('C');

    fs.mkdirSync(blobRoot, { recursive: true });
    fs.writeFileSync(
        path.join(blobRoot, permissionHash),
        JSON.stringify({
            accessLevel: 1,
            versionControl: versionControlHash,
        }),
    );
    fs.writeFileSync(
        path.join(blobRoot, versionControlHash),
        JSON.stringify({
            branches: { master: { headHash: projectHash } },
        }),
    );
    fs.writeFileSync(
        path.join(blobRoot, projectHash),
        JSON.stringify({
            scriptAssets: scriptAssetsHash,
            ...(id === 'release-main' ? { assets: assetIndexHash } : {}),
        }),
    );
    fs.writeFileSync(
        path.join(blobRoot, scriptAssetsHash),
        JSON.stringify({
            'index.js': { type: 1, hash: scriptHash },
        }),
    );
    fs.writeFileSync(path.join(blobRoot, scriptHash), 'module.exports = {}\n');
    if (id === 'release-main') {
        // Imported projects can keep old UUID Blob IDs in their resource index.
        // Both the model and its existing preview are runtime package resources.
        fs.writeFileSync(
            path.join(blobRoot, assetIndexHash),
            JSON.stringify({
                'mesh/legacy-model.vb': {
                    hash: legacyModelHash,
                    previewImage: legacyPreviewHash,
                },
            }),
        );
        fs.writeFileSync(path.join(blobRoot, legacyModelHash), 'legacy model payload');
        fs.writeFileSync(path.join(blobRoot, legacyPreviewHash), 'legacy preview payload');
    }
    fs.writeFileSync(
        path.join(sourceRoot, 'project-state.json'),
        JSON.stringify({
            formatVersion: 1,
            permissionHash,
        }),
    );
}

(async () => {
    try {
        manager.createProject({ id: 'release-main', name: '发布主地图' });
        manager.createSubmap('release-main', {
            id: 'release-dungeon',
            name: '发布副地图',
        });
        const artworkCover = 'data:image/png;base64,YXJ0d29yaw==';
        const loadingCover = 'data:image/webp;base64,bG9hZGluZw==';
        manager.updateProject('release-main', { cover: artworkCover, loadingCover });
        saveProject('release-main', '12345');

        assert.throws(
            () => manager.publishMapGroup('release-main', 'v1'),
            /请先打开并保存地图“发布副地图”/,
            'an unsaved member must reject the complete group before publishing starts',
        );
        assert.equal(
            fs.existsSync(path.join(projectsRoot, 'release-main', 'releases', 'v1')),
            false,
            'a rejected group publish must not leave a main-map release behind',
        );

        saveProject('release-dungeon', '6789A');
        // Runtime template blobs are added after the projects are created, matching
        // an upgraded Creator image publishing an older editable project. They are
        // intentionally absent from each project's source/blobs directory.
        const runtimeTemplateHash = hash('B');
        fs.mkdirSync(path.join(templateDataRoot, 'blobs'), { recursive: true });
        fs.writeFileSync(
            path.join(templateDataRoot, 'blobs', runtimeTemplateHash),
            'runtime template resource\n',
        );
        fs.writeFileSync(
            path.join(templateDataRoot, 'runtime-blobs.json'),
            JSON.stringify({ formatVersion: 1, hashes: [runtimeTemplateHash] }),
        );
        assert.throws(
            () => manager.publishMapGroup('release-dungeon', 'v1', '整组回归'),
            /只有主地图可以导出游戏包/,
        );
        const published = manager.publishMapGroup('release-main', 'v1', '整组回归');
        assert.equal(published.type, 'map-group-release');
        assert.equal(published.mainProjectId, 'release-main');
        assert.equal(published.mapCount, 2);

        const mainManifest = JSON.parse(
            fs.readFileSync(
                path.join(projectsRoot, 'release-main', 'releases', 'v1', 'manifest.json'),
                'utf8',
            ),
        );
        const submapManifest = JSON.parse(
            fs.readFileSync(
                path.join(projectsRoot, 'release-dungeon', 'releases', 'v1', 'manifest.json'),
                'utf8',
            ),
        );
        assert.equal(mainManifest.mapRole, 'main');
        assert.equal(submapManifest.mapRole, 'submap');
        assert.equal(mainManifest.mapGroupId, 'release-main');
        assert.equal(submapManifest.mainProjectId, 'release-main');
        assert.match(mainManifest.permanentMapId, /^[0-9a-f]{20}$/);
        assert.match(submapManifest.permanentMapId, /^[0-9a-f]{20}$/);
        assert.notEqual(submapManifest.permanentMapId, mainManifest.permanentMapId);
        assert.equal(mainManifest.permanentMapGroupId, mainManifest.permanentMapId);
        assert.equal(submapManifest.permanentMapGroupId, mainManifest.permanentMapId);
        assert.equal(mainManifest.cover, artworkCover);
        assert.equal(mainManifest.loadingCover, loadingCover);

        const distributionPath = path.join(temporaryRoot, 'distribution');
        const packaged = manager.packageProject('release-main@v1', distributionPath, {
            includeImages: false,
        });
        assert.equal(packaged.directory, distributionPath);
        const compose = fs.readFileSync(path.join(distributionPath, 'compose.yml'), 'utf8');
        assert.match(
            compose,
            new RegExp(`BOX_WORLD_PERMANENT_MAP_ID: ${mainManifest.permanentMapId}`),
        );
        assert.match(
            compose,
            new RegExp(`BOX_WORLD_PERMANENT_GROUP_ID: ${mainManifest.permanentMapId}`),
        );
        assert.match(
            compose,
            /BOX_PLAYER_LOGIN_URL: \$\{BOX_PLAYER_LOGIN_URL:-\}/,
            'a missing external login page must not prevent the play package from starting',
        );
        assert.doesNotMatch(compose, /BOX_PLAYER_LOGIN_URL: \$\{BOX_PLAYER_LOGIN_URL:\?/);
        assert.doesNotMatch(compose, /BOX_GROUP_STORAGE_NAMESPACE:/);
        assert.doesNotMatch(compose, /BOX_DATA_STORAGE_NAMESPACE:/);
        assert.match(
            compose,
            /play-storage-init:[\s\S]*?chown -R 1000:1000 \/app\/storage/,
            'generated deployment must repair existing storage ownership',
        );
        assert.match(
            compose,
            /play-storage-init:\s*\n\s*condition: service_completed_successfully/,
            'play must wait until its writable storage is ready',
        );
        const envExample = fs.readFileSync(path.join(distributionPath, '.env.example'), 'utf8');
        const documentedVariables = new Set(
            [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
        );
        const composeVariables = new Set(
            [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
        );
        assert.deepEqual(
            [...composeVariables].filter((name) => !documentedVariables.has(name)),
            [],
            'every generated Compose parameter must be documented in .env.example',
        );
        for (const required of [
            '.env.example',
            'BUILD-INFO.json',
            'LICENSE.txt',
            'THIRD-PARTY-NOTICES.json',
            'SHA256SUMS',
        ]) {
            assert.equal(
                fs.existsSync(path.join(distributionPath, required)),
                true,
                `${required} must be packaged`,
            );
        }
        const checksums = fs
            .readFileSync(path.join(distributionPath, 'SHA256SUMS'), 'utf8')
            .trim()
            .split('\n');
        assert(checksums.length > 5);
        for (const line of checksums) {
            const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
            assert(match, `invalid checksum line: ${line}`);
            const actual = crypto
                .createHash('sha256')
                .update(fs.readFileSync(path.join(distributionPath, match[2])))
                .digest('hex');
            assert.equal(actual, match[1], `checksum mismatch: ${match[2]}`);
        }

        await assert.rejects(
            () => manager.exportPlayBundle('release-dungeon@v1'),
            /只有主地图可以导出游戏包/,
        );
        const bundle = await manager.exportPlayBundle('release-main@v1');
        assert.equal(bundle.mapCount, 2);
        const entries = execFileSync('tar', ['-tzf', bundle.archivePath], { encoding: 'utf8' })
            .trim()
            .split('\n');
        assert(entries.includes('bundle.json'));
        assert(entries.includes('worlds/release-main/manifest.json'));
        assert(entries.includes('worlds/release-dungeon/manifest.json'));
        assert(entries.includes(`worlds/release-main/data/blobs/${legacyModelHash}`));
        assert(entries.includes(`worlds/release-main/data/blobs/${legacyPreviewHash}`));
        const bundledMainManifest = JSON.parse(
            execFileSync(
                'tar',
                ['-xOzf', bundle.archivePath, 'worlds/release-main/manifest.json'],
                {
                    encoding: 'utf8',
                },
            ),
        );
        assert.equal(bundledMainManifest.cover, artworkCover);
        assert.equal(bundledMainManifest.loadingCover, loadingCover);
        const bundledRuntimeBlobs = JSON.parse(
            execFileSync(
                'tar',
                ['-xOzf', bundle.archivePath, 'worlds/release-main/data/runtime-blobs.json'],
                { encoding: 'utf8' },
            ),
        );
        assert(bundledRuntimeBlobs.hashes.includes(legacyModelHash));
        assert(bundledRuntimeBlobs.hashes.includes(legacyPreviewHash));
        const descriptor = JSON.parse(
            execFileSync('tar', ['-xOzf', bundle.archivePath, 'bundle.json'], { encoding: 'utf8' }),
        );
        assert.equal(descriptor.type, 'map-group-play-bundle');
        assert.equal(descriptor.mainProjectId, 'release-main');
        assert.deepEqual(
            descriptor.members.map((member) => [member.id, member.mapRole]),
            [
                ['release-main', 'main'],
                ['release-dungeon', 'submap'],
            ],
        );

        fs.rmSync(bundle.archivePath, { force: true });
        fs.rmSync(bundle.temporaryRoot, { recursive: true, force: true });
        console.log('map group play bundle regression passed');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
