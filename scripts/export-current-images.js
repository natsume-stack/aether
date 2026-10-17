'use strict';

// Export images that already exist in the local Docker daemon. This is kept
// separate from package:images: that command builds images, while this
// command is the quick hand-off path for a launcher after maintainers have
// rebuilt one or more services locally.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultExportImageTag } = require('./export-image-plan');

const root = path.resolve(__dirname, '..');
const packageVersion = require(path.join(root, 'package.json')).version;
const services = [
    'player-service',
    'player-auth-portal',
    'server-manager',
    'creator',
    'play',
    'voxa',
];
const hostArchitecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '';
if (!hostArchitecture) {
    fail(`不支持当前主机架构：${process.arch}`);
}
// Keep this channel tag in sync with package-images. BOX_IMAGE_TAG configures
// runtime Compose deployments and may legitimately point at an older image;
// it must not change which freshly built release images this command exports.
const imageTag = defaultExportImageTag(packageVersion, hostArchitecture);

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

if (process.argv.length !== 2) {
    fail('用法: rush export-images');
}

function inspectImage(image) {
    const result = spawnSync(
        'docker',
        ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image],
        {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    if (result.error) {
        if (result.error.code === 'ENOENT') {
            fail('未找到 Docker。请先安装并启动 Docker Desktop。');
        }
        throw result.error;
    }
    return result.status === 0 ? String(result.stdout || '').trim() : '';
}

const images = services.map((service) => `box-local-engine-${service}:${imageTag}`);
const missingImages = images.filter((image) => !inspectImage(image));
if (missingImages.length) {
    fail(
        `以下镜像尚未在本机构建，不能导出：\n${missingImages.map((image) => `  - ${image}`).join('\n')}\n` +
            '请先构建缺少的服务后再执行 rush export-images',
    );
}

const platforms = new Set(images.map(inspectImage));
if (platforms.size !== 1) {
    fail(`镜像架构不一致，不能放入同一个启动器归档：${[...platforms].join('、')}`);
}
const platform = [...platforms][0];
const safeTag = imageTag.replace(/[^a-zA-Z0-9._-]/g, '_');
const safePlatform = platform.replace('/', '-');
// Release images carry their target platform in BOX_IMAGE_TAG already; local
// launcher builds usually use a plain version tag, so add it only when needed.
const platformSuffix = safeTag.endsWith(`-${safePlatform}`) ? '' : `-${safePlatform}`;
const outputDirectory = path.join(root, 'apps/local-engine/dist/images');
const output = path.join(
    outputDirectory,
    `box-local-engine-images-${safeTag}${platformSuffix}.tar.gz`,
);
const temporaryTar = `${output}.${process.pid}.tar.tmp`;
const temporaryOutput = `${output}.${process.pid}.tmp`;

fs.mkdirSync(outputDirectory, { recursive: true });
for (const target of [temporaryTar, temporaryOutput]) {
    fs.rmSync(target, { force: true });
}

try {
    const save = spawnSync('docker', ['image', 'save', '--output', temporaryTar, ...images], {
        cwd: root,
        stdio: 'inherit',
    });
    if (save.error) {
        throw save.error;
    }
    if (save.status !== 0) {
        throw new Error(`导出 Docker 镜像失败，退出码 ${save.status ?? 'unknown'}`);
    }

    const outputDescriptor = fs.openSync(temporaryOutput, 'w');
    const gzip = spawnSync('gzip', ['-1', '--stdout', temporaryTar], {
        stdio: ['ignore', outputDescriptor, 'inherit'],
    });
    fs.closeSync(outputDescriptor);
    if (gzip.error) {
        throw gzip.error;
    }
    if (gzip.status !== 0) {
        throw new Error(`压缩镜像归档失败，退出码 ${gzip.status ?? 'unknown'}`);
    }
    if (!fs.existsSync(temporaryOutput) || fs.statSync(temporaryOutput).size === 0) {
        throw new Error('压缩后的镜像归档为空');
    }

    fs.renameSync(temporaryOutput, output);
    console.log(`\n启动器镜像归档：${output}`);
    console.log(`镜像标签：${imageTag}`);
    console.log(`镜像架构：${platform}`);
    console.log(`导入命令：docker load -i ${output}\n`);
} catch (error) {
    console.error(`ERROR: ${error.message || error}`);
    process.exitCode = 1;
} finally {
    fs.rmSync(temporaryTar, { force: true });
    fs.rmSync(temporaryOutput, { force: true });
}
