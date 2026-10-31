'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const yaml = require(
    require.resolve('js-yaml', { paths: [path.join(__dirname, '../tools/repo-tooling')] }),
);
const workflow = yaml.load(
    fs.readFileSync(path.join(__dirname, '../.github/workflows/verify.yml'), 'utf8'),
);

test('promotion PRs keep a skipped verify status without running checks', () => {
    assert.ok(workflow.on.pull_request);
    assert.equal(workflow.on.pull_request['branches-ignore'], undefined);
    const runs = (base, event = 'pull_request') =>
        vm.runInNewContext(`Boolean(${workflow.jobs.verify.if})`, {
            github: { event_name: event, base_ref: base },
            startsWith: (value, prefix) => value.startsWith(prefix),
        });
    for (const branch of ['main', 'staging', 'release/v2026.1.4']) {
        assert.equal(runs(branch), false, branch);
    }
    for (const branch of ['dev', 'dev-fish', 'dev/feature', 'player-release/v2026.1.2']) {
        assert.equal(runs(branch), true, branch);
    }
    assert.equal(runs('', 'push'), true);
});

test('promotion pushes do not rerun Verify while development branches remain covered', () => {
    assert.deepEqual(workflow.on.push.branches, [
        'dev',
        'dev-*',
        'dev/**',
        'player-dev/**',
        'player-release/**',
    ]);
});
