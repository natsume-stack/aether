'use strict';

const assert = require('assert');
const { makeRuntimeDataReadable } = require('../src/runtime-data-permissions');

function directory(name) {
    return {
        name,
        isDirectory: () => true,
        isFile: () => false,
    };
}

function file(name) {
    return {
        name,
        isDirectory: () => false,
        isFile: () => true,
    };
}

const accessed = [];
const windowsBindMount = {
    constants: { R_OK: 4, X_OK: 1 },
    chmodSync(target) {
        const error = new Error(`operation not permitted: ${target}`);
        error.code = 'EPERM';
        throw error;
    },
    accessSync(target, mode) {
        accessed.push([target, mode]);
    },
    readdirSync(target) {
        if (target === '/project/source') {
            return [directory('blobs'), file('project-state.json')];
        }
        if (target === '/project/source/blobs') {
            return [file('QmHash')];
        }
        throw new Error(`unexpected path: ${target}`);
    },
};

makeRuntimeDataReadable('/project/source', windowsBindMount);
assert.deepEqual(accessed, [
    ['/project/source', 5],
    ['/project/source/project-state.json', 4],
    ['/project/source/blobs', 5],
    ['/project/source/blobs/QmHash', 4],
]);

const unreadableBindMount = {
    ...windowsBindMount,
    accessSync() {
        const error = new Error('not readable');
        error.code = 'EACCES';
        throw error;
    },
};
assert.throws(
    () => makeRuntimeDataReadable('/project/source', unreadableBindMount),
    (error) => error.code === 'EPERM' && error.message.includes('/project/source'),
);

console.log('runtime data permission regression passed');
