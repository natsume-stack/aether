'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);

test('one player workflow builds, checks and collects both channels before production publication', () => {
    const root = path.resolve(__dirname, '..');
    assert.equal(
        fs.existsSync(path.join(root, '.github/workflows/player-launcher-test-build.yml')),
        false,
    );
    const workflow = yaml.load(
        fs.readFileSync(path.join(root, '.github/workflows/player-launcher-release.yml'), 'utf8'),
    );
    assert.deepEqual(workflow.on.push.branches, ['staging', 'player-release/v*']);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.equal(workflow.jobs.installers.if, undefined);
    assert.equal(workflow.jobs.installers.strategy.matrix.include.length, 5);
    const steps = workflow.jobs.installers.steps;
    for (const command of [
        'release.mts probe',
        'run check',
        'run test:desktop',
        'run test:menu',
        'run test:cache',
        'release.mts build',
        'release.mts upload',
    ]) {
        assert.ok(
            steps.some((step) => step.run?.includes(command)),
            command,
        );
    }
    const publish = workflow.jobs.publish;
    assert.equal(publish.if, undefined);
    assert.ok(publish.steps.some((step) => step.run?.endsWith('release.mts download')));
    assert.equal(
        publish.steps.find((step) => step.uses === 'softprops/action-gh-release@v3').if,
        "startsWith(github.ref, 'refs/heads/player-release/v')",
    );
});
