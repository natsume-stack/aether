'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    sourceFingerprint,
    planImages,
    planManagerImage,
    mergeImages,
    services,
} = require('./server-image-plan');

test('image cache follows reusable package and build dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-package-plan-'));
    const files = [
        'packages/deployment-routing/src/browser.cjs',
        'packages/player-policy/src/policy.ts',
        'scripts/build-reusable-package.js',
    ];
    try {
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), 'original');
        }
        const fingerprints = () =>
            services.map((service) => sourceFingerprint(root, service, files));
        const baseline = fingerprints();
        const changedServices = () =>
            fingerprints().flatMap((value, index) =>
                value === baseline[index] ? [] : [services[index]],
            );
        fs.writeFileSync(path.join(root, files[0]), 'updated routing');
        assert.deepEqual(
            changedServices(),
            services.filter((service) => service !== 'server-manager'),
        );
        fs.writeFileSync(path.join(root, files[0]), 'original');
        for (const file of files.slice(1)) {
            fs.writeFileSync(path.join(root, file), 'updated');
            assert.deepEqual(changedServices(), ['player-service', 'creator', 'play', 'voxa']);
            fs.writeFileSync(path.join(root, file), 'original');
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('same version/source skips images; a Web manager change rebuilds only that image', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-server-plan-'));
    try {
        const files = [
            'package.json',
            'apps/server-manager-rust/src/main.rs',
            'apps/game/src/main.ts',
            '.env.docker.example',
        ];
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(
                path.join(root, file),
                file === 'package.json' ? '{"version":"0.3.0"}' : 'original',
            );
        }
        const initial = planImages(root, 'arm64', null, files);
        assert.ok(initial.every((item) => item.build));
        const digest = 'a'.repeat(64);
        const catalog = {
            formatVersion: 2,
            platform: 'linux/arm64',
            imageTag: initial[0].imageTag,
            images: initial.map((item) => ({
                formatVersion: 1,
                image: `box-local-engine-${item.service}`,
                imageId: `sha256:${digest}`,
                imageIds: [`sha256:${digest}`],
                imageTag: item.imageTag,
                platform: 'linux/arm64',
                sha256: digest,
                size: 100,
                archive: `box-local-engine-image-${item.service}-arm64-${digest}.tar.gz`,
                sourceFingerprint: item.sourceFingerprint,
            })),
        };
        assert.throws(
            () => planManagerImage(root, 'arm64', null, files),
            /Run the release workflow first/,
        );
        // Release catalogs have no source fingerprints. Application changes must
        // still reuse those published images and preserve their original metadata.
        const releaseCatalog = JSON.parse(JSON.stringify(catalog));
        for (const image of releaseCatalog.images) {
            delete image.sourceFingerprint;
        }
        fs.writeFileSync(path.join(root, 'apps/game/src/main.ts'), 'new application source');
        const managerPlan = planManagerImage(root, 'arm64', releaseCatalog, files);
        assert.deepEqual(
            managerPlan.filter((item) => item.build).map((item) => item.service),
            ['server-manager'],
        );
        fs.writeFileSync(
            path.join(root, 'server-manager.json'),
            JSON.stringify({
                images: [
                    releaseCatalog.images.find(
                        (image) => image.image === 'box-local-engine-server-manager',
                    ),
                ],
            }),
        );
        const managerCatalog = mergeImages('arm64', releaseCatalog, managerPlan, root);
        for (const service of services.filter((name) => name !== 'server-manager')) {
            assert.deepEqual(
                managerCatalog.images.find(
                    (image) => image.image === `box-local-engine-${service}`,
                ),
                releaseCatalog.images.find(
                    (image) => image.image === `box-local-engine-${service}`,
                ),
            );
        }
        assert.ok(
            planManagerImage(root, 'arm64', managerCatalog, files).every((item) => !item.build),
        );
        assert.throws(
            () => planManagerImage(root, 'amd64', releaseCatalog, files),
            /Invalid per-service/,
        );
        assert.throws(
            () =>
                planManagerImage(
                    root,
                    'arm64',
                    { ...releaseCatalog, imageTag: 'v0.2.0-linux-arm64' },
                    files,
                ),
            /version mismatch/,
        );
        fs.writeFileSync(path.join(root, 'apps/game/src/main.ts'), 'original');
        assert.ok(planImages(root, 'arm64', catalog, files).every((item) => !item.build));
        fs.writeFileSync(
            path.join(root, 'apps/server-manager-rust/src/main.rs'),
            'Web download and update fixes',
        );
        const changed = planImages(root, 'arm64', catalog, files);
        assert.deepEqual(
            changed.filter((item) => item.build).map((item) => item.service),
            ['server-manager'],
        );
        const updated = {
            ...catalog.images.find((image) => image.image === 'box-local-engine-server-manager'),
            size: 200,
        };
        fs.writeFileSync(
            path.join(root, 'server-manager.json'),
            JSON.stringify({ images: [updated] }),
        );
        const merged = mergeImages('arm64', catalog, changed, root);
        assert.equal(merged.images.find((image) => image.image === updated.image).size, 200);
        for (const service of services.filter((name) => name !== 'server-manager')) {
            assert.deepEqual(
                merged.images.find((image) => image.image === `box-local-engine-${service}`),
                catalog.images.find((image) => image.image === `box-local-engine-${service}`),
            );
        }
        assert.ok(planImages(root, 'arm64', merged, files).every((item) => !item.build));
        fs.writeFileSync(path.join(root, '.env.docker.example'), 'BOX_BUILD_VERSION=updated');
        assert.ok(
            planImages(root, 'arm64', merged, files).every((item) => item.build),
            'Docker environment template changes invalidate every image',
        );
        assert.throws(() => planImages(root, 'amd64', catalog, files), /Invalid per-service/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
