'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { engineReleaseContext, stagingVersion, prepareBuildChannel } = require('./release-context');
const { renderBootstrapInstaller } = require('./render-bootstrap-installer');
const root = path.resolve(__dirname, '..');
const commit = 'a'.repeat(40);

test('channel identities keep production unchanged and pin staging caches to the source commit', () => {
    const production = engineReleaseContext(
        { GITHUB_REF: 'refs/heads/release/v2026.1.4', GITHUB_SHA: commit },
        '2026.1.4',
    );
    assert.equal(production.tag, 'v2026.1.4');
    assert.equal(production.prefix, 'local-engine/v2026.1.4');
    assert.equal(production.releasePrefix, 'local-engine');
    const staging = engineReleaseContext(
        { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: commit },
        '2026.1.4',
    );
    assert.equal(staging.version, '2026.1.4-staging');
    assert.equal(staging.tag, 'v2026.1.4-staging');
    assert.equal(staging.prefix, `local-engine-staging/v2026.1.4-staging/${commit}`);
    assert.equal(staging.releasePrefix, 'local-engine-staging');
    assert.equal(stagingVersion(staging.version), staging.version);
    assert.notEqual(
        engineReleaseContext(
            { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: 'b'.repeat(40) },
            '2026.1.4',
        ).prefix,
        staging.prefix,
    );
    for (const env of [
        { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit },
        {
            GITHUB_REF: 'refs/heads/release/v2026.1.4',
            GITHUB_SHA: commit,
            BOX_BUILD_CHANNEL: 'staging',
        },
        { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: '../invalid' },
    ]) {
        assert.throws(() => engineReleaseContext(env, '2026.1.4'));
    }
    assert.throws(() =>
        engineReleaseContext(
            { GITHUB_REF: 'refs/heads/release/v2026.1.4-staging', GITHUB_SHA: commit },
            '2026.1.4',
        ),
    );
});

test('versioned production and staging prepare the actual Node, Cargo, Tauri and Compose versions', (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'box-channel-version-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const files = [
        'package.json',
        'scripts/sync-root-version.js',
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
    ];
    for (const name of files) {
        const file = path.join(temporary, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(root, name), file);
    }
    const version = '2026.1.5';
    prepareBuildChannel(
        { GITHUB_REF: 'refs/heads/release/v2026.1.5', GITHUB_SHA: commit },
        temporary,
    );
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(temporary, 'package.json'))).version,
        version,
    );
    prepareBuildChannel({ GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: commit }, temporary);
    assert.equal(
        JSON.parse(
            fs.readFileSync(
                path.join(temporary, 'apps/deployment-manager/src-tauri/tauri.conf.json'),
            ),
        ).version,
        stagingVersion(version),
    );
    assert.ok(
        fs
            .readFileSync(path.join(temporary, 'apps/server-manager-rust/Cargo.toml'), 'utf8')
            .includes(`version = "${stagingVersion(version)}"`),
    );
    assert.ok(
        fs
            .readFileSync(path.join(temporary, 'docker-compose.yml'), 'utf8')
            .includes(`BOX_IMAGE_TAG:-${stagingVersion(version)}`),
    );
    for (const file of [
        'apps/manager-core/Cargo.lock',
        'apps/deployment-manager/src-tauri/Cargo.lock',
        'apps/server-manager-rust/Cargo.lock',
    ]) {
        assert.match(
            fs.readFileSync(path.join(temporary, file), 'utf8'),
            new RegExp(
                `name = "box-manager-core"\\nversion = "${stagingVersion(version).replaceAll('.', '\\.')}"`,
            ),
        );
    }
    const portalLock = JSON.parse(
        fs.readFileSync(path.join(temporary, 'apps/player-auth-portal/package-lock.json')),
    );
    assert.equal(portalLock.version, stagingVersion(version));
    assert.equal(portalLock.packages[''].version, stagingVersion(version));
    const checked = spawnSync(
        process.execPath,
        [path.join(temporary, 'scripts/sync-root-version.js'), '--check'],
        {
            cwd: temporary,
            encoding: 'utf8',
        },
    );
    assert.equal(checked.status, 0, checked.stderr);
});

