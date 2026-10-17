'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function main() {
    const packageRoot = path.resolve(process.argv[2] || '');
    assert.ok(
        fs.statSync(packageRoot, { throwIfNoEntry: false })?.isDirectory(),
        'package directory missing',
    );

    const manager = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'BOX3-MANAGER-IMAGE.json'), 'utf8'),
    );
    const catalog = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'BOX3-IMAGE-CATALOG.json'), 'utf8'),
    );
    require('./build-image-downloads').validateCatalog(catalog, catalog.platform?.split('/')[1]);
    assert.equal(catalog.formatVersion, 2);
    assert.match(catalog.platform, /^linux\/(amd64|arm64)$/);
    assert.equal(manager.platform, catalog.platform);
    assert.equal(manager.imageTag, catalog.imageTag);
    assert.equal(manager.image, 'box-local-engine-server-manager');
    assert.equal(catalog.images.length, 6);
    const managerEntry = catalog.images.find((image) => image.image === manager.image);
    assert.ok(managerEntry, 'server manager missing from image catalog');
    assert.equal(managerEntry.archive, manager.archive);
    assert.equal(managerEntry.sha256, manager.sha256);
    assert.equal(managerEntry.size, manager.size);
    assert.match(manager.sha256, /^[a-f0-9]{64}$/);
    assert.ok(manager.size > 0);
    const managerContentTag = `${manager.image}:launcher-content-${managerEntry.imageId.slice(7)}`;
    assert.equal(manager.contentTag, managerContentTag);
    const modeFile = path.join(packageRoot, 'BOX3-PACKAGE-MODE.json');
    const mode = fs.existsSync(modeFile)
        ? JSON.parse(fs.readFileSync(modeFile, 'utf8')).mode
        : 'slim';
    assert.ok(['slim', 'local'].includes(mode), 'invalid package mode');
    if (mode === 'local') {
        for (const image of catalog.images) {
            const file = path.join(packageRoot, 'cache/engine-images', image.archive);
            assert.equal(fs.statSync(file).size, image.size, 'local image size mismatch');
            const digest = require('crypto').createHash('sha256');
            const descriptor = fs.openSync(file, 'r');
            const buffer = Buffer.alloc(128 * 1024);
            let read;
            try {
                while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
                    digest.update(buffer.subarray(0, read));
                }
            } finally {
                fs.closeSync(descriptor);
            }
            const hash = digest.digest('hex');
            assert.equal(hash, image.sha256, 'local image digest mismatch');
        }
    }
    const archives = fs.readdirSync(packageRoot).filter((file) => file.endsWith('.tar.gz'));
    assert.deepEqual(archives, [], 'server package must not bundle Docker image archives');

    for (const file of [
        'compose.yml',
        '.env.example',
        'install.sh',
        'status.sh',
        'logs.sh',
        'stop.sh',
        'verify.sh',
        'README.md',
        'SHA256SUMS',
        'BOX3-IMAGE-CATALOG.json',
        'BOX3-MANAGER-IMAGE.json',
    ]) {
        assert.ok(fs.existsSync(path.join(packageRoot, file)), `package file missing: ${file}`);
    }

    const environmentTemplate = fs.readFileSync(path.join(packageRoot, '.env.example'), 'utf8');
    assert.match(
        environmentTemplate,
        /^BOX_RUNTIME_MANAGER_TOKEN=CHANGE_ME_RUNTIME_MANAGER_TOKEN$/m,
        'server manager runtime token template is missing',
    );
    const installer = fs.readFileSync(path.join(packageRoot, 'install.sh'), 'utf8');
    assert.match(
        installer,
        /ensure_secret BOX_RUNTIME_MANAGER_TOKEN CHANGE_ME_RUNTIME_MANAGER_TOKEN/,
        'installer must provision the runtime manager token for new and upgraded environments',
    );

    // The README asks the operator to run ./install.sh, so the packaged script
    // must already carry the executable bit.
    for (const file of ['install.sh', 'status.sh', 'logs.sh', 'stop.sh', 'verify.sh']) {
        const mode = fs.statSync(path.join(packageRoot, file)).mode;
        assert.ok((mode & 0o111) !== 0, `package script is not executable: ${file}`);
    }

    const compose = fs.readFileSync(path.join(packageRoot, 'compose.yml'), 'utf8');
    for (const service of [
        'managed-postgres',
        'managed-redis',
        'server-manager',
        'creator',
        'voxa',
        'play',
        'player-service',
        'player-auth-portal',
    ]) {
        assert.match(
            compose,
            new RegExp(`^  ${service}:`, 'm'),
            `compose service missing: ${service}`,
        );
    }

    console.log(`Verified headless server package: ${packageRoot}`);
}

if (require.main === module) {
    main();
}
