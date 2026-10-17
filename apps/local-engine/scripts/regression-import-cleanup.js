'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-import-cleanup-'));
process.env.BOX_LOCAL_PROJECTS_PATH = path.join(temporaryRoot, 'projects');

const manager = require('../src/project-manager');

try {
    const original = manager.createProject({ id: 'cleanup-source', name: 'Cleanup source' });
    const archive = manager.exportProject(original.id, { scope: 'map' });
    const importedRoot = path.join(process.env.BOX_LOCAL_PROJECTS_PATH, 'cleanup-source-imported');
    const sourceBlob = fs
        .readdirSync(path.join(process.env.BOX_LOCAL_PROJECTS_PATH, original.id, 'source', 'blobs'))
        .find((entry) => entry !== '.gitkeep');
    assert.ok(sourceBlob, 'fixture requires a template blob');
    const originalOpen = fs.openSync;
    const originalRemove = fs.rmSync;
    let cleanupAttempts = 0;

    fs.openSync = (target, flags, ...args) => {
        if (target === path.join(importedRoot, 'source', 'blobs', sourceBlob) && flags === 'w') {
            throw new Error('fixture copy failure');
        }
        return originalOpen(target, flags, ...args);
    };
    fs.rmSync = (target, options) => {
        if (target === importedRoot && cleanupAttempts++ === 0) {
            const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${target}/source'`);
            error.code = 'ENOTEMPTY';
            throw error;
        }
        return originalRemove(target, options);
    };
    try {
        assert.throws(() => manager.importProject(archive.archivePath), /fixture copy failure/);
    } finally {
        fs.openSync = originalOpen;
        fs.rmSync = originalRemove;
    }

    assert.equal(cleanupAttempts, 2, 'cleanup should retry a transient ENOTEMPTY error');
    assert.equal(
        fs.existsSync(importedRoot),
        false,
        'failed import should not leave an orphan project',
    );
    console.log('import cleanup regression passed');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
