'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-project-identity-'));
process.env.BOX_LOCAL_PROJECTS_PATH = temporaryRoot;

const manager = require('../src/project-manager');
const mapIdentityPattern = /^[0-9a-f]{20}$/;

try {
    const main = manager.createProject({
        id: 'readable-directory-key',
        name: '主地图',
        mapSize: 'small',
    });
    assert.match(main.permanentMapId, mapIdentityPattern);
    assert.deepEqual(main.mapSize, [32, 32, 32]);
    assert.equal(main.templateId, 'blank');

    const medium = manager.createProject({
        id: 'medium-map',
        name: '中地图',
        mapSize: 'medium',
    });
    assert.deepEqual(medium.mapSize, [64, 128, 64]);
    assert.equal(medium.templateId, 'blank');

    const large = manager.createProject({
        id: 'large-map',
        name: '大地图',
        mapSize: 'large',
    });
    assert.deepEqual(large.mapSize, [128, 128, 128]);

    const custom = manager.createProject({
        id: 'custom-map',
        name: '自定义地图',
        mapSize: [48, 96, 48],
    });
    assert.deepEqual(custom.mapSize, [48, 96, 48]);
    const maximumCustom = manager.createProject({
        id: 'maximum-custom-map',
        name: '最大自定义地图',
        mapSize: [1024, 128, 1024],
    });
    assert.deepEqual(maximumCustom.mapSize, [1024, 128, 1024]);
    assert.throws(
        () =>
            manager.createProject({
                id: 'invalid-custom-map',
                name: '无效自定义地图',
                mapSize: [1040, 64, 64],
            }),
        /自定义地图尺寸/,
    );
    assert.throws(
        () =>
            manager.createProject({
                id: 'oversized-custom-map',
                name: '超限自定义地图',
                mapSize: [1024, 144, 1024],
            }),
        /自定义地图尺寸/,
    );

    const before = manager.projectStorageIdentity(main.id);
    assert.equal(manager.resolveProjectReference(main.id), main.id);
    assert.equal(manager.resolveProjectReference(main.permanentMapId), main.id);
    assert.deepEqual(
        manager.projectStorageIdentity(main.permanentMapId),
        before,
        'CLI permanent map IDs must resolve to the same storage namespace as the project directory ID',
    );
    assert.throws(
        () => manager.resolveProjectReference('0123456789abcdef0123'),
        /Project not found/,
    );
    const launchTarget = manager.getLaunchTarget({ project: main.id });
    assert.deepEqual(launchTarget.initialMapSize, [32, 32, 32]);
    assert.equal(launchTarget.initialTerrainTheme, 'plane');
    manager.updateProject(main.id, { publicId: 'editable-player-link' });
    const after = manager.projectStorageIdentity(main.id);
    assert.deepEqual(after, before, 'changing the public route must not change storage identity');

    const submap = manager.createSubmap(main.id, {
        id: 'readable-submap-key',
        name: '副地图',
    });
    const submapIdentity = manager.projectStorageIdentity(submap.id);
    assert.match(submapIdentity.permanentMapId, mapIdentityPattern);
    assert.notEqual(submapIdentity.permanentMapId, before.permanentMapId);
    assert.equal(submapIdentity.permanentMapGroupId, before.permanentMapId);

    const legacyPath = path.join(temporaryRoot, submap.id, 'project.json');
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    delete legacy.permanentMapId;
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const migrated = manager.getProject(submap.id);
    assert.match(migrated.permanentMapId, mapIdentityPattern);
    assert.equal(manager.getProject(submap.id).permanentMapId, migrated.permanentMapId);

    console.log('project storage identity regression passed');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
