'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { productionVersion } = require('./packaging-context');

const root = path.resolve(__dirname, '..');
const versionPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function stagingVersion(version) {
    if (!versionPattern.test(version)) {
        throw new Error('Invalid release version');
    }
    return /(?:-|\.)staging$/.test(version)
        ? version
        : `${version}${version.includes('-') ? '.' : '-'}staging`;
}

// The published CDN stays the default for every channel. A private mirror is
// only used when the operator opts in explicitly with
// BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE=1 plus an exact BOX3_RELEASE_CDN_URL_ALLOWLIST
// entry, and only for production releases: staging catalogs are validated by
// scripts/staging-build-context.js against the pinned CI base, so redirecting
// them would silently break that contract.
function resolveDownloadBaseUrl(channel, prefix, releasePrefix, env) {
    const official = `https://assets.box3.fun/${channel === 'staging' ? prefix : releasePrefix}`;
    if (env.BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE !== '1' || !env.BOX3_RELEASE_CDN_URL) {
        return official;
    }
    if (channel === 'staging') {
        throw new Error('自建发布源只用于正式（production）发行，staging 渠道必须使用 CI 固定的下载地址');
    }
    const mirror = String(env.BOX3_RELEASE_CDN_URL).replace(/\/+$/, '');
    const { validDownloadBase, downloadBasePolicy } = require('./build-image-downloads');
    if (!validDownloadBase(mirror, env)) {
        throw new Error(
            '自建发布源无效：需要 HTTPS（回环/内网地址可用 HTTP），且完整出现在 BOX3_RELEASE_CDN_URL_ALLOWLIST 中',
        );
    }
    if (mirror.includes('local-engine-staging')) {
        throw new Error('自建发布源不能伪装成 staging 渠道');
    }
    process.stderr.write(
        `[release-context] downloadBaseUrl redirected to a pinned self-hosted mirror: ${mirror} (${downloadBasePolicy(env)})\n`,
    );
    return mirror;
}

function engineReleaseContext(env, packageVersion) {
    const channel =
        env.BOX_BUILD_CHANNEL ||
        (env.GITHUB_REF === 'refs/heads/staging' ? 'staging' : 'production');
    if (
        !['production', 'staging'].includes(channel) ||
        (channel === 'staging' && env.GITHUB_REF !== 'refs/heads/staging')
    ) {
        throw new Error('Release channel does not match the staging/versioned release branch');
    }
    if (!versionPattern.test(packageVersion) || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) {
        throw new Error('Release requires a valid version and source commit');
    }
    const version =
        channel === 'staging' ? stagingVersion(packageVersion) : productionVersion(env.GITHUB_REF);
    const releasePrefix = channel === 'staging' ? 'local-engine-staging' : 'local-engine';
    const prefix = `${releasePrefix}/v${version}${channel === 'staging' ? `/${env.GITHUB_SHA}` : ''}`;
    return {
        channel,
        version,
        tag: `v${version}`,
        prefix,
        releasePrefix,
        downloadBaseUrl: resolveDownloadBaseUrl(channel, prefix, releasePrefix, env),
    };
}

function prepareBuildChannel(env = process.env, repository = root) {
    const file = path.join(repository, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const context = engineReleaseContext(env, manifest.version);
    if (context.version !== manifest.version) {
        manifest.version = context.version;
        fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
        const result = spawnSync(
            process.execPath,
            [path.join(repository, 'scripts/sync-root-version.js')],
            {
                cwd: repository,
                stdio: 'inherit',
            },
        );
        if (result.status !== 0) {
            throw new Error('Unable to prepare the channel build version');
        }
    }
    return context;
}

if (require.main === module) {
    try {
        const version = JSON.parse(
            fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
        ).version;
        const context =
            process.argv[2] === 'prepare'
                ? prepareBuildChannel()
                : engineReleaseContext(process.env, version);
        if (process.argv[2] === 'check-notes') {
            require('./build-release-manifest').buildReleaseManifest(
                context.version,
                new Date().toISOString().slice(0, 10),
            );
        }
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(
                process.env.GITHUB_OUTPUT,
                Object.entries(context)
                    .map(([key, value]) => `${key}=${value}\n`)
                    .join(''),
            );
        }
        console.log(JSON.stringify(context));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { stagingVersion, engineReleaseContext, prepareBuildChannel };
