import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    artifactName,
    fileDigest,
    MAC_SIGNATURE_REVISION,
    playerTarget,
    targetConfiguration,
    targets,
    validateManifest,
    verifyArtifact,
    verifyExecutableHeader,
} from './release-contract.mts';
import { createOssClient, ossConfiguration } from './oss-client.mts';
import { cachedInstaller, manifestFromHead, manifestMetadata } from './release-cache.mts';
import { builderEnvironment, macSigningArguments } from './signing-environment.mts';
import { playerBuildContext } from './build-context.mts';

import type { ArtifactManifest, PlayerTarget } from './release-contract.mts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(appRoot, '../..');
const require = createRequire(import.meta.url);
const packageInfo = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const { packagingContext } = require('../../../scripts/packaging-context.js');
const local = packagingContext(process.env, packageInfo.version, 'PLAYER_BUILD_CHANNEL');
const { channel, info, prefix } =
    process.argv[2] === 'build' && local.channel === 'dev'
        ? {
              channel: 'dev',
              info: {
                  version: local.version,
                  tag: `player-v${local.version}`,
                  commit: process.env.PLAYER_RELEASE_COMMIT || process.env.GITHUB_SHA || 'unknown',
                  prerelease: true,
              },
              prefix: '',
          }
        : playerBuildContext(process.env, packageInfo.version);
const outputDirectory = path.join(appRoot, 'release-electron');

async function output(values:Record<string, string>):Promise<void> {
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(
            process.env.GITHUB_OUTPUT,
            Object.entries(values)
                .map(([key, value]) => `${key}=${value}\n`)
                .join(''),
        );
    }
}

async function run(command:string, args:string[], env = process.env):Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: appRoot,
            stdio: 'inherit',
            env,
            windowsHide: true,
        });
        child.on('error', reject);
        child.on('exit', (code, signal) =>
            code === 0
                ? resolve()
                : reject(
                      new Error(
                          `Release command failed: ${path.basename(command)} (${code ?? signal})`,
                      ),
                  ),
        );
    });
}

