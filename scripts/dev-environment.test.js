'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { prepareDevelopmentData } = require('./dev-data');
const test = require('node:test');

const { createDevelopmentEnvironment } = require('./dev-environment');

const repoRoot = path.resolve(__dirname, '..');

test('source development uses the bundled local config without Nacos', () => {
    const env = createDevelopmentEnvironment({
        repoRoot,
        inheritedEnv: {},
        useInfrastructure: false,
    });

    assert.equal(
        env.BOX_LOCAL_CONFIG_PATH,
        path.join(repoRoot, 'apps/local-engine/config/local.config.json'),
    );
    assert.equal(env.NACOS_SERVER_ADDRESS, undefined);
});

test('source development isolates writable state under its dedicated data directory', () => {
    const env = createDevelopmentEnvironment({
        repoRoot,
        inheritedEnv: {},
        useInfrastructure: false,
    });
    const expected = path.join(repoRoot, '.local-data');
    assert.equal(env.BOX_DEV_DATA_DIRECTORY, expected);
    for (const name of [
        'BOX_LOCAL_PROJECTS_PATH',
        'BOX_PLAY_LIBRARY_PATH',
        'BOX_SERVER_DATA_PATH',
        'BOX_RUNTIME_CACHE_PATH',
        'BOX_PROJECT_BACKUP_PATH',
        'BOX_LOCAL_DIST_PATH',
        'BOX_MAP_RUNTIME_PROFILES_PATH',
        'VOXA_DATA_PATH',
        'BOX_LOCAL_VOXA_DATA_PATH',
    ]) {
        assert.ok(
            env[name]?.startsWith(expected + path.sep),
            `${name} must use external development storage`,
        );
    }
    assert.equal(env.BOX_LOCAL_VOXA_DATA_PATH, env.VOXA_DATA_PATH);
    assert.equal(env.BOX_LOCAL_TEMPLATE_DATA_PATH, path.join(repoRoot, 'apps/local-engine/data'));
});

test('all services share the configured external development root and VOXA override', () => {
    const directory = path.join(os.tmpdir(), 'box-custom-development');
    const voxa = path.join(os.tmpdir(), 'box-custom-models');
    const env = createDevelopmentEnvironment({
        repoRoot,
        inheritedEnv: {
            BOX_DEV_DATA_DIRECTORY: directory,
            VOXA_DATA_PATH: voxa,
            BOX_DATA_DIRECTORY: '.',
        },
        useInfrastructure: true,
    });
    assert.equal(env.BOX_DEV_DATA_DIRECTORY, directory);
    assert.equal(env.BOX_LOCAL_PROJECTS_PATH, path.join(directory, 'apps/local-engine/projects'));
    assert.equal(env.BOX_PLAY_LIBRARY_PATH, path.join(directory, 'apps/local-engine/play-worlds'));
    assert.equal(env.VOXA_DATA_PATH, voxa);
    assert.equal(env.BOX_LOCAL_VOXA_DATA_PATH, voxa);
});

test('legacy maps and models migrate once while source assets remain available for builds', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-dev-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, content) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    write('apps/local-engine/projects/.gitkeep', '');
    write('apps/local-engine/projects/example/project.json', '{"name":"fixture map"}');
    write('apps/voxa/data/models.json', '{"models":[1]}');
    write('apps/local-engine/data/blobs/source-asset', 'built-in source');
    const env = createDevelopmentEnvironment({
        repoRoot: root,
        inheritedEnv: {},
        useInfrastructure: false,
    });
    prepareDevelopmentData(root, env, () => {});
    assert.equal(
        fs.readFileSync(path.join(env.BOX_LOCAL_PROJECTS_PATH, 'example/project.json'), 'utf8'),
        '{"name":"fixture map"}',
    );
    assert.equal(
        fs.readFileSync(path.join(env.VOXA_DATA_PATH, 'models.json'), 'utf8'),
        '{"models":[1]}',
    );
    assert.equal(fs.existsSync(path.join(root, 'apps/local-engine/projects/example')), false);
    assert.equal(fs.existsSync(path.join(root, 'apps/local-engine/projects/.gitkeep')), true);
    assert.equal(
        fs.readFileSync(path.join(root, 'apps/local-engine/data/blobs/source-asset'), 'utf8'),
        'built-in source',
    );
    fs.rmSync(path.join(env.BOX_LOCAL_PROJECTS_PATH, 'example'), { recursive: true });
    write('apps/local-engine/projects/old/project.json', '{}');
    assert.deepEqual(
        prepareDevelopmentData(root, env, () => {}),
        [],
    );
    assert.equal(fs.existsSync(path.join(env.BOX_LOCAL_PROJECTS_PATH, 'old')), false);
});

test('existing independent development data is never overwritten or merged implicitly', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-dev-existing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = createDevelopmentEnvironment({
        repoRoot: root,
        inheritedEnv: {},
        useInfrastructure: false,
    });
    const legacy = path.join(root, 'apps/local-engine/projects/map/project.json');
    const current = path.join(env.BOX_LOCAL_PROJECTS_PATH, 'map/project.json');
    for (const file of [legacy, current]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(legacy, 'legacy');
    fs.writeFileSync(current, 'current');
    prepareDevelopmentData(root, env, () => {});
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy');
    assert.equal(fs.readFileSync(current, 'utf8'), 'current');
});

test('real project creation, export and import write only into development storage', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-dev-project-flow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const template = path.join(root, 'template');
    fs.mkdirSync(path.join(template, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(template, 'blobs/QmTemplate'), 'fixture resource');
    const env = createDevelopmentEnvironment({
        repoRoot: root,
        inheritedEnv: { BOX_LOCAL_TEMPLATE_DATA_PATH: template },
        useInfrastructure: false,
    });
    const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const manager = require(${JSON.stringify(path.join(repoRoot, 'apps/local-engine/src/project-manager.js'))});
        const project = manager.createProject({ id: 'dev-storage-fixture', name: 'Storage fixture' });
        assert.equal(manager.projectsRoot, process.env.BOX_LOCAL_PROJECTS_PATH);
        const exported = manager.exportProject(project.id);
        assert.ok(exported.archivePath.startsWith(process.env.BOX_LOCAL_DIST_PATH + path.sep));
        assert.ok(fs.existsSync(exported.archivePath));
        manager.deleteProject(project.id);
        const imported = manager.importProject(exported.archivePath);
        assert.equal(manager.listProjects().length, 1);
        assert.equal(manager.getProject(imported.id).name, 'Storage fixture');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});
