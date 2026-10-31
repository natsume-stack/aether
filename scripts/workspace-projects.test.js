'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { workspaceProjects, developmentBuildPlan } = require('./workspace-projects');
const { projectCommandPlan } = require('./rush-project-command');
const root = path.resolve(__dirname, '..');

function fixture(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-workspace-'));
    const write = (file, value) => {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
    };
    try {
        for (const folder of ['apps', 'internals', 'packages', 'services', 'tools']) {
            fs.mkdirSync(path.join(directory, folder));
        }
        const projects = [
            { packageName: '@box/app', projectFolder: 'apps/app' },
            { packageName: '@box/library', projectFolder: 'packages/library' },
        ];
        write('rush.json', { projects });
        write('apps/app/package.json', {
            name: '@box/app',
            dependencies: { '@box/library': 'workspace:*' },
            scripts: { build: 'build app' },
        });
        write('packages/library/package.json', {
            name: '@box/library',
            scripts: { build: 'build library' },
        });
        action(directory, write, projects);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('Rush inventory includes every main project and prepares only compiled dependencies for dev', () => {
    const projects = workspaceProjects(root);
    assert.equal(projects.length, require('../rush.json').projects.length);
    const plan = developmentBuildPlan(root);
    assert.ok(plan.some((project) => project.name === '@box/apis'));
    assert.ok(
        plan.every(
            (project) =>
                !project.folder.startsWith('apps/') && !project.folder.startsWith('services/'),
        ),
    );
});

test('unregistered main projects and missing workspace dependencies fail before starting processes', () => {
    fixture((root, write) => {
        write('apps/missing/package.json', { name: '@box/missing' });
        assert.throws(() => workspaceProjects(root), /not registered/);
    });
    fixture((root, write) => {
        write('apps/app/package.json', {
            name: '@box/app',
            dependencies: { '@box/missing': 'workspace:*' },
        });
        assert.throws(() => workspaceProjects(root), /missing workspace/);
    });
});

test('preferred toolchain versions reject drift but allow peer ranges and nested examples', () => {
    fixture((root, write) => {
        write('common/config/rush/common-versions.json', {
            preferredVersions: { react: '19.2.1', typescript: '5.6.3' },
        });
        write('packages/library/package.json', {
            name: '@box/library',
            peerDependencies: { react: '>=18.2.0 <20' },
            devDependencies: { react: '19.2.1', typescript: '5.6.3' },
        });
        write('packages/library/example/package.json', {
            dependencies: { react: '16.8.3' },
        });
        assert.equal(workspaceProjects(root).length, 2);
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            write('apps/app/package.json', {
                name: '@box/app',
                [section]: { typescript: '^5.6.3' },
            });
            assert.throws(() => workspaceProjects(root), /must pin typescript to 5\.6\.3/);
        }
    });
});

test('vendored examples stay outside the main graph while duplicate names and cycles are rejected', () => {
    fixture((root, write, projects) => {
        write('packages/library/example/package.json', { name: 'example' });
        assert.equal(workspaceProjects(root).length, 2);
        assert.deepEqual(
            developmentBuildPlan(root, ['@box/app']).map((project) => project.name),
            ['@box/library'],
        );
        write('packages/library/package.json', {
            name: '@box/library',
            dependencies: { '@box/app': 'workspace:*' },
        });
        assert.throws(() => workspaceProjects(root), /Circular/);
        write('rush.json', { projects: [...projects, projects[0]] });
        assert.throws(() => workspaceProjects(root), /Duplicate/);
    });
});

test('project aliases reuse registered scripts, preserve installer targets and deploy existing images only', () => {
    assert.equal(projectCommandPlan('dev-player-launcher').script, 'dev:electron');
    assert.equal(projectCommandPlan('api-docs').folder, 'internals/apis');
    const nativeManager = projectCommandPlan('dev-manager', ['--native']);
    assert.equal(nativeManager.script, 'tauri');
    assert.deepEqual(nativeManager.args, ['--', 'dev']);
    const player = projectCommandPlan('package-player-launcher', ['--target', 'windows-arm64']);
    assert.deepEqual(player.args, ['--', '--win', '--arm64']);
    assert.throws(
        () => projectCommandPlan('package-player-launcher', ['--target', 'windows-arm64;invalid']),
        /Invalid/,
    );
    assert.deepEqual(projectCommandPlan('deploy-service', ['--service', 'play']).args, ['play-up']);
    assert.throws(() => projectCommandPlan('deploy-service'), /--service/);
    assert.throws(() => projectCommandPlan('deploy-service', ['play']), /--service/);
});

for (const noAdmin of [false, true]) {
    test(`source startup builds dependencies before services and uses the live TS portal (no-admin=${noAdmin})`, () => {
        const calls = [];
        const requireMock = (name) => {
            if (name === 'fs') {
                return {
                    existsSync: () => false,
                    readFileSync: () => Buffer.from('{}'),
                    writeFileSync() {},
                    rmSync() {},
                };
            }
            if (name === './workspace-projects') {
                return {
                    developmentBuildPlan: () => [{ name: '@box/apis', folder: 'internals/apis' }],
                };
            }
            if (name === './dev-environment') {
                return require('./dev-environment');
            }
            if (name === 'child_process') {
                return {
                    spawnSync: (...args) => {
                        calls.push({ kind: 'build', args });
                        return { status: 0 };
                    },
                    spawn: (...args) => {
                        calls.push({ kind: 'start', args });
                        return { stdout: { on() {} }, stderr: { on() {} }, once() {} };
                    },
                };
            }
            return require(name);
        };
        requireMock.resolve = (name) =>
            name === '@umijs/max/package.json' ? '/umi/package.json' : '/next/bin/next';
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'dev-all.js'), 'utf8'), {
            __dirname,
            require: requireMock,
            process: {
                platform: 'linux',
                execPath: '/node',
                argv: ['/node', 'dev-all.js', ...(noAdmin ? ['--no-admin'] : [])],
                env: {},
                on() {},
            },
            console: {
                log() {},
                error(message) {
                    throw new Error(message);
                },
            },
            setTimeout() {},
        });
        assert.equal(calls[0].kind, 'build');
        const portal = calls.find((call) => call.args[2]?.cwd.endsWith('player-auth-portal'));
        assert.ok(portal.args[1].includes('scripts/tasks.ts'));
        assert.ok(portal.args[1].includes('--live'));
        assert.equal(portal.args[2].env.PORT, '3125');
        assert.equal(
            calls.some((call) => call.args[2]?.cwd.endsWith('player-admin')),
            !noAdmin,
        );
    });
}