async function packagedBinaryHeader(file:string):Promise<Buffer> {
    const handle = await open(file, 'r');
    try {
        const header = Buffer.alloc(65536);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        return header.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function verifyMacDmg(file:string, product:string):Promise<void> {
    await run('hdiutil', ['verify', file]);
    const mountPoint = await mkdtemp(path.join(tmpdir(), 'box-player-dmg-verify-'));
    let mounted = false;
    try {
        await run('hdiutil', [
            'attach',
            '-readonly',
            '-nobrowse',
            '-noautoopen',
            '-mountpoint',
            mountPoint,
            file,
        ]);
        mounted = true;
        await run('codesign', [
            '--verify',
            '--deep',
            '--strict',
            '--verbose=2',
            path.join(mountPoint, `${product}.app`),
        ]);
    } finally {
        if (mounted) {
            await run('hdiutil', ['detach', mountPoint]);
        }
        // Only remove an empty mount directory; never recursively delete a mounted volume.
        await rmdir(mountPoint).catch(() => undefined);
    }
}

async function build(target:PlayerTarget):Promise<void> {
    const windows = target.startsWith('windows-');
    const mac = target.startsWith('macos-');
    const { architecture, platform, builderFlag, directory } = targetConfiguration(target);
    if (process.platform !== platform || process.arch !== architecture) {
        throw new Error(`${target} must be built/tested on its native OS and architecture`);
    }
    const filename = artifactName(info, target);
    const args = [
        require.resolve('electron-builder/cli.js'),
        builderFlag,
        `--${architecture}`,
        '--publish',
        'never',
        `--config.artifactName=${filename}`,
        `--config.extraMetadata.version=${info.version}`,
    ];
    const signingEnv = builderEnvironment(process.env);
    if (channel !== 'production') {
        args.push(`--config.appId=com.box.player.launcher.${channel}`);
    }
    if (mac) {
        args.push(...macSigningArguments(signingEnv));
    }
    if (windows) {
        args.push(`--config.nsis.artifactName=${filename}`);
    }
    if (process.env.PLAYER_ELECTRON_DIST) {
        args.push(`--config.electronDist=${path.resolve(process.env.PLAYER_ELECTRON_DIST)}`);
    }
    await run(process.execPath, args, signingEnv);
    const product = packageInfo.build.productName;
    const application = mac
        ? path.join(outputDirectory, directory, `${product}.app`, 'Contents')
        : path.join(outputDirectory, directory);
    const binary = windows
        ? path.join(application, `${product}.exe`)
        : mac
          ? path.join(application, 'MacOS', product)
          : path.join(application, packageInfo.build.linux.executableName);
    verifyExecutableHeader(await packagedBinaryHeader(binary), target);
    if (mac) {
        await run('codesign', [
            '--verify',
            '--deep',
            '--strict',
            '--verbose=2',
            path.dirname(application),
        ]);
        // Execute the packaged Mach-O without loading the player's real profile.
        await run(
            binary,
            ['-e', "console.log('Packaged macOS runtime executable verified: ' + process.arch)"],
            { ...signingEnv, ELECTRON_RUN_AS_NODE: '1' },
        );
        await verifyMacDmg(path.join(outputDirectory, filename), product);
    }
    const resources = path.join(application, mac ? 'Resources' : 'resources', 'app.asar');
    // The test harness was built by test:desktop before packaging. It stays out of app.asar.
    await run(
        process.execPath,
        ['--experimental-strip-types', path.join(appRoot, 'scripts/run-smoke.mts'), 'desktop'],
        {
            ...process.env,
            BOX_LAUNCHER_SMOKE_ROOT: resources,
        },
    );
    const manifest:ArtifactManifest = {
        formatVersion: 1,
        ...info,
        target,
        file: filename,
        ...(mac ? { macSignatureRevision: MAC_SIGNATURE_REVISION } : {}),
        ...(await fileDigest(path.join(outputDirectory, filename))),
    };
    await writeFile(
        path.join(outputDirectory, `${filename}.sha256`),
        `${manifest.sha256}  ${filename}\n`,
    );
    await writeFile(
        path.join(outputDirectory, `${filename}.build.json`),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(`Verified ${target}: ${filename}, SHA256 ${manifest.sha256}`);
}

async function withOss(
    action:(client:Awaited<ReturnType<typeof createOssClient>>) => Promise<void>,
):Promise<void> {
    if (channel === 'dev') {
        throw new Error('Development installers cannot access release storage');
    }
    const client = await createOssClient(ossConfiguration(process.env), undefined, `${prefix}/`);
    try {
        await action(client);
    } finally {
        await client.close();
    }
}

async function probe(target:PlayerTarget):Promise<void> {
    await withOss(async (oss) => {
        const filename = artifactName(info, target);
        const hit = await cachedInstaller(oss, info, target, prefix);
        await output({ 'cache-hit': String(hit) });
        console.log(
            hit
                ? `Reusing OSS installer: ${filename}`
                : `Installer missing; build required: ${filename}`,
        );
    });
}

async function upload(target:PlayerTarget):Promise<void> {
    const filename = artifactName(info, target);
    const manifestPath = path.join(outputDirectory, `${filename}.build.json`);
    const manifest = validateManifest(
        JSON.parse(await readFile(manifestPath, 'utf8')),
        info,
        target,
    );
    console.log(
        `Checking installer SHA256 before upload: ${filename} (${(manifest.size / 1024 / 1024).toFixed(1)} MiB)`,
    );
    await verifyArtifact(path.join(outputDirectory, filename), manifest);
    await withOss(async (oss) => {
        await oss.upload(
            `${prefix}/${filename}`,
            path.join(outputDirectory, filename),
            'application/octet-stream',
            manifestMetadata(manifest),
        );
        const head = await oss.head(`${prefix}/${filename}`);
        if (!head) {
            throw new Error(`Uploaded installer is not visible in OSS: ${filename}`);
        }
        const uploaded = manifestFromHead(head, info, target);
        if (
            !uploaded ||
            uploaded.sha256 !== manifest.sha256 ||
            head.ContentLength !== manifest.size
        ) {
            throw new Error(`OSS upload verification failed: ${filename}`);
        }
    });
    console.log(`Uploaded verified player installer: ${filename} (${prefix})`);
}

async function downloadAll():Promise<void> {
    const directory = path.join(repositoryRoot, 'player-release-files');
    await mkdir(directory, { recursive: true });
    const manifests:ArtifactManifest[] = [];
    await withOss(async (oss) => {
        for (const target of targets) {
            const filename = artifactName(info, target);
            const manifestPath = path.join(directory, `${filename}.build.json`);
            const head = await oss.head(`${prefix}/${filename}`);
            if (!head) {
                throw new Error(`Missing required OSS installer: ${filename}`);
            }
            if (
                target === 'macos-arm64' &&
                head.Metadata?.['player-mac-signature-revision'] !== String(MAC_SIGNATURE_REVISION)
            ) {
                throw new Error(
                    'Cached macOS installer predates the signature fix; rebuild macOS before publishing',
                );
            }
            const expected = manifestFromHead(head, info, target);
            await oss.download(`${prefix}/${filename}`, path.join(directory, filename));
            const actual = await fileDigest(path.join(directory, filename));
            const manifest:ArtifactManifest = expected || {
                formatVersion: 1,
                ...info,
                target,
                file: filename,
                ...actual,
            };
            if (expected) {
                await verifyArtifact(path.join(directory, filename), expected);
            } else if (head.ContentLength !== actual.size) {
                throw new Error(`Incomplete OSS installer download: ${filename}`);
            }
            await writeFile(
                manifestPath,
                `${JSON.stringify({ ...manifest, commit: expected?.commit ?? null, source: expected ? 'oss-object-metadata' : 'legacy-oss-object' }, null, 2)}\n`,
            );
            await writeFile(
                path.join(directory, `${filename}.sha256`),
                `${manifest.sha256}  ${filename}\n`,
            );
            manifests.push(manifest);
        }
        const sums = path.join(directory, 'SHA256SUMS.txt');
        await writeFile(sums, manifests.map((item) => `${item.sha256}  ${item.file}\n`).join(''));
        const notes = path.join(directory, 'release-notes.md');
        await writeFile(
            notes,
            `BOX3 玩家启动器 ${info.version}\n\n支持服务器登录、地图浏览、收藏和最近游玩，以及本机地图资源缓存管理。\n\n| 系统 | 安装包 |\n| --- | --- |\n${manifests.map((item) => `| ${item.target} | \`${item.file}\` |`).join('\n')}\n\n校验文件：\`SHA256SUMS.txt\`\n\n发布提交：\`${info.commit}\`\n`,
        );
    });
    console.log(`Collected and verified all player installers in ${directory}`);
}

const [command, targetValue] = process.argv.slice(2);
if (command === 'validate') {
    ossConfiguration(process.env);
    await output({ version: info.version, prerelease: String(info.prerelease), tag: info.tag });
    console.log(
        channel === 'staging'
            ? `Player staging build validated: ${info.version} (${prefix})`
            : `Independent player release validated: ${info.tag}`,
    );
} else if (command === 'probe') {
    await probe(playerTarget(targetValue || ''));
} else if (command === 'build') {
    await build(playerTarget(targetValue || ''));
} else if (command === 'upload') {
    await upload(playerTarget(targetValue || ''));
} else if (command === 'download') {
    await downloadAll();
} else {
    throw new Error(
        'Usage: release.mts validate | probe <target> | build <target> | upload <target> | download',
    );
}