test('rendering a staging installer cannot update the production bootstrap defaults', () => {
    const source = fs.readFileSync(path.join(root, 'distribution/server/bootstrap.sh'), 'utf8');
    assert.equal(renderBootstrapInstaller(source, 'production'), source);
    const staging = renderBootstrapInstaller(source, 'staging');
    assert.ok(
        staging.includes('BOX3_RELEASE_CDN_URL:-https://assets.box3.fun/local-engine-staging}'),
    );
    assert.ok(staging.includes('BOX3_INSTALL_DIRECTORY:-/opt/box3-engine-staging}'));
});

test(
    'a staging Linux server package keeps its version and pinned image source',
    { skip: process.platform === 'win32' },
    (t) => {
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'box-staging-server-'));
        t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
        const context = engineReleaseContext(
            { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: commit },
            '2026.1.4',
        );
        fs.writeFileSync(
            path.join(temporary, 'package.json'),
            JSON.stringify({ version: context.version }),
        );
        fs.cpSync(
            path.join(root, 'distribution/server'),
            path.join(temporary, 'distribution/server'),
            { recursive: true },
        );
        fs.copyFileSync(
            path.join(root, 'docker-compose.yml'),
            path.join(temporary, 'docker-compose.yml'),
        );
        fs.mkdirSync(path.join(temporary, 'scripts'));
        for (const file of [
            'build-headless-server-package.js',
            'packaging-context.js',
            'build-image-downloads.js',
            'verify-headless-server-package.js',
        ]) {
            fs.copyFileSync(
                path.join(root, 'scripts', file),
                path.join(temporary, 'scripts', file),
            );
        }
        const sha = 'b'.repeat(64);
        const imageTag = `${context.tag}-linux-arm64`;
        const catalog = {
            formatVersion: 2,
            platform: 'linux/arm64',
            imageTag,
            images: [
                'creator',
                'voxa',
                'play',
                'player-service',
                'player-auth-portal',
                'server-manager',
            ].map((service) => ({
                formatVersion: 1,
                image: `box-local-engine-${service}`,
                imageId: `sha256:${sha}`,
                imageIds: [`sha256:${sha}`],
                imageTag,
                platform: 'linux/arm64',
                sha256: sha,
                size: 1,
                archive: `box-local-engine-image-${service}-arm64-${sha}.tar.gz`,
                downloadBaseUrl: context.downloadBaseUrl,
            })),
        };
        const catalogFile = path.join(temporary, 'catalog.json');
        fs.writeFileSync(catalogFile, JSON.stringify(catalog));
        const result = spawnSync(
            process.execPath,
            [
                path.join(temporary, 'scripts/build-headless-server-package.js'),
                'arm64',
                '--catalog',
                catalogFile,
            ],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_ACTIONS: 'true',
                    BOX_BUILD_CHANNEL: 'staging',
                    GITHUB_REF: 'refs/heads/staging',
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        const directory = path.join(
            temporary,
            'apps/local-engine/dist/server-packages/BOX3-Engine-Server-2026.1.4-staging-linux-arm64',
        );
        assert.ok(
            fs
                .readFileSync(path.join(directory, 'install.sh'), 'utf8')
                .includes(`${context.downloadBaseUrl}/$archive`),
        );
        assert.ok(
            fs
                .readFileSync(path.join(directory, '.env.example'), 'utf8')
                .includes(`BOX_IMAGE_TAG=${imageTag}`),
        );
        const verify = spawnSync(
            process.execPath,
            [path.join(temporary, 'scripts/verify-headless-server-package.js'), directory],
            { encoding: 'utf8' },
        );
        assert.equal(verify.status, 0, verify.stderr);
    },
);
