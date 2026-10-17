'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const [command, ...input] = process.argv.slice(2);

function option(name) {
    const index = input.indexOf(`--${name}`);
    return index >= 0 ? input[index + 1] : undefined;
}

function run(script, args) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
        cwd: root,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    process.exit(result.status ?? 1);
}

if (command === 'package-images') {
    run('package-offline-images.js', [option('architecture'), option('service')].filter(Boolean));
}
if (command === 'package-desktop') {
    if (!option('target')) {
        throw new Error('package-desktop 必须指定 --target。');
    }
    run('package-release.js', [
        'desktop',
        option('target'),
        option('archive') || '',
        option('mode') || 'slim',
    ]);
}
if (command === 'package-web') {
    run('package-release.js', [
        'web',
        option('architecture'),
        option('archive') || '',
        option('mode') || 'slim',
    ]);
}

throw new Error(`Unknown Rush package command: ${command || '(missing)'}`);
