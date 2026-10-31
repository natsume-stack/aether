'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packagingContext } = require('./packaging-context');
const { generateDistributionMetadata } = require('../apps/local-engine/src/distribution-metadata');

const repoRoot = path.resolve(__dirname, '..');
const managerRoot = path.join(repoRoot, 'apps/deployment-manager');
const outputRoot = path.join(repoRoot, 'apps/local-engine/dist/desktop-installers');
const supported = new Map([
    [
        'windows-amd64',
        { os: 'win32', arch: 'x64', bundle: false, executable: 'box-local-engine-manager.exe' },
    ],
    [
        'windows-arm64',
        { os: 'win32', arch: 'arm64', bundle: false, executable: 'box-local-engine-manager.exe' },
    ],
    [
        'macos-amd64',
        { os: 'darwin', arch: 'x64', bundle: 'app', executable: 'BOX3 Engine Launcher.app' },
    ],
    [
        'macos-arm64',
        { os: 'darwin', arch: 'arm64', bundle: 'app', executable: 'BOX3 Engine Launcher.app' },
    ],
    [
        'linux-amd64',
        { os: 'linux', arch: 'x64', bundle: false, executable: 'box-local-engine-manager' },
    ],
    [
        'linux-arm64',
        { os: 'linux', arch: 'arm64', bundle: false, executable: 'box-local-engine-manager' },
    ],
]);

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

function validateDesktopCatalog(catalog, version, architecture, channel = 'production') {
    const { validateCatalog, validateDevCatalog } = require('./build-image-downloads');
    validateCatalog(catalog, architecture);
    if (channel === 'dev') {
        return validateDevCatalog(catalog, version, architecture);
    }
    if (channel === 'staging') {
        if (version !== catalog.version) {
            throw new Error('Prepare the staging application version before packaging');
        }
        return require('./staging-build-context').validateStagingCatalog(
            catalog,
            version,
            architecture,
        );
    }
    if (
        channel !== 'production' ||
        ['dev', 'staging'].includes(catalog.channel) ||
        catalog.images.some((image) => /(?:-|\.)dev-linux-/.test(image.imageTag)) ||
        catalog.images.some((image) => image.downloadBaseUrl?.includes('/local-engine-staging/'))
    ) {
        throw new Error(
            'Staging catalogs require BOX_BUILD_CHANNEL=staging; production sources must stay isolated',
        );
    }
    return catalog;
}

function gitOutput(args) {
    const result = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 ? result.stdout.trim() : '';
}

