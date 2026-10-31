'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const check = process.argv.includes('--check');

const jsonFiles = [
    'apps/deployment-manager/package.json',
    'apps/local-engine/package.json',
    'apps/player-admin/package.json',
    'apps/player-auth-portal/package.json',
    'apps/server-manager/package.json',
    'apps/deployment-manager/src-tauri/tauri.conf.json',
];
const tomlFiles = [
    'apps/deployment-manager/src-tauri/Cargo.toml',
    'apps/manager-core/Cargo.toml',
    'apps/server-manager-rust/Cargo.toml',
];
const composeFiles = ['docker-compose.yml', 'distribution/play/compose.yml'];
const cargoLocks = [
    'apps/deployment-manager/src-tauri/Cargo.lock',
    'apps/manager-core/Cargo.lock',
    'apps/server-manager-rust/Cargo.lock',
];

function writeIfChanged(file, content) {
    const location = path.join(root, file);
    const current = fs.readFileSync(location, 'utf8');
    if (current === content) {
        return false;
    }
    if (check) {
        throw new Error(`${file} 的版本不是根 package.json 中的 ${version}`);
    }
    fs.writeFileSync(location, content);
    return true;
}

let changed = false;
for (const file of jsonFiles) {
    const location = path.join(root, file);
    const manifest = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (manifest.version === version) {
        continue;
    }
    manifest.version = version;
    changed = writeIfChanged(file, `${JSON.stringify(manifest, null, 2)}\n`) || changed;
}

for (const file of tomlFiles) {
    const location = path.join(root, file);
    const current = fs.readFileSync(location, 'utf8');
    const next = current.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
    if (next === current && !/^version\s*=\s*"/m.test(current)) {
        throw new Error(`${file} 缺少包版本`);
    }
    changed = writeIfChanged(file, next) || changed;
}

for (const file of composeFiles) {
    const location = path.join(root, file);
    const current = fs.readFileSync(location, 'utf8');
    const next = current.replaceAll(
        /(BOX_(?:IMAGE_TAG|BUILD_VERSION):-)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?/g,
        `$1${version}`,
    );
    changed = writeIfChanged(file, next) || changed;
}

for (const file of cargoLocks) {
    const location = path.join(root, file);
    if (!fs.existsSync(location)) {
        continue;
    }
    const current = fs.readFileSync(location, 'utf8');
    const next = current.replace(
        /(\[\[package\]\]\r?\nname = "(?:box-manager-core|box-local-engine-manager|box-local-engine-server-manager)"\r?\nversion = ")[^"]+("\r?\n)/g,
        (_, before, after) => `${before}${version}${after}`,
    );
    changed = writeIfChanged(file, next) || changed;
}

const portalLock = 'apps/player-auth-portal/package-lock.json';
if (fs.existsSync(path.join(root, portalLock))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, portalLock), 'utf8'));
    manifest.version = version;
    if (manifest.packages?.['']) {
        manifest.packages[''].version = version;
    }
    changed = writeIfChanged(portalLock, `${JSON.stringify(manifest, null, 2)}\n`) || changed;
}

if (!check) {
    console.log(changed ? `已同步发布版本 v${version}` : `发布版本已是 v${version}`);
}
