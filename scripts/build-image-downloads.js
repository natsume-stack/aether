'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const services = [
    'creator',
    'voxa',
    'play',
    'player-service',
    'player-auth-portal',
    'server-manager',
];

// ---------------------------------------------------------------------------
// Image download source policy.
//
// Default behaviour is unchanged: only the official production base and the
// CI-pinned staging base are accepted, so a catalog that nobody looked at
// cannot be redirected off the published CDN.
//
// A private, self-hosted mirror is accepted only when the operator opts in
// explicitly *and* pins the exact URL, which keeps the widening auditable:
//
//   BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE=1              (must be exactly "1")
//   BOX3_RELEASE_CDN_URL_ALLOWLIST=<url>[,<url>…]  (exact match, no wildcard)
//
// On top of that gate a custom base still has to pass validCustomDownloadBase():
// HTTPS for any routable host, cleartext HTTP only for loopback / RFC1918 /
// link-local address literals. Credentials, query strings, fragments, ".."
// path segments, backslashes, control characters and non-HTTP(S) schemes are
// rejected even when the opt-in is set.
// ---------------------------------------------------------------------------

const OFFICIAL_DOWNLOAD_BASE = 'https://assets.box3.fun/local-engine';
const STAGING_DOWNLOAD_BASE_PATTERN =
    /^https:\/\/assets\.box3\.fun\/local-engine-staging\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(?:[0-9A-Za-z.-]*[.-])?staging\/[a-f0-9]{40}$/;

function isLocalHostLiteral(host) {
    if (host === 'localhost' || host === '[::1]' || host === '[::ffff:127.0.0.1]') {
        return true;
    }
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!octets) {
        return false;
    }
    // Reject zero-padded octets so that curl cannot reinterpret the literal
    // (octal/hex forms and short IPv4 shorthand never reach this point).
    if (octets.slice(1).some((octet) => octet.length > 1 && octet.startsWith('0'))) {
        return false;
    }
    const [first, second] = octets.slice(1).map(Number);
    if ([...octets.slice(1)].some((octet) => Number(octet) > 255)) {
        return false;
    }
    return (
        first === 10 ||
        first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
    );
}

function downloadBaseShape(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
        return null;
    }
    if (/[\s\p{C}]/u.test(value) || value.includes('..') || /[?#@\\]/.test(value)) {
        return null;
    }
    const match = /^(https?):\/\/([^/]+)((?:\/[A-Za-z0-9._~-]*)*)$/i.exec(value);
    if (!match) {
        return null;
    }
    const hostAndPort = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::(\d{1,5}))?$/.exec(
        match[2],
    );
    if (!hostAndPort) {
        return null;
    }
    const port = hostAndPort[6];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
        return null;
    }
    return {scheme: match[1].toLowerCase(), host: hostAndPort[1]};
}

function downloadBaseAllowlist(env) {
    return String(env.BOX3_RELEASE_CDN_URL_ALLOWLIST || '')
        .split(/[,;\s]+/)
        .map((entry) => entry.replace(/\/+$/, ''))
        .filter((entry) => entry.length > 0);
}

function validCustomDownloadBase(value, env) {
    const shape = downloadBaseShape(value);
    if (!shape) {
        return false;
    }
    if (shape.scheme === 'http' && !isLocalHostLiteral(shape.host)) {
        return false;
    }
    return downloadBaseAllowlist(env).includes(String(value).replace(/\/+$/, ''));
}

function validDownloadBase(value, env = process.env) {
    if (value === undefined || value === null) {
        return true;
    }
    if (value === OFFICIAL_DOWNLOAD_BASE || STAGING_DOWNLOAD_BASE_PATTERN.test(value)) {
        return true;
    }
    return (
        env.BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE === '1' && validCustomDownloadBase(value, env)
    );
}

function downloadBasePolicy(env = process.env) {
    return env.BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE === '1'
        ? `official bases + ${downloadBaseAllowlist(env).length} pinned self-hosted mirror(s)`
        : 'official bases only';
}

