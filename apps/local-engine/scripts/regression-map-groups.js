'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-map-groups-'));
process.env.BOX_LOCAL_PROJECTS_PATH = path.join(temporaryRoot, 'projects');

const manager = require('../src/project-manager');

try {
    const main = manager.createProject({ id: 'group-main', name: '主地图' });
    assert.equal(main.mapRole, 'main');
    assert.equal(main.mapGroupId, 'group-main');
    assert.equal(manager.getLaunchTarget({ project: 'group-main' }).kind, 'source');
    assert.equal(
        fs.existsSync(
            path.join(
                process.env.BOX_LOCAL_PROJECTS_PATH,
                'group-main',
                'source',
                'project-state.json',
            ),
        ),
        false,
        'opening a blank main map must leave first-launch initialization to the runtime',
    );
    const submap = manager.createSubmap('group-main', {
        id: 'group-dungeon',
        name: '地下城',
    });
    assert.equal(submap.mapRole, 'submap');
    assert.equal(submap.mainProjectId, 'group-main');
    assert.equal(submap.mapGroupId, 'group-main');
    const mainRoot = path.join(process.env.BOX_LOCAL_PROJECTS_PATH, 'group-main');
    const submapRoot = path.join(process.env.BOX_LOCAL_PROJECTS_PATH, 'group-dungeon');
    assert.equal(
        fs.existsSync(path.join(submapRoot, 'source', 'project-state.json')),
        false,
        'a blank submap must not be marked initialized without a permission root',
    );
    const mainStatePath = path.join(mainRoot, 'source', 'project-state.json');
    fs.writeFileSync(
        mainStatePath,
        JSON.stringify({
            permissionHash: 'main-permission',
            extraProjectHash: 'shared-extra',
            groupProjectMetaData: { version: '0.0.2', hashes: { uiTree: 'shared-ui' } },
            projectModelPathsByMap: {
                'group-main': ['mesh/main-model.vb'],
                'group-dungeon': ['mesh/shared-model.vb', 'mesh/main-model.vb'],
            },
        }),
    );
    fs.writeFileSync(path.join(mainRoot, 'source', 'blobs', 'shared-extra'), 'extra');
    // Group state is initialized lazily from the main map. Recreate the initial
    // state to model a new main map receiving its first submap.
    fs.rmSync(path.join(mainRoot, 'group-state.json'), { force: true });
    manager.materializeMapGroupState('group-dungeon');
    assert.equal(
        fs.existsSync(path.join(submapRoot, 'source', 'project-state.json')),
        false,
        'shared group state must not mark a new submap initialized before it has its own permission root',
    );
    assert.equal(
        manager.getLaunchTarget({ project: 'group-dungeon' }).kind,
        'source',
        'a new submap must remain launchable while shared group resources already exist',
    );
    assert.equal(
        fs.readFileSync(path.join(submapRoot, 'source', 'blobs', 'shared-extra'), 'utf8'),
        'extra',
    );
    assert.deepEqual(
        manager.listMapGroup('group-dungeon').map(({ id }) => id),
        ['group-main', 'group-dungeon'],
    );
    assert.throws(
        () => manager.exportProject('group-dungeon', { scope: 'group' }),
        /只有主地图可以导出地图组工程/,
    );
    const exportedMap = manager.exportProject('group-dungeon', { scope: 'map' });
    assert.equal(exportedMap.mapCount, 1);
    assert.equal(exportedMap.scope, 'map');
    const importedMap = manager.importProject(exportedMap.archivePath);
    const importedMapMembers = manager.listMapGroup(importedMap.id);
    assert.equal(importedMapMembers.length, 1);
    assert.equal(importedMapMembers[0].mapRole, 'main');
    const importedMapGroupState = JSON.parse(
        fs.readFileSync(
            path.join(process.env.BOX_LOCAL_PROJECTS_PATH, importedMap.id, 'group-state.json'),
            'utf8',
        ),
    );
    assert.deepEqual(importedMapGroupState.projectModelPathsByMap, {
        [importedMap.id]: ['mesh/shared-model.vb', 'mesh/main-model.vb'],
    });

    const exported = manager.exportProject('group-main', { scope: 'group' });
    assert.equal(exported.mapCount, 2);
    assert.equal(exported.scope, 'group');
    const imported = manager.importProject(exported.archivePath);
    const importedMembers = manager.listMapGroup(imported.id);
    assert.equal(importedMembers.length, 2);
    assert.equal(importedMembers[0].mapRole, 'main');
    assert.equal(importedMembers[1].mapRole, 'submap');
    assert.equal(importedMembers[1].mainProjectId, imported.id);
    const importedGroupState = JSON.parse(
        fs.readFileSync(
            path.join(process.env.BOX_LOCAL_PROJECTS_PATH, imported.id, 'group-state.json'),
            'utf8',
        ),
    );
    assert.equal(importedGroupState.extraProjectHash, 'shared-extra');
    assert.deepEqual(importedGroupState.projectModelPathsByMap, {
        [importedMembers[0].id]: ['mesh/main-model.vb'],
        [importedMembers[1].id]: ['mesh/shared-model.vb', 'mesh/main-model.vb'],
    });
    assert.equal(
        fs.existsSync(
            path.join(
                process.env.BOX_LOCAL_PROJECTS_PATH,
                importedMembers[1].id,
                'source',
                'project-state.json',
            ),
        ),
        false,
        'an imported uninitialized submap must keep shared state at the group root',
    );
    const target = manager.createProject({ id: 'target-main', name: '目标主地图' });
    const attached = manager.importProject(exportedMap.archivePath, {
        mode: 'submap',
        targetMainProjectId: target.id,
    });
    assert.equal(
        attached.name,
        '地下城',
        'submap import must use the member that initiated the export',
    );
    assert.equal(attached.mapRole, 'submap');
    assert.equal(attached.mainProjectId, target.id);
    assert.equal(attached.mapGroupId, target.mapGroupId);
    assert.equal(attached.importedMapCount, 1);
    assert.equal(attached.importedAs, 'submap');
    assert.deepEqual(
        manager.listMapGroup(target.id).map(({ id }) => id),
        [target.id, attached.id],
    );
    assert.throws(
        () =>
            manager.importProject(exportedMap.archivePath, {
                mode: 'submap',
                targetMainProjectId: attached.id,
            }),
        /只能把工程导入到主地图下/,
    );
    assert.throws(
        () => manager.createSubmap('group-dungeon', { id: 'nested', name: '非法嵌套' }),
        /只能在主地图下创建副地图/,
    );
    manager.deleteProject('group-dungeon');
    assert.equal(fs.existsSync(submapRoot), false);
    assert.equal(fs.existsSync(mainRoot), true);
    manager.createSubmap('group-main', { id: 'group-town', name: '城镇' });
    manager.deleteProject('group-main');
    assert.equal(fs.existsSync(mainRoot), false);
    assert.equal(
        fs.existsSync(path.join(process.env.BOX_LOCAL_PROJECTS_PATH, 'group-town')),
        false,
    );
    console.log('map group lifecycle regression passed');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
