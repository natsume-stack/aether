'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packagingContext } = require('./packaging-context');

const repoRoot = path.resolve(__dirname, '..');
const outputRoot =
    process.env.BOX_LAUNCHER_OUTPUT_DIRECTORY ||
    path.join(repoRoot, 'apps/local-engine/dist/server-packages');
const templateRoot = path.join(repoRoot, 'distribution/server');
const supportedArchitectures = new Set(['amd64', 'arm64']);
const { splitArchive, validateCatalog, localImageTag } = require('./build-image-downloads');

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

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

function createZip(packageRoot, destination) {
    fs.rmSync(destination, { force: true });
    const result = spawnSync('zip', ['-rq', destination, path.basename(packageRoot)], {
        cwd: path.dirname(packageRoot),
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        fail(`服务器离线包 ZIP 打包失败，退出码 ${result.status}`);
    }
}

function serviceSection(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    if (startIndex < 0 || endIndex < 0) {
        fail(`无法从 Compose 模板提取服务：${start.trim()}`);
    }
    return source.slice(startIndex, endIndex);
}

function headlessCompose() {
    const source = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const servicesIndex = source.indexOf('services:\n');
    const header = source.slice(0, servicesIndex + 'services:\n'.length);
    const managedRedis = serviceSection(source, '  managed-redis:', '  managed-postgres:');
    const managedPostgres = serviceSection(source, '  managed-postgres:', '  postgres:');
    const playerService = serviceSection(source, '  player-service:', '  player-auth-portal:');
    const authPortal = serviceSection(source, '  player-auth-portal:', '  server-manager:');
    const serverManager = serviceSection(source, '  server-manager:', '  creator:');
    const creator = serviceSection(source, '  creator:', '  play-storage-init:');
    const play = serviceSection(source, '  play-storage-init:', '  voxa:');
    const voxa = serviceSection(source, '  voxa:', '\nvolumes:\n');
    const volumes =
        'volumes:\n  box-managed-redis-data:\n  box-managed-postgres-data:\n  box-play-runtime-cache:\n';
    if (
        servicesIndex < 0 ||
        !managedRedis ||
        !managedPostgres ||
        !playerService ||
        !authPortal ||
        !serverManager ||
        !creator ||
        !play ||
        !voxa
    ) {
        fail('无法生成完整服务器 Compose 配置');
    }
    return `${header}${managedRedis}${managedPostgres}${playerService}${authPortal}${serverManager}${creator}${play}${voxa}${volumes}`;
}

function main() {
    const { channel, version } = packagingContext(process.env, require('../package.json').version);
    const local = process.argv.includes('--local') || channel === 'dev';
    const args = process.argv.slice(2).filter((value) => value !== '--local');
    const architecture = args[0];
    const catalogOnly = args[1] === '--catalog';
    if (channel === 'dev' && catalogOnly) {
        fail('开发包需要完整 dev 镜像归档，不能仅提供下载清单');
    }
    const archive = !catalogOnly && args[1] ? path.resolve(args[1]) : '';
    const suppliedCatalogPath = args[2] ? path.resolve(args[2]) : '';
    if (!supportedArchitectures.has(architecture)) {
        fail(
            '用法: node scripts/build-headless-server-package.js <amd64|arm64> <完整镜像归档.tar.gz> | --catalog <catalog.json>',
        );
    }
    if (catalogOnly && !suppliedCatalogPath) {
        fail('使用 --catalog 时必须提供 catalog.json');
    }
    if (
        !suppliedCatalogPath &&
        (!archive || !fs.statSync(archive, { throwIfNoEntry: false })?.isFile())
    ) {
        fail('镜像归档不存在');
    }
    if (archive && !path.basename(archive).includes(`linux-${architecture}`)) {
        fail(`镜像归档名称与目标架构 ${architecture} 不一致`);
    }

    const packageName = `BOX3-Engine-Server-${version}-linux-${architecture}${local ? '-local' : ''}`;
    const packageRoot = path.join(outputRoot, packageName);
    let imageTag = `v${version}-linux-${architecture}`;
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.mkdirSync(packageRoot, { recursive: true });

    fs.cpSync(templateRoot, packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'compose.yml'), headlessCompose());
    const splitRoot = path.join(outputRoot, `.split-${architecture}`);
    let catalog;
    let generatedCatalogPath = '';
    if (suppliedCatalogPath) {
        catalog = validateCatalog(
            JSON.parse(fs.readFileSync(suppliedCatalogPath, 'utf8')),
            architecture,
        );
    } else {
        fs.rmSync(splitRoot, { recursive: true, force: true });
        fs.mkdirSync(splitRoot, { recursive: true });
        generatedCatalogPath = path.join(splitRoot, 'catalog.json');
        catalog = splitArchive(archive, architecture, generatedCatalogPath);
    }
    const manager = catalog.images.find(
        (image) => image.image === 'box-local-engine-server-manager',
    );
    if (!manager) {
        fail('镜像清单中缺少 Server Manager');
    }
    if (local) {
        if (channel === 'dev') {
            require('./build-image-downloads').validateDevCatalog(catalog, version, architecture);
        }
        imageTag = localImageTag(catalog);
        catalog.imageTag = imageTag;
    }
    if (catalog.imageTag !== imageTag) {
        fail('镜像清单版本与服务器包版本不匹配');
    }
    fs.writeFileSync(
        path.join(packageRoot, 'BOX3-IMAGE-CATALOG.json'),
        JSON.stringify(catalog, null, 2) + '\n',
    );
    fs.writeFileSync(
        path.join(packageRoot, 'BOX3-MANAGER-IMAGE.json'),
        `${JSON.stringify({ image: manager.image, imageTag: manager.imageTag, platform: manager.platform, archive: manager.archive, sha256: manager.sha256, size: manager.size, contentTag: `${manager.image}:launcher-content-${manager.imageId.slice(7)}`, downloadBaseUrl: manager.downloadBaseUrl }, null, 2)}\n`,
    );
    fs.writeFileSync(
        path.join(packageRoot, 'BOX3-PACKAGE-MODE.json'),
        JSON.stringify(
            {
                mode: local ? 'local' : 'slim',
                channel,
                version,
                imageTag,
                platform: catalog.platform,
            },
            null,
            2,
        ) + '\n',
    );
    if (local) {
        const source = suppliedCatalogPath ? path.dirname(suppliedCatalogPath) : splitRoot;
        const cache = path.join(packageRoot, 'cache/engine-images');
        fs.mkdirSync(cache, { recursive: true });
        for (const image of catalog.images) {
            const archive = path.join(source, image.archive);
            if (
                !fs.statSync(archive, { throwIfNoEntry: false })?.isFile() ||
                fs.statSync(archive).size !== image.size ||
                sha256(archive) !== image.sha256
            ) {
                fail(`本地镜像归档缺失或损坏：${image.image}`);
            }
            fs.copyFileSync(archive, path.join(cache, image.archive));
        }
    }
    if (!suppliedCatalogPath) {
        fs.rmSync(splitRoot, { recursive: true, force: true });
    }

    const envTemplate = fs
        .readFileSync(path.join(templateRoot, '.env.example'), 'utf8')
        .replaceAll('__BOX_IMAGE_TAG__', imageTag)
        .replaceAll('__BOX_PLAY_PLATFORM__', `linux/${architecture}`);
    fs.writeFileSync(path.join(packageRoot, '.env.example'), envTemplate);
    const installer = fs
        .readFileSync(path.join(packageRoot, 'install.sh'), 'utf8')
        .replaceAll('__MANAGER_IMAGE_ARCHIVE__', manager.archive)
        .replaceAll(
            'https://assets.box3.fun/local-engine/$archive',
            `${manager.downloadBaseUrl || 'https://assets.box3.fun/local-engine'}/$archive`,
        );
    fs.writeFileSync(path.join(packageRoot, 'install.sh'), installer, { mode: 0o755 });
    // The template copies keep their committed mode (0644), and writeFileSync
    // only applies `mode` when it creates the file. Set the executable bit
    // explicitly so the unpacked ZIP can run ./install.sh directly.
    for (const file of ['install.sh', 'start.sh', 'status.sh', 'logs.sh', 'stop.sh', 'verify.sh']) {
        fs.chmodSync(path.join(packageRoot, file), 0o755);
    }

    const files = fs
        .readdirSync(packageRoot)
        .filter(
            (file) => file !== 'SHA256SUMS' && fs.statSync(path.join(packageRoot, file)).isFile(),
        )
        .sort()
        .map((file) => `${sha256(path.join(packageRoot, file))}  ${file}`);
    if (local) {
        for (const image of catalog.images) {
            files.push(`${image.sha256}  cache/engine-images/${image.archive}`);
        }
    }
    fs.writeFileSync(path.join(packageRoot, 'SHA256SUMS'), `${files.join('\n')}\n`);

    const zip = path.join(outputRoot, `${packageName}.zip`);
    createZip(packageRoot, zip);
    console.log(`Headless server package: ${zip}`);
}

if (require.main === module) {
    main();
}

module.exports = { headlessCompose };
