'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sha256(file) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytes = 0;
        do {
            bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytes) {
                hash.update(buffer.subarray(0, bytes));
            }
        } while (bytes);
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function fail(message) {
    throw new Error(`桌面启动器校验失败：${message}`);
}

function findApplication(packageRoot) {
    return fs
        .readdirSync(packageRoot, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
}

function findMetadataRoot(packageRoot) {
    if (fs.existsSync(path.join(packageRoot, 'BUILD-INFO.json'))) {
        return packageRoot;
    }
    const application = findApplication(packageRoot);
    if (!application) {
        fail('未找到 Windows 发布信息或 macOS APP');
    }
    return path.join(packageRoot, application.name, 'Contents/Resources/payload/metadata');
}

function verifyChecksums(metadataRoot) {
    const contents = fs.readFileSync(path.join(metadataRoot, 'SHA256SUMS'), 'utf8').trim();
    if (!contents) {
        fail('SHA256SUMS 为空');
    }
    for (const line of contents.split('\n')) {
        const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
        if (!match) {
            fail(`无效的 SHA256SUMS 行：${line}`);
        }
        const relative = match[2];
        const target = path.resolve(metadataRoot, relative);
        if (
            !target.startsWith(`${path.resolve(metadataRoot)}${path.sep}`) ||
            !fs.statSync(target).isFile()
        ) {
            fail(`校验文件不存在或越出包目录：${relative}`);
        }
        if (sha256(target) !== match[1]) {
            fail(`SHA-256 不匹配：${relative}`);
        }
    }
}

function rejectEmbeddedArchives(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            rejectEmbeddedArchives(target);
        } else if (/\.tar(?:\.gz)?$/.test(entry.name) || entry.name === 'BOX-OFFLINE-IMAGE.json') {
            fail(`轻量启动器不应包含离线镜像：${entry.name}`);
        }
    }
}

function verifyMacSignature(packageRoot) {
    const application = findApplication(packageRoot);
    if (!application || process.platform !== 'darwin') {
        return;
    }
    const target = path.join(packageRoot, application.name);
    const resourceSeal = path.join(target, 'Contents', '_CodeSignature', 'CodeResources');
    // A CI build without a Developer ID produces a bundle whose executable has
    // macOS's linker ad-hoc signature, but no outer App resource seal. Asking
    // codesign to strictly verify that unsigned bundle reports the misleading
    // “code has no resources” error. It is not a damaged signed application.
    // A signed release always has CodeResources and must pass strict checking.
    if (!fs.existsSync(resourceSeal)) {
        if (process.env.BOX_DESKTOP_REQUIRE_SIGNING === 'true') {
            fail('macOS APP 未使用 Developer ID 签名；正式发布请完成签名与公证');
        }
        return;
    }
    const verification = spawnSync('codesign', ['--verify', '--deep', '--strict', target], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (verification.status !== 0) {
        const detail = `${verification.stdout || ''}\n${verification.stderr || ''}`.trim();
        fail(`macOS APP 签名完整性校验失败${detail ? `：${detail}` : ''}`);
    }
    if (process.env.BOX_DESKTOP_REQUIRE_SIGNING !== 'true') {
        return;
    }
    const result = spawnSync('codesign', ['-dv', '--verbose=4', target], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const details = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status !== 0 || /Signature=adhoc|TeamIdentifier=not set/.test(details)) {
        fail('macOS APP 未使用 Developer ID 签名；正式发布请完成签名与公证');
    }
}

function verifyPackage(packageRoot) {
    packageRoot = path.resolve(packageRoot);
    if (!fs.statSync(packageRoot, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`目录不存在：${packageRoot}`);
    }
    const metadataRoot = findMetadataRoot(packageRoot);
    for (const name of [
        'BUILD-INFO.json',
        'LICENSE.txt',
        'THIRD-PARTY-NOTICES.json',
        'SHA256SUMS',
    ]) {
        if (!fs.statSync(path.join(metadataRoot, name), { throwIfNoEntry: false })?.isFile()) {
            fail(`缺少 ${name}`);
        }
    }
    const info = JSON.parse(fs.readFileSync(path.join(metadataRoot, 'BUILD-INFO.json'), 'utf8'));
    if (
        !info.version ||
        !info.sourceRevision ||
        !info.buildCreatedAt ||
        (info.source === 'local-dirty' && process.env.BOX_ALLOW_DIRTY_RELEASE !== 'true')
    ) {
        fail('BUILD-INFO.json 缺少正式构建版本、提交号或构建时间');
    }
    const modeFile = path.join(metadataRoot, 'BOX-PACKAGE-MODE.json');
    const mode = fs.existsSync(modeFile)
        ? JSON.parse(fs.readFileSync(modeFile, 'utf8')).mode
        : 'slim';
    let manifest;
    if (mode === 'local') {
        const application = findApplication(packageRoot);
        const payload = application
            ? path.join(packageRoot, application.name, 'Contents/Resources/payload')
            : packageRoot;
        manifest = JSON.parse(
            fs.readFileSync(path.join(payload, 'BOX-OFFLINE-IMAGE.json'), 'utf8'),
        );
        if (
            manifest.formatVersion !== 1 ||
            !manifest.imageTag ||
            !/^linux\/(arm64|amd64)$/.test(manifest.platform) ||
            path.basename(manifest.archive || '') !== manifest.archive
        ) {
            fail('本地镜像清单无效');
        }
        const archive = path.join(payload, manifest.archive);
        if (
            !fs.statSync(archive, { throwIfNoEntry: false })?.isFile() ||
            sha256(archive) !== manifest.sha256
        ) {
            fail('本地镜像归档缺失或 SHA-256 不匹配');
        }
        if (fs.existsSync(path.join(metadataRoot, 'BOX-REMOTE-IMAGE.json'))) {
            fail('本地模式不能同时启用 OSS 镜像清单');
        }
    } else {
        if (mode !== 'slim') {
            fail('未知启动器打包模式');
        }
        rejectEmbeddedArchives(packageRoot);
        const manifestPath = path.join(metadataRoot, 'BOX-REMOTE-IMAGE.json');
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const { validateCatalog } = require('./build-image-downloads');
        validateCatalog(manifest, manifest.platform?.split('/')[1]);
    }
    verifyChecksums(metadataRoot);
    verifyMacSignature(packageRoot);
    return { manifest };
}

if (require.main === module) {
    try {
        const packageRoot = process.argv[2];
        assert.ok(packageRoot, '用法: node scripts/verify-desktop-offline-package.js <启动器目录>');
        const result = verifyPackage(packageRoot);
        console.log(`Desktop launcher package verified: ${result.manifest.imageTag}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { verifyPackage };
