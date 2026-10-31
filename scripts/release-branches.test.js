'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { productionVersion, packagingContext } = require('./packaging-context');
const { engineReleaseContext } = require('./release-context');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);

test('versioned branches select independent production versions even before manifests are bumped', () => {
    const env = {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/release/v2026.1.5',
        GITHUB_SHA: 'a'.repeat(40),
    };
    assert.equal(productionVersion(env.GITHUB_REF), '2026.1.5');
    assert.equal(packagingContext(env, '2026.1.4').version, '2026.1.5');
    assert.equal(engineReleaseContext(env, '2026.1.4').tag, 'v2026.1.5');
    assert.equal(
        packagingContext(
            { ...env, GITHUB_REF: 'refs/heads/player-release/v2026.1.3' },
            '2026.1.2',
            'PLAYER_BUILD_CHANNEL',
        ).version,
        '2026.1.3',
    );
    assert.equal(
        packagingContext({ ...env, GITHUB_ACTIONS: '' }, '2026.1.4').version,
        '2026.1.4-dev',
    );
    for (const ref of [
        'refs/heads/release',
        'refs/heads/release/v2026.01.5',
        'refs/heads/release/v2026.1.5-staging',
        'refs/heads/release/v2026.1.5/extra',
        'refs/tags/v2026.1.5',
        'refs/heads/player-release/v2026.1.5',
    ]) {
        assert.throws(() => productionVersion(ref));
    }
});

for (const [file, prefix, validation] of [
    ['release.yml', 'release', 'validate-release'],
    ['player-launcher-release.yml', 'player-release', 'validate'],
]) {
    test(`${file} builds a newly created release branch exactly once and isolates product entry points`, () => {
        const workflow = yaml.load(
            fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8'),
        );
        assert.equal(Object.hasOwn(workflow.on, 'create'), false);
        assert.ok(workflow.on.push.branches.includes(`${prefix}/v*`));
        assert.equal(workflow.jobs['merge-gate'], undefined);
        const runs = (eventName, ref, event = {}) =>
            Object.hasOwn(workflow.on, eventName) &&
            vm.runInNewContext(`Boolean(${workflow.jobs[validation].if})`, {
                github: { event_name: eventName, ref, event },
                startsWith: (value, beginning) => value.startsWith(beginning),
            });
        const ref = `refs/heads/${prefix}/v2026.1.5`;
        assert.equal(
            Number(runs('workflow_dispatch', ref)) + Number(runs('push', ref, { created: true })),
            1,
        );
        assert.equal(runs('push', ref, { created: false }), true);
        assert.equal(runs('workflow_dispatch', ref), true);
        assert.equal(runs('push', 'refs/heads/staging', { created: true }), true);
        assert.equal(runs('create', 'refs/heads/staging', { ref_type: 'branch' }), false);
        for (const other of [
            'refs/heads/main',
            'refs/heads/release',
            'refs/tags/v2026.1.5',
            `refs/heads/${prefix === 'release' ? 'player-release' : 'release'}/v2026.1.5`,
        ]) {
            assert.equal(runs('create', other, { ref_type: 'branch' }), false);
            assert.equal(runs('workflow_dispatch', other), false);
        }
    });
}

const creationRouter = yaml.load(
    fs.readFileSync(
        path.join(__dirname, '../.github/workflows/release-branch-created.yml'),
        'utf8',
    ),
);

test('only branch creation can dispatch a product release', () => {
    assert.ok(Object.hasOwn(creationRouter.on, 'create'));
    assert.equal(creationRouter.permissions.actions, 'write');
    assert.equal(creationRouter.jobs.dispatch.if, "github.event.ref_type == 'branch'");
});

for (const [ref, expected] of [
    ['release/v2026.1.4', 'release.yml'],
    ['player-release/v2026.1.2', 'player-launcher-release.yml'],
    ['release/v2026.0.1', 'release.yml'],
    ['staging', null],
    ['dev-fish', null],
    ['release', null],
    ['release/v2026.1.4-staging', null],
    ['release/v2026.01.4', null],
    ['\u200brelease/v2026.1.4', null],
    ['player-release/v2026.1.2\u200b', null],
]) {
    test(`creation router dispatches exactly the matching product for ${JSON.stringify(ref)}`, async () => {
        const calls = [];
        const script = creationRouter.jobs.dispatch.steps[0].with.script;
        const dispatch = vm.runInNewContext(`(async () => { ${script} })()`, {
            context: {
                payload: { ref, ref_type: 'branch' },
                repo: { owner: 'box3lab', repo: 'box3-local-engine' },
            },
            github: {
                rest: {
                    actions: {
                        createWorkflowDispatch: async (request) => {
                            calls.push({ ...request });
                        },
                    },
                },
            },
            core: { notice() {} },
        });
        await dispatch;
        assert.deepEqual(
            calls,
            expected
                ? [{ owner: 'box3lab', repo: 'box3-local-engine', workflow_id: expected, ref }]
                : [],
        );
    });
}