function prepareReleaseMetadata() {
    const dirty = gitOutput(['status', '--porcelain']);
    const versionFiles = new Set([
        'package.json',
        'apps/deployment-manager/package.json',
        'apps/local-engine/package.json',
        'apps/player-admin/package.json',
        'apps/player-auth-portal/package.json',
        'apps/server-manager/package.json',
        'apps/deployment-manager/src-tauri/tauri.conf.json',
        'apps/deployment-manager/src-tauri/Cargo.toml',
        'apps/manager-core/Cargo.toml',
        'apps/server-manager-rust/Cargo.toml',
        'apps/deployment-manager/src-tauri/Cargo.lock',
        'apps/manager-core/Cargo.lock',
        'apps/server-manager-rust/Cargo.lock',
        'apps/player-auth-portal/package-lock.json',
        'docker-compose.yml',
        'distribution/play/compose.yml',
    ]);
    // Preparing a versioned release changes only these metadata files in CI.
    const preparedVersion =
        process.env.GITHUB_ACTIONS === 'true' &&
        process.env.BOX_BUILD_CHANNEL === 'production' &&
        !gitOutput(['ls-files', '--others', '--exclude-standard']) &&
        gitOutput(['diff', '--name-only', 'HEAD'])
            .split('\n')
            .filter(Boolean)
            .every((file) => versionFiles.has(file));
    if (dirty && !preparedVersion && process.env.BOX_ALLOW_DIRTY_RELEASE !== 'true') {
        fail(
            '工作区存在未提交修改。请提交后再构建正式启动器；仅测试时可设置 BOX_ALLOW_DIRTY_RELEASE=true。',
        );
    }
    if (dirty && !preparedVersion) {
        console.warn('WARNING: 正在构建带未提交修改的测试包，禁止用于公开发布。');
    }
    process.env.BOX_BUILD_COMMIT ||= gitOutput(['rev-parse', 'HEAD']) || 'unknown';
    process.env.BOX_BUILD_DATE ||= new Date().toISOString();
    process.env.BOX_BUILD_SOURCE ||= dirty ? 'local-dirty' : 'release';
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

function copyDirectory(source, destination) {
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function macApplicationHasResourceSeal(application) {
    return fs.existsSync(path.join(application, 'Contents', '_CodeSignature', 'CodeResources'));
}

function ensureMacApplicationSignature(application) {
    if (process.platform !== 'darwin' || macApplicationHasResourceSeal(application)) {
        return;
    }
    // Tauri's unsigned CI bundle contains a linker ad-hoc signature on the
    // executable but no outer app resource seal. Gatekeeper reports that shape
    // as a damaged application once resources are embedded. Sign the
    // finished bundle ad-hoc to seal every resource. A Developer ID-signed app
    // already has CodeResources, so this never replaces a release signature.
    const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', application], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || '').trim();
        fail(`无法为 macOS APP 写入资源签名${detail ? `：${detail}` : ''}`);
    }
}

function zipEntries(packageRoot) {
    const entries = [];
    const visit = (directory, relative) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            const name = `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                visit(file, name);
            } else if (entry.isFile()) {
                entries.push({ file, name });
            }
        }
    };
    visit(packageRoot, path.basename(packageRoot));
    return entries;
}

function createZip(packageRoot, destination) {
    fs.rmSync(destination, { force: true });
    const parent = path.dirname(packageRoot);
    const name = path.basename(packageRoot);
    const staging =
        process.platform === 'win32'
            ? fs.mkdtempSync(path.join(os.tmpdir(), 'box-zip-entries-'))
            : null;
    const manifest = staging ? path.join(staging, 'entries.json') : null;
    if (manifest) {
        fs.writeFileSync(manifest, JSON.stringify(zipEntries(packageRoot)), { mode: 0o600 });
    }
    const command =
        process.platform === 'win32'
            ? 'powershell'
            : process.platform === 'darwin'
              ? '/usr/bin/ditto'
              : 'zip';
    const args =
        process.platform === 'win32'
            ? [
                  '-NoProfile',
                  '-Command',
                  // Compress-Archive writes backslash entry names on Windows.
                  // Standard ZIP separators also work with already-installed
                  // launchers whose updater rejects backslashes entirely.
                  [
                      "$ErrorActionPreference='Stop'",
                      'Add-Type -AssemblyName System.IO.Compression',
                      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
                      `$archive=[System.IO.Compression.ZipFile]::Open('${destination.replaceAll("'", "''")}',[System.IO.Compression.ZipArchiveMode]::Create)`,
                      // Node supplies exact relative entry names. PowerShell may
                      // expand 8.3 temp paths, so its FullName cannot safely be
                      // sliced using a path length calculated by Node.
                      `try { $entries=ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText('${manifest?.replaceAll("'", "''")}')); $entries | ForEach-Object {`,
                      '[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$_.file,$_.name,[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null',
                      '} } finally { $archive.Dispose() }',
                  ].join('; '),
              ]
            : process.platform === 'darwin'
              ? ['-c', '-k', '--norsrc', '--keepParent', name, destination]
              : ['-rq', destination, name];
    let result;
    try {
        result = spawnSync(command, args, {
            cwd: parent,
            env: { ...process.env, COPYFILE_DISABLE: '1' },
            stdio: 'inherit',
        });
    } finally {
        if (staging) {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
    if (result.status !== 0) {
        fail(`ZIP 打包失败，退出码 ${result.status}`);
    }
}

function archiveEntry(archive, entry, run = spawnSync, platform = process.platform) {
    // Windows ships bsdtar, which does not consistently infer gzip compression
    // when extracting one entry. Explicit gzip extraction works with both
    // bsdtar and GNU tar, including the Windows desktop release runners.
    const tarArguments = [
        ...(platform === 'win32' ? ['--force-local'] : []),
        '-xzf',
        archive,
        '-O',
        entry,
    ];
    const result = run('tar', tarArguments, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        const detail = String(result.stderr || result.error?.message || '').trim();
        throw new Error(`无法从离线镜像归档读取 ${entry}${detail ? `：${detail}` : ''}`);
    }
    return result.stdout;
}

function imageDetailsFromArchive(archive) {
    const manifest = JSON.parse(archiveEntry(archive, 'manifest.json'));
    return manifest.flatMap((entry) => {
        const image = entry.RepoTags?.[0];
        const configPath = entry.Config;
        if (!image || !configPath) {
            return [];
        }
        const configContents = archiveEntry(archive, configPath);
        const config = JSON.parse(configContents);
        const separator = image.lastIndexOf(':');
        const imageName = separator > 0 ? image.slice(0, separator) : image;
        const tag = separator > 0 ? image.slice(separator + 1) : 'unknown';
        const labels = config.config?.Labels || {};
        const configDigest = crypto.createHash('sha256').update(configContents).digest('hex');
        return [
            {
                image: imageName,
                tag,
                imageId: configDigest ? `sha256:${configDigest}` : 'unknown',
                createdAt: config.created || 'unknown',
                platform:
                    config.os && config.architecture
                        ? `${config.os}/${config.architecture}`
                        : 'unknown',
                sourceRevision: labels['org.opencontainers.image.revision'] || 'unknown',
                buildSource: labels['org.opencontainers.image.source'] || 'unknown',
            },
        ];
    });
}

function tauriBuildCommand(platform = process.platform) {
    return platform === 'win32'
        ? { command: path.join(managerRoot, 'node_modules/.bin/tauri.cmd'), shell: true }
        : { command: path.join(managerRoot, 'node_modules/.bin/tauri'), shell: false };
}

function tauriBuildEnvironment(
    baseEnvironment = process.env,
    paths = { repository: repoRoot, home: os.homedir() },
) {
    const environment = { ...baseEnvironment };
    const remapFlags = [
        `--remap-path-prefix=${paths.repository}=/workspace`,
        `--remap-path-prefix=${paths.home}=/build-home`,
    ];
    if (environment.CARGO_ENCODED_RUSTFLAGS) {
        environment.CARGO_ENCODED_RUSTFLAGS = [
            environment.CARGO_ENCODED_RUSTFLAGS,
            ...remapFlags,
        ].join('\x1f');
    } else if (environment.RUSTFLAGS) {
        environment.RUSTFLAGS = `${environment.RUSTFLAGS} ${remapFlags.join(' ')}`;
    } else {
        environment.CARGO_ENCODED_RUSTFLAGS = remapFlags.join('\x1f');
    }
    return environment;
}

function tauriBuildFailure(result) {
    if (result.error) {
        const code = result.error.code ? `${result.error.code}: ` : '';
        return `无法启动 Tauri 构建命令：${code}${result.error.message}`;
    }
    if (result.signal) {
        return `Tauri 构建被系统信号终止：${result.signal}`;
    }
    return `Tauri 构建失败，退出码 ${result.status}`;
}

function main() {
    const { channel, version } = packagingContext(
        process.env,
        require(path.join(managerRoot, 'package.json')).version,
    );
    const local = process.argv.includes('--local') || channel === 'dev';
    process.env.BOX_BUILD_CHANNEL = channel;
    process.env.BOX_BUILD_VERSION = version;
    if (local) {
        process.env.BOX_ALLOW_DIRTY_RELEASE = 'true';
    }
    prepareReleaseMetadata();
    const platform = process.argv[2];
    const archive = process.argv[3] ? path.resolve(process.argv[3]) : '';
    const spec = supported.get(platform);
    if (!spec) {
        fail(
            `用法: rush package-desktop --target <${[...supported.keys()].join('|')}> --archive <镜像归档.tar.gz>`,
        );
    }
    if (process.platform !== spec.os || process.arch !== spec.arch) {
        fail(`${platform} 原生安装器必须在对应的 ${spec.os}/${spec.arch} 构建机上生成`);
    }
    if (!archive || !fs.statSync(archive, { throwIfNoEntry: false })?.isFile()) {
        fail('离线镜像归档不存在');
    }
    if (local && archive.endsWith('.json')) {
        fail('本地模式需要完整镜像归档，不能仅提供清单');
    }
    const expectedArchitecture = platform.endsWith('arm64') ? 'arm64' : 'amd64';
    const catalogPath = archive.endsWith('.json')
        ? archive
        : path.join(
              path.dirname(archive),
              `box-local-engine-images-v${version}-linux-${expectedArchitecture}.json`,
          );
    const staleCatalog =
        !archive.endsWith('.json') &&
        fs.existsSync(catalogPath) &&
        JSON.parse(fs.readFileSync(catalogPath, 'utf8')).sourceArchiveSha256 !== sha256(archive);
    if (!fs.existsSync(catalogPath) || staleCatalog) {
        const result = spawnSync(
            process.execPath,
            [
                path.join(repoRoot, 'scripts/build-image-downloads.js'),
                archive,
                expectedArchitecture,
                catalogPath,
            ],
            { stdio: 'inherit' },
        );
        if (result.status !== 0) {
            fail('无法生成独立服务镜像包');
        }
    }
    const { localImageTag } = require('./build-image-downloads');
    const imageManifest = validateDesktopCatalog(
        JSON.parse(fs.readFileSync(catalogPath, 'utf8')),
        version,
        expectedArchitecture,
        channel,
    );
    const imageDetails = imageManifest.images;
    const imageTag = local ? localImageTag(imageManifest) : imageManifest.imageTag;
    if (local) {
        imageManifest.imageTag = imageTag;
    }
    const payloadImageInfo = path.join(managerRoot, 'src-tauri/payload/IMAGE-INFO.json');
    const payloadMetadata = path.join(managerRoot, 'src-tauri/payload/metadata');
    const originalImageInfo = fs.readFileSync(payloadImageInfo, 'utf8');
    const imageInfo = {
        formatVersion: 1,
        images: imageDetails,
    };
    for (const name of fs.readdirSync(path.dirname(payloadImageInfo))) {
        if (/\.tar(?:\.gz)?$/.test(name) || name === 'BOX-OFFLINE-IMAGE.json') {
            fail(`轻量启动器资源目录中存在离线归档，请移走后重试：${name}`);
        }
    }
    const packageMode = {
        mode: local ? 'local' : 'slim',
        ...(channel !== 'production' ? { channel } : {}),
        imageTag,
        platform: imageManifest.platform,
    };
    const offline = local
        ? {
              formatVersion: 1,
              archive: `box-local-engine-images-local-linux-${expectedArchitecture}${archive.endsWith('.gz') ? '.tar.gz' : '.tar'}`,
              imageTag,
              platform: imageManifest.platform,
              sha256: sha256(archive),
          }
        : null;
    if (local && spec.bundle) {
        fs.copyFileSync(archive, path.join(path.dirname(payloadImageInfo), offline.archive));
        fs.writeFileSync(
            path.join(path.dirname(payloadImageInfo), 'BOX-OFFLINE-IMAGE.json'),
            JSON.stringify(offline, null, 2) + '\n',
        );
    }
    // Metadata and local test images must be embedded before signing.
    if (spec.bundle) {
        // Tauri signs the complete .app bundle. Metadata must become a resource
        // before that step; writing it into Contents/Resources afterwards makes
        // macOS report the application as damaged.
        fs.rmSync(payloadMetadata, { recursive: true, force: true });
        fs.mkdirSync(payloadMetadata, { recursive: true });
        fs.writeFileSync(
            path.join(payloadMetadata, 'BOX-PACKAGE-MODE.json'),
            JSON.stringify(packageMode, null, 2) + '\n',
        );
        if (!local) {
            fs.writeFileSync(
                path.join(payloadMetadata, 'BOX-REMOTE-IMAGE.json'),
                `${JSON.stringify(imageManifest, null, 2)}\n`,
            );
        }
        generateDistributionMetadata(payloadMetadata, {
            repoRoot,
            generatedAt: new Date().toISOString(),
            release: `desktop-${platform}`,
            platform: `${spec.os}/${spec.arch}`,
            images: [`${path.basename(archive)} (${imageTag})`],
        });
    }
    fs.writeFileSync(payloadImageInfo, `${JSON.stringify(imageInfo, null, 2)}\n`);
    let channelConfiguration;
    try {
        const tauriArgs = ['build'];
        if (channel !== 'production') {
            // A relative file avoids Windows cmd consuming inline JSON quotes
            // or splitting a checkout path that contains spaces.
            channelConfiguration = fs.mkdtempSync(path.join(managerRoot, `src-tauri/.${channel}-`));
            const configurationFile = path.join(channelConfiguration, 'config.json');
            fs.writeFileSync(
                configurationFile,
                JSON.stringify({ version, identifier: `com.box.engine.manager.${channel}` }),
            );
            tauriArgs.push('--config', path.relative(managerRoot, configurationFile));
        }
        if (spec.bundle) {
            tauriArgs.push('--bundles', spec.bundle);
        } else {
            tauriArgs.push('--no-bundle');
        }
        const invocation = tauriBuildCommand();
        const result = spawnSync(invocation.command, tauriArgs, {
            cwd: managerRoot,
            env: tauriBuildEnvironment({
                ...process.env,
                BOX_MANAGER_IMAGE_TAG: imageTag,
                BOX_MANAGER_REMOTE_IMAGE: local ? undefined : JSON.stringify(imageManifest),
            }),
            shell: invocation.shell,
            stdio: 'inherit',
        });
        if (result.error || result.status !== 0) {
            throw new Error(tauriBuildFailure(result));
        }
    } finally {
        if (channelConfiguration) {
            fs.rmSync(channelConfiguration, { recursive: true, force: true });
        }
        fs.writeFileSync(payloadImageInfo, originalImageInfo);
        if (local && spec.bundle) {
            fs.rmSync(path.join(path.dirname(payloadImageInfo), offline.archive));
            fs.rmSync(path.join(path.dirname(payloadImageInfo), 'BOX-OFFLINE-IMAGE.json'));
        }
        if (spec.bundle) {
            fs.rmSync(payloadMetadata, { recursive: true, force: true });
        }
    }

    const targetRoot = path.join(managerRoot, 'src-tauri/target/release');
    const executableSource = spec.bundle
        ? path.join(targetRoot, 'bundle/macos', spec.executable)
        : path.join(targetRoot, spec.executable);
    if (!fs.statSync(executableSource, { throwIfNoEntry: false })) {
        fail(`未找到原生程序产物：${executableSource}`);
    }

    fs.mkdirSync(outputRoot, { recursive: true });
    const packageName = `BOX-Local-Engine-${version}-${platform}${local ? '-local' : ''}`;
    const packageRoot = path.join(outputRoot, packageName);
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    const executableDestination = path.join(packageRoot, spec.executable);
    if (spec.bundle) {
        copyDirectory(executableSource, executableDestination);
    } else {
        fs.copyFileSync(executableSource, executableDestination);
    }
    if (spec.bundle) {
        ensureMacApplicationSignature(executableDestination);
    }
    // Keep the macOS download folder intentionally simple: users only see the
    // APP. Its metadata was embedded before signing; Windows keeps metadata
    // beside the EXE.
    const metadataRoot = spec.bundle
        ? path.join(executableDestination, 'Contents/Resources/payload/metadata')
        : packageRoot;
    if (!spec.bundle) {
        if (local) {
            fs.copyFileSync(archive, path.join(packageRoot, offline.archive));
            fs.writeFileSync(
                path.join(packageRoot, 'BOX-OFFLINE-IMAGE.json'),
                JSON.stringify(offline, null, 2) + '\n',
            );
        }
        fs.writeFileSync(
            path.join(metadataRoot, 'BOX-PACKAGE-MODE.json'),
            JSON.stringify(packageMode, null, 2) + '\n',
        );
        fs.mkdirSync(metadataRoot, { recursive: true });
        if (!local) {
            fs.writeFileSync(
                path.join(metadataRoot, 'BOX-REMOTE-IMAGE.json'),
                `${JSON.stringify(imageManifest, null, 2)}\n`,
            );
        }
        generateDistributionMetadata(metadataRoot, {
            repoRoot,
            generatedAt: new Date().toISOString(),
            release: `desktop-${platform}`,
            platform: `${spec.os}/${spec.arch}`,
            images: [`${path.basename(archive)} (${imageTag})`],
        });
    }
    const verification = spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts/verify-desktop-offline-package.js'), packageRoot],
        { cwd: repoRoot, env: process.env, stdio: 'inherit' },
    );
    if (verification.status !== 0) {
        fail(`桌面启动器校验失败，退出码 ${verification.status}`);
    }
    const zip = path.join(outputRoot, `${packageName}.zip`);
    // Finder can create this hidden view-state file whenever the output folder
    // is opened. It is not part of the release and must not leak into the ZIP.
    fs.rmSync(path.join(packageRoot, '.DS_Store'), { force: true });
    createZip(packageRoot, zip);
    console.log(`Launcher package: ${zip}`);
    console.log(`SHA-256:        ${sha256(zip)}`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        fail(error.message);
    }
}

module.exports = {
    zipEntries,
    createZip,
    archiveEntry,
    imageDetailsFromArchive,
    tauriBuildCommand,
    tauriBuildEnvironment,
    tauriBuildFailure,
    macApplicationHasResourceSeal,
    ensureMacApplicationSignature,
    validateDesktopCatalog,
};
