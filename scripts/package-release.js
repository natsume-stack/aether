'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packagingContext } = require('./packaging-context');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, 'apps/local-engine/dist/images');

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
    });
    if (result.error) {
        fail(`无法启动 ${command}：${result.error.message}`);
    }
    if (result.status !== 0) {
        fail(`${command} 执行失败，退出码 ${result.status ?? 'unknown'}`);
    }
}

function architectureForDesktopTarget(target) {
    if (!/^(?:windows|macos|linux)-(?:amd64|arm64)$/.test(target)) {
        return '';
    }
    return target.endsWith('-arm64') ? 'arm64' : 'amd64';
}

function usage(kind) {
    if (kind === 'desktop') {
        return '用法: rush package-desktop --target <windows-amd64|windows-arm64|macos-amd64|macos-arm64|linux-amd64|linux-arm64> [--archive 镜像归档.tar.gz] [--mode slim|local]';
    }
    return '用法: rush package-web --architecture <amd64|arm64> [--archive 镜像归档.tar.gz] [--mode slim|local]';
}

function createReleasePlan(kind, target, archiveArgument, version, mode = 'slim') {
    if (!['slim', 'local'].includes(mode)) {
        throw new Error('打包模式只能是 slim 或 local');
    }
    const architecture =
        kind === 'desktop' ? architectureForDesktopTarget(target || '') : target || '';
    const suppliedArchive = String(archiveArgument || '').trim();
    if (mode === 'local' && suppliedArchive.endsWith('.json')) {
        throw new Error('本地模式需要完整镜像归档');
    }
    return {
        architecture,
        archive: suppliedArchive
            ? path.resolve(root, suppliedArchive)
            : path.join(
                  mode === 'local'
                      ? path.join(root, 'apps/local-engine/dist/local-images')
                      : outputDirectory,
                  `box-local-engine-images-v${version}-linux-${architecture}.tar.gz`,
              ),
        buildImages: suppliedArchive.length === 0,
        mode,
    };
}

function executeReleasePlan(
    kind,
    target,
    plan,
    execute = run,
    archiveExists = (archive) => fs.statSync(archive, { throwIfNoEntry: false })?.isFile() === true,
) {
    if (plan.buildImages) {
        execute(process.execPath, [
            path.join('scripts', 'package-offline-images.js'),
            plan.architecture,
            ...(plan.mode === 'local' ? ['--local'] : []),
        ]);
    }

    if (!archiveExists(plan.archive)) {
        fail(`镜像归档未生成：${plan.archive}`);
    }

    execute(process.execPath, [
        path.join(
            'scripts',
            kind === 'desktop'
                ? 'build-desktop-offline-installer.js'
                : 'build-headless-server-package.js',
        ),
        kind === 'desktop' ? target : plan.architecture,
        ...(kind === 'web' && plan.archive.endsWith('.json')
            ? ['--catalog', plan.archive]
            : [plan.archive]),
        ...(plan.mode === 'local' ? ['--local'] : []),
    ]);
}

function main() {
    const kind = process.argv[2];
    const target = process.argv[3];
    const architecture =
        kind === 'desktop' ? architectureForDesktopTarget(target || '') : target || '';
    if (
        !['desktop', 'web'].includes(kind) ||
        !architecture ||
        !['amd64', 'arm64'].includes(architecture)
    ) {
        fail(usage(kind));
    }

    // Build every offline service and export exactly one versioned archive before
    // invoking the platform-specific packager. CI passes the archive produced by
    // its Linux image job, so desktop runners must package that artifact instead
    // of trying to build Linux containers themselves.
    run(process.execPath, [path.join('scripts', 'sync-root-version.js')]);

    const { channel, version } = packagingContext(
        process.env,
        require(path.join(root, 'package.json')).version,
    );
    process.env.BOX_BUILD_CHANNEL = channel;
    process.env.BOX_BUILD_VERSION = version;
    const plan = createReleasePlan(
        kind,
        target,
        process.argv[4],
        version,
        process.argv[5] || 'slim',
    );
    executeReleasePlan(kind, target, plan);
}

if (require.main === module) {
    main();
}

module.exports = { architectureForDesktopTarget, createReleasePlan, executeReleasePlan };
