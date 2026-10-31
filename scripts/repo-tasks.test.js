'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, 'repo-tasks.js'), 'utf8');

function runTask(task, failBuild = false, failAssets = false) {
    const calls = [];
    const context = {
        __dirname,
        require(name) {
            if (name === './test-dependency-build') {
                return require('./test-dependency-build');
            }
            if (name !== 'node:child_process') {
                return require(name);
            }
            return {
                spawnSync(command, args, options) {
                    calls.push({ command, args, cwd: options.cwd });
                    return {
                        status:
                            (failBuild && args.includes('build')) ||
                            (failAssets && args.includes('prepare-assets'))
                                ? 1
                                : 0,
                    };
                },
            };
        },
        process: {
            platform: 'linux',
            execPath: '/test/node',
            env: {},
            argv: ['/test/node', 'repo-tasks.js', task],
            exit(code) {
                throw new Error(`exit ${code}`);
            },
        },
    };
    return { calls, execute: () => vm.runInNewContext(source, context) };
}

for (const task of ['test', 'check']) {
    test(`${task} prepares runtime dependencies once before regressions`, () => {
        const app = runTask(task);
        app.execute();
        const build = app.calls.findIndex((call) => call.args.includes('build'));
        assert.ok(build >= 0, 'must rebuild missing compiled runtime dependencies');
        for (const directory of [
            'internals/build-system',
            'internals/apis',
            'internals/env',
            'internals/schema',
        ]) {
            const matches = app.calls.filter(
                (call) => call.args.includes('build') && call.cwd.endsWith(directory),
            );
            assert.equal(matches.length, 1, `must build ${directory} exactly once`);
        }
        const schema = app.calls.findIndex(
            (call) => call.args.includes('build') && call.cwd.endsWith('internals/schema'),
        );
        const buildSystem = app.calls.findIndex(
            (call) => call.args.includes('build') && call.cwd.endsWith('internals/build-system'),
        );
        assert.ok(
            schema < buildSystem,
            'schema must be available before its dependent build system',
        );
        assert.equal(
            app.calls.some((call) => call.args.some((arg) => arg.endsWith('install-run-rush.js'))),
            false,
        );
        const regressions = app.calls.findIndex(
            (call) =>
                (call.cwd.endsWith('apps/local-engine') && call.args.includes('test')) ||
                call.args.some((arg) => arg.endsWith('regression-project-storage-identity.js')),
        );
        assert.ok(build < regressions, 'dependencies must exist before running regressions');
        const builds = app.calls.filter((call) => call.args.includes('build'));
        assert.equal(new Set(builds.map((call) => call.cwd)).size, builds.length);
        const preparedAssets = app.calls.filter(
            (call) =>
                call.cwd.endsWith('apps/local-engine') && call.args.includes('prepare-assets'),
        );
        assert.equal(preparedAssets.length, 1, 'runtime assets must be prepared exactly once');
        const assetPreparation = app.calls.indexOf(preparedAssets[0]);
        assert.ok(
            builds.every((call) => app.calls.indexOf(call) < assetPreparation),
            'asset preparation needs the compiled dependency packages',
        );
        assert.ok(
            assetPreparation < regressions,
            'generated runtime assets must exist before regressions',
        );
        const apiCheck = app.calls.findIndex((call) => call.args.includes('check:openapi'));
        assert.ok(
            apiCheck >= 0 && apiCheck < build,
            'must reject stale generated API before rebuilding it',
        );
    });
}

test('dependency build failure stops before runtime regressions', () => {
    const app = runTask('test', true);
    assert.throws(app.execute, /exit 1/);
    assert.equal(
        app.calls.some(
            (call) => call.cwd.endsWith('apps/local-engine') && call.args.includes('test'),
        ),
        false,
    );
});

test('asset preparation failure stops before runtime regressions and closure checks', () => {
    const app = runTask('test', false, true);
    assert.throws(app.execute, /exit 1/);
    assert.equal(
        app.calls.some(
            (call) =>
                (call.cwd.endsWith('apps/local-engine') && call.args.includes('test')) ||
                call.args.some((arg) => arg.endsWith('check-standalone.js')),
        ),
        false,
    );
});

for (const task of ['test']) {
    test(`${task} includes Creator, player launcher and anti-cheat regressions`, () => {
        const app = runTask(task);
        app.execute();
        for (const [folder, script] of [
            ['apps/game', 'test'],
            ['apps/player-launcher', 'check'],
            ['services/game-server', 'check:anticheat'],
        ]) {
            const matches = app.calls.filter(
                (call) => call.cwd.endsWith(folder) && call.args.includes(script),
            );
            assert.equal(matches.length, 1, `${folder} ${script} must run exactly once`);
        }
        const creator = app.calls.find(
            (call) => call.cwd.endsWith('apps/game') && call.args.includes('test'),
        );
        assert.ok(creator.args.includes('--runInBand'), 'keep CI memory use bounded');
    });
}

for (const task of ['test', 'check']) {
    test(`${task} guards runtime resources`, () => {
        const app = runTask(task);
        app.execute();
        const file = 'apps/local-engine/src/runtime-assets.test.js';
        assert.equal(
            app.calls.filter((call) => call.args.some((arg) => arg.endsWith(file))).length,
            1,
            `${file} must run exactly once`,
        );
    });
}

test('verify only checks formatting and lint without building or running regressions', () => {
    const app = runTask('verify');
    app.execute();
    assert.deepEqual(
        app.calls.map((call) => [
            path.relative(path.resolve(__dirname, '..'), call.cwd),
            Array.from(call.args),
        ]),
        [
            ['tools/repo-tooling', ['run', 'format:check']],
            ['tools/repo-tooling', ['run', 'lint:root']],
            ['apps/game', ['run', 'lint']],
            ['apps/voxa', ['run', 'lint']],
        ],
    );
});

test('typecheck builds shared APIs before checking the admin and portal', () => {
    const app = runTask('typecheck');
    app.execute();
    const apiBuild = app.calls.findIndex(
        (call) => call.cwd.endsWith('internals/apis') && call.args.includes('build'),
    );
    const checks = app.calls.filter((call) => call.args.includes('typecheck'));
    assert.deepEqual(
        checks.map((call) => path.relative(path.resolve(__dirname, '..'), call.cwd)),
        ['apps/player-admin', 'apps/player-auth-portal'],
    );
    assert.ok(apiBuild >= 0 && apiBuild < app.calls.indexOf(checks[0]));
});

test('dependency ordering shares prerequisites, ignores external packages and detects cycles', () => {
    const { orderDependencyBuilds } = require('./test-dependency-build');
    const projects = [
        { name: 'first', dependencies: ['shared', 'external'], build: true },
        { name: 'second', dependencies: ['shared'], build: true },
        { name: 'shared', dependencies: [], build: true },
        { name: 'unrelated', dependencies: [], build: true },
    ];
    assert.deepEqual(
        orderDependencyBuilds(projects, ['first', 'second']).map((p) => p.name),
        ['shared', 'first', 'second'],
    );
    projects[2].dependencies.push('first');
    assert.throws(() => orderDependencyBuilds(projects, ['first']), /Circular test dependency/);
});
