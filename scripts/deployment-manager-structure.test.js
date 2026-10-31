'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { querySelectorCallback } = require('./lib/deployment-manager-source');
const checker = fs.readFileSync(
    path.join(__dirname, 'check-deployment-manager-structure.js'),
    'utf8',
);

function check(platformPath, additions = {}) {
    const root = platformPath === path.win32 ? 'C:\\repo' : '/repo';
    const directory = platformPath.join(root, 'apps/deployment-manager/src');
    const files = new Map(
        Object.entries({
            'infrastructure/transport.js': "import { invoke } from '@tauri-apps/api/core'\r\n",
            'operations/status.js': 'export function status() {}\r\n',
            'views/overview.js': 'export function overview() {}\r\n',
            ...additions,
        }).map(([name, source]) => [platformPath.join(directory, name), source]),
    );
    vm.runInNewContext(checker, {
        __dirname: platformPath.join(root, 'scripts'),
        console: { log() {} },
        require(name) {
            if (name === 'node:path') {
                return platformPath;
            }
            if (name === 'node:fs') {
                return {
                    readFileSync: (name) => files.get(name),
                    existsSync: (name) => files.has(name),
                };
            }
            if (name === './lib/deployment-manager-source') {
                return {
                    frontendFiles: (_, extension) =>
                        [...files.keys()].filter((name) => name.endsWith(extension)),
                };
            }
            return require(name);
        },
    });
}

for (const [name, platformPath] of [
    ['POSIX', path.posix],
    ['Windows', path.win32],
]) {
    test(`${name} paths permit the native bridge only in transport`, () => {
        assert.doesNotThrow(() => check(platformPath));
        assert.throws(
            () =>
                check(platformPath, {
                    'operations/unsafe.js': "import { invoke } from '@tauri-apps/api/core'",
                }),
            /native bridge imports/,
        );
    });
    test(`${name} view paths reject operation imports`, () => {
        assert.throws(
            () =>
                check(platformPath, {
                    'views/overview.js': "import { status } from '../operations/status.js'",
                }),
            /views must render data/,
        );
    });
}

for (const width of [2, 4]) {
    test(`selector callback inspection ignores ${width}-space formatting`, () => {
        const space = ' '.repeat(width);
        const source = `document.querySelectorAll('[data-database-mode]').forEach((node) =>\n${space}node.addEventListener('click', () => {\n${space}${space}state.config.databaseMode = node.dataset.databaseMode;\n${space}}),\n);`;
        assert.match(
            querySelectorCallback(source, '[data-database-mode]'),
            /state\.config\.databaseMode = node\.dataset\.databaseMode/,
        );
        assert.equal(querySelectorCallback(source, '[data-redis-mode]'), undefined);
    });
}
