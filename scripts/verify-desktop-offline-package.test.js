'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { verifyPackage } = require('./verify-desktop-offline-package');

function sha256(file) {
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixturePackage() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-desktop-package-'));
    const app = path.join(root, 'BOX3 Engine.app');
    const payload = path.join(app, 'Contents', 'Resources', 'payload');
    const metadata = path.join(payload, 'metadata');
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(
        path.join(metadata, 'BOX-REMOTE-IMAGE.json'),
        `${JSON.stringify({
            formatVersion: 2,
            imageTag: 'v0.1.0-linux-arm64',
            platform: 'linux/arm64',
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
                imageId: `sha256:${'b'.repeat(64)}`,
                imageIds: [`sha256:${'b'.repeat(64)}`],
                archive: `box-local-engine-image-${service}-arm64-${'a'.repeat(64)}.tar.gz`,
                sha256: 'a'.repeat(64),
                size: 123,
                imageTag: 'v0.1.0-linux-arm64',
                platform: 'linux/arm64',
            })),
        })}\n`,
    );
    const info = {
        version: '0.1.0',
        sourceRevision: 'test',
        buildCreatedAt: '2026-08-26T00:00:00.000Z',
        source: 'release',
    };
    for (const name of ['BUILD-INFO.json', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.json']) {
        fs.writeFileSync(
            path.join(metadata, name),
            name === 'BUILD-INFO.json' ? JSON.stringify(info) : name,
        );
    }
    const sums = ['BUILD-INFO.json', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.json']
        .map((name) => `${sha256(path.join(metadata, name))}  ${name}`)
        .join('\n');
    fs.writeFileSync(path.join(metadata, 'SHA256SUMS'), `${sums}\n`);
    return root;
}

test('macOS unsigned internal package skips outer resource-signature verification', () => {
    const root = fixturePackage();
    try {
        assert.doesNotThrow(() => verifyPackage(root));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('lightweight packages reject accidentally embedded archives and invalid image metadata', () => {
    const root = fixturePackage();
    try {
        fs.writeFileSync(path.join(root, 'images.tar.gz'), 'unexpected archive');
        assert.throws(() => verifyPackage(root), /不应包含离线镜像/);
        fs.rmSync(path.join(root, 'images.tar.gz'));
        const file = path.join(
            root,
            'BOX3 Engine.app/Contents/Resources/payload/metadata/BOX-REMOTE-IMAGE.json',
        );
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.images[0].archive = '../wrong-image.tar.gz';
        fs.writeFileSync(file, JSON.stringify(manifest));
        assert.throws(() => verifyPackage(root), /Invalid image download/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('local desktop packages require a matching bundled archive and no OSS manifest', () => {
    const root = fixturePackage();
    const payload = path.join(root, 'BOX3 Engine.app/Contents/Resources/payload');
    const metadata = path.join(payload, 'metadata');
    try {
        fs.unlinkSync(path.join(metadata, 'BOX-REMOTE-IMAGE.json'));
        fs.writeFileSync(
            path.join(metadata, 'BOX-PACKAGE-MODE.json'),
            JSON.stringify({ mode: 'local' }),
        );
        const archive = 'box-local-engine-images-test-linux-arm64.tar.gz';
        fs.writeFileSync(path.join(payload, archive), 'local Docker snapshot');
        fs.writeFileSync(
            path.join(payload, 'BOX-OFFLINE-IMAGE.json'),
            JSON.stringify({
                formatVersion: 1,
                imageTag: 'test',
                platform: 'linux/arm64',
                archive,
                sha256: sha256(path.join(payload, archive)),
            }),
        );
        assert.equal(verifyPackage(root).manifest.imageTag, 'test');
        fs.appendFileSync(path.join(payload, archive), 'tampered');
        assert.throws(() => verifyPackage(root), /SHA-256/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