function validateCatalog(catalog, architecture, env = process.env) {
    if (
        !['amd64', 'arm64'].includes(architecture) ||
        catalog.formatVersion !== 2 ||
        catalog.platform !== `linux/${architecture}` ||
        !catalog.imageTag ||
        !Array.isArray(catalog.images) ||
        catalog.images.length !== services.length
    ) {
        throw new Error('Invalid per-service image catalog');
    }
    for (const service of services) {
        const images = catalog.images.filter(
            (image) => image.image === `box-local-engine-${service}`,
        );
        if (images.length !== 1) {
            throw new Error(`Missing or duplicate image: ${service}`);
        }
        const image = images[0];
        const digest = /^sha256:([a-f0-9]{64})$/.exec(image.imageId || '')?.[1];
        if (
            !digest ||
            !Array.isArray(image.imageIds) ||
            image.imageIds.length < 1 ||
            image.imageIds.length > 2 ||
            !image.imageIds.includes(image.imageId) ||
            image.imageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)) ||
            image.formatVersion !== 1 ||
            image.platform !== catalog.platform ||
            !image.imageTag ||
            image.archive !==
                `box-local-engine-image-${service}-${architecture}-${image.sha256}.tar.gz` ||
            !/^[a-f0-9]{64}$/.test(image.sha256 || '') ||
            !Number.isSafeInteger(image.size) ||
            image.size <= 0 ||
            !validDownloadBase(image.downloadBaseUrl, env)
        ) {
            throw new Error(`Invalid image download: ${service}`);
        }
    }
    return catalog;
}

function localImageTag(catalog) {
    const tags = new Set(catalog.images.map((image) => image.imageTag));
    if (tags.size !== 1) {
        throw new Error('本地测试镜像必须使用同一版本标签');
    }
    const tag = [...tags][0];
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
        throw new Error('本地镜像标签无效');
    }
    return tag;
}

function splitArchive(archive, architecture, destination) {
    const { packagingContext } = require('./packaging-context');
    const { channel, version } = packagingContext(process.env, require('../package.json').version);
    const result = spawnSync(
        process.platform === 'win32' ? 'python' : 'python3',
        [
            path.join(__dirname, 'split-image-archive.py'),
            archive,
            architecture,
            destination,
            version,
        ],
        { stdio: 'inherit' },
    );
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || 'Unable to split source image archive');
    }
    const catalog = validateCatalog(JSON.parse(fs.readFileSync(destination, 'utf8')), architecture);
    if (
        channel === 'dev' &&
        catalog.images.every((image) => image.imageTag === `v${version}-linux-${architecture}`)
    ) {
        catalog.channel = 'dev';
        catalog.version = version;
        fs.writeFileSync(destination, `${JSON.stringify(catalog, null, 2)}\n`);
    }
    return catalog;
}

function validateDevCatalog(catalog, version, architecture) {
    validateCatalog(catalog, architecture);
    const tag = `v${version}-linux-${architecture}`;
    if (
        catalog.channel === 'staging' ||
        catalog.imageTag !== tag ||
        !catalog.images.every((image) => image.imageTag === tag && !image.downloadBaseUrl)
    ) {
        throw new Error('开发包需要同版本的 dev 镜像归档，不能使用正式或 staging 镜像');
    }
    return catalog;
}

if (require.main === module) {
    try {
        const [archive, architecture, destination] = process.argv.slice(2);
        if (!archive || !['amd64', 'arm64'].includes(architecture) || !destination) {
            throw new Error(
                'Usage: node scripts/build-image-downloads.js <source.tar.gz> <amd64|arm64> <catalog.json>',
            );
        }
        splitArchive(archive, architecture, destination);
        if (process.env.BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE === '1') {
            console.error(
                `[build-image-downloads] self-hosted download bases ENABLED (${downloadBasePolicy()}); official CDN still preferred`,
            );
        }
        console.log(`Per-service image catalog: ${destination}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    splitArchive,
    validateCatalog,
    validateDevCatalog,
    localImageTag,
    validDownloadBase,
    validCustomDownloadBase,
    downloadBasePolicy,
    OFFICIAL_DOWNLOAD_BASE,
};
