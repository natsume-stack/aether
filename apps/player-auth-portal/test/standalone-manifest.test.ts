import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { prepareStandalone } from '../scripts/standalone-manifest.cjs';

test('standalone lock matches direct runtime and build dependencies', () => {
    const project = path.resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies']) {
        for (const [name, version] of Object.entries(manifest[section])) {
            if (String(version).startsWith('workspace:')) {
                continue;
            }
            assert.equal(lock.packages[''][section][name], version, `${name} lock spec drift`);
            if (/^\d+\.\d+\.\d+$/.test(String(version))) {
                assert.equal(
                    lock.packages[`node_modules/${name}`].version,
                    version,
                    `${name} resolved version drift`,
                );
            }
        }
    }
});

test('standalone templates vendor routing and the canonical SDK while preserving other locks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-portal-vendor-'));
    try {
        const project = path.resolve(import.meta.dirname, '..');
        fs.copyFileSync(path.join(project, 'package.json'), path.join(root, 'package.json'));
        fs.copyFileSync(
            path.join(project, 'package-lock.json'),
            path.join(root, 'package-lock.json'),
        );
        const before = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
        const require = createRequire(import.meta.url);
        prepareStandalone(
            root,
            path.dirname(require.resolve('@box/deployment-routing/package.json')),
        );
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
        assert.equal(
            manifest.dependencies['@box/deployment-routing'],
            'file:vendor/deployment-routing',
        );
        assert.equal(lock.packages[''].version, manifest.version);
        assert.equal(lock.packages['node_modules/@box/deployment-routing'].link, true);
        assert.equal(manifest.dependencies['@box/apis'], 'file:vendor/apis');
        assert.equal(lock.packages['node_modules/@box/apis'].link, true);
        assert.ok(fs.existsSync(path.join(root, 'vendor/apis/src/generated/client.ts')));
        assert.ok(fs.existsSync(path.join(root, 'vendor/apis/src/generated/openapi.ts')));
        assert.equal(lock.packages['vendor/apis'].dependencies['openapi-fetch'], '0.17.0');
        assert.ok(!fs.existsSync(path.join(root, 'vendor/apis/node_modules')));
        assert.deepEqual(
            lock.packages['node_modules/react'],
            before.packages['node_modules/react'],
        );
        assert.ok(fs.existsSync(path.join(root, 'vendor/deployment-routing/src/browser.cjs')));
        assert.ok(!fs.existsSync(path.join(root, 'vendor/deployment-routing/node_modules')));
        prepareStandalone(root, path.join(root, 'vendor/deployment-routing'));
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[
                '@box/deployment-routing'
            ],
            'file:vendor/deployment-routing',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
