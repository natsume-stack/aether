'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workflowPath = path.join(root, '.github/workflows/package-server.yml');
assert.ok(fs.existsSync(workflowPath), 'manual server package workflow is missing');

const workflow = fs.readFileSync(workflowPath, 'utf8');
// Replay environment preparation with only templates available in a fresh checkout.
const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-server-workflow-'));
try {
    const templates = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter((file) => /^\.env[^/]*example$/.test(file));
    for (const file of templates) {
        fs.copyFileSync(path.join(root, file), path.join(environmentRoot, file));
    }
    const copies = workflow
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^cp \.env/.test(line));
    assert.equal(copies.length, 2, 'prepare both build environment files');
    const result = spawnSync('sh', ['-ec', copies.join('\n')], {
        cwd: environmentRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || 'environment preparation failed');
    const template = fs.readFileSync(path.join(root, '.env.docker.example'), 'utf8');
    for (const file of ['.env', '.runtime.env']) {
        assert.equal(fs.readFileSync(path.join(environmentRoot, file), 'utf8'), template);
    }
} finally {
    fs.rmSync(environmentRoot, { recursive: true, force: true });
}
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /architecture:/);
assert.match(workflow, /publish_stable:/);
assert.match(workflow, /Updating the stable CDN requires both amd64 and arm64 packages/);
assert.match(workflow, /box-local-engine-images-v\$\{\{ inputs\.version \}\}-linux-/);
assert.match(workflow, /box-local-engine-images-v\$\{\{ inputs\.version \}\}-linux-.*\.json/);
assert.match(workflow, /--catalog/);
assert.match(workflow, /node scripts\/server-image-plan\.js plan-manager/);
assert.match(workflow, /for service in server-manager; do/);
assert.doesNotMatch(workflow, /for service in player-service/);
assert.match(workflow, /Run the release workflow/);
assert.doesNotMatch(workflow, /build all images/);
assert.match(workflow, /node scripts\/server-image-plan\.js merge/);
assert.match(workflow, /docker compose build "\$service"/);
assert.match(workflow, /version and source match/);
assert.match(workflow, /ossutil stat/);
assert.match(workflow, /python3 scripts\/split-image-archive\.py/);
assert.match(workflow, /Publish immutable archives before/);
assert.doesNotMatch(workflow, /docker load -i/);
assert.match(workflow, /node scripts\/build-headless-server-package\.js/);
assert.match(workflow, /node scripts\/verify-headless-server-package\.js/);
assert.match(workflow, /OSS_BUILD_PREFIX: local-engine\/v\$\{\{ inputs\.version \}\}/);
assert.match(workflow, /OSS_SERVER_RELEASE_PREFIX: local-engine/);
assert.match(workflow, /package_version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
assert.doesNotMatch(workflow, /node -p \\"require/);
assert.match(workflow, /latest\.txt/);
assert.match(workflow, /latest-server\.json/);
assert.match(workflow, /buildReleaseManifest/);
assert.match(workflow, /pointer last/);

console.log('manual server package workflow check passed');
