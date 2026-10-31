'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testDependencyBuildPlan } = require('./test-dependency-build');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd = root, env = process.env) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function node(script, args = [], cwd = root) {
    run(process.execPath, [path.resolve(root, script), ...args], cwd);
}

function npmScript(directory, script, args = []) {
    run(npm, ['run', script, ...(args.length ? ['--', ...args] : [])], path.join(root, directory));
}

function format(write) {
    npmScript('tools/repo-tooling', write ? 'format' : 'format:check');
}

function lint() {
    npmScript('tools/repo-tooling', 'lint:root');
    npmScript('apps/game', 'lint');
    npmScript('apps/voxa', 'lint');
}

function typecheck() {
    prepareTestDependencies();
    npmScript('apps/player-admin', 'typecheck');
    npmScript('apps/player-auth-portal', 'typecheck');
}

let testDependenciesPrepared = false;

function prepareTestDependencies() {
    if (testDependenciesPrepared) {
        return;
    }
    // Check committed API artifacts before its build can regenerate them.
    npmScript('internals/apis', 'check:openapi');
    // These packages expose compiled entry points. A clean checkout has no
    // schema/API outputs, and an incremental cache can outlive deleted outputs.
    // Run package builds directly: nesting Rush inside a global Rush command
    // would acquire the same repository lock twice.
    for (const project of testDependencyBuildPlan(root)) {
        npmScript(project.folder, 'build');
    }
    // Runtime references include generated API/texture/model assets. Rebuild
    // these from approved source inputs before checking or copying their closure.
    npmScript('apps/local-engine', 'prepare-assets');
    testDependenciesPrepared = true;
}

function check() {
    node('scripts/rush-project-command.js', ['workspace-check']);
    prepareTestDependencies();
    for (const folder of [
        'packages/player-policy',
        'packages/realtime-client',
        'packages/deployment-routing',
    ]) {
        npmScript(folder, 'test');
    }
    npmScript('internals/apis', 'test');
    run(process.execPath, [
        '--test',
        'scripts/dev-environment.test.js',
        'scripts/repo-tasks.test.js',
        'scripts/workspace-projects.test.js',
        'scripts/docker-engine-build.test.js',
        'scripts/deployment-manager-build.test.js',
        'scripts/deployment-manager-structure.test.js',
        'scripts/client-format.test.js',
        'scripts/package-manifest-order.test.js',
        'scripts/documentation-links.test.js',
        'scripts/browser-runtime-config.test.js',
        'scripts/audit-dependencies.test.js',
        'scripts/game-test-environment.test.js',
    ]);
    node('apps/local-engine/src/build-metadata.test.js');
    node('apps/local-engine/src/runtime-assets.test.js');
    node('apps/local-engine/scripts/regression-project-storage-identity.js');
    node('scripts/regression-empty-mesh-asset.js');
    node('scripts/check-standalone.js');
    node('scripts/check-play-version-refresh.js');
    npmScript('apps/game', 'test:local-runtime-session');
    for (const script of [
        'check:model-library-scope',
        'check:model-project-bundle',
        'check:local-cors',
        'check:model-management-permission',
    ]) {
        npmScript('apps/voxa', script);
    }
    npmScript('services/game-server', 'check:disabled-storage');
    node('scripts/platform-api-removal.test.js');
    node('scripts/check-engine-wire-protocols.js');
    node('scripts/check-public-repository.js');
    run(process.execPath, [
        '--test',
        'scripts/internal-migrator.test.js',
        'scripts/check-public-repository.test.js',
        'scripts/release-source-guard.test.js',
        'scripts/check-public-history.test.js',
    ]);
    node('scripts/check-windows-offline-installer.js');
    run(process.execPath, [
        '--test',
        'scripts/export-current-images.test.js',
        'scripts/package-release.test.js',
        'scripts/build-desktop-offline-installer.test.js',
        'scripts/verify-desktop-offline-package.test.js',
        'scripts/linux-bootstrap-installer.test.js',
        'scripts/server-installation-contract.test.js',
        'scripts/server-image-plan.test.js',
        'scripts/server-package-workflow.test.js',
        'scripts/release-context.test.js',
        'scripts/test-build-workflow.test.js',
        'scripts/player-test-build-workflow.test.js',
        'scripts/github-build-gate.test.js',
        'scripts/build-image-downloads.test.js',
    ]);
    node('scripts/check-desktop-deployment-manager.js');
    node('scripts/check-headless-rust-manager.js');
    node('scripts/check-public-routing-structure.js');
    run(process.execPath, [
        '--test',
        'scripts/deployment-manager-ui.test.js',
        'scripts/deployment-manager-transport.test.js',
        'scripts/deployment-manager-updates.test.js',
    ]);
    node('scripts/check-release-workflow.js');
    node('scripts/check-server-package-workflow.js');
    node('scripts/check-documentation.js');
    run(
        process.execPath,
        ['-r', '@swc-node/register', 'scripts/regression-map-group-state-lock.ts'],
        path.join(root, 'services/game-server'),
    );
    npmScript('apps/player-auth-portal', 'check');
    run('cargo', ['test', '--manifest-path', 'apps/manager-core/Cargo.toml']);
    // cargo test enables cfg(test); also compile the actual manager binary.
    run('cargo', ['check', '--manifest-path', 'apps/server-manager-rust/Cargo.toml']);
    run('cargo', ['test', '--manifest-path', 'apps/server-manager-rust/Cargo.toml']);
    run(process.execPath, [
        '--test',
        'scripts/teleport-room-manager.test.js',
        'scripts/teleport-library-integration.test.js',
    ]);
}

function test() {
    prepareTestDependencies();
    npmScript('apps/local-engine', 'test');
    npmScript('services/game-server', 'test');
    npmScript('apps/game', 'test', ['--runInBand']);
    npmScript('apps/player-launcher', 'check');
    npmScript('services/game-server', 'check:anticheat');
    check();
}

const task = process.argv[2];
if (task === 'format') {
    format(true);
} else if (task === 'format-check') {
    format(false);
} else if (task === 'lint') {
    lint();
} else if (task === 'typecheck') {
    typecheck();
} else if (task === 'check') {
    check();
} else if (task === 'test') {
    test();
} else if (task === 'verify') {
    format(false);
    lint();
} else {
    throw new Error(`Unknown repository task: ${task || '(missing)'}`);
}
