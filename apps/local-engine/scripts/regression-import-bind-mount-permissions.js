'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-import-bind-mount-'));
process.env.BOX_LOCAL_PROJECTS_PATH = path.join(temporaryRoot, 'projects');

const manager = require('../src/project-manager');

try {
    const original = manager.createProject({ id: 'permission-source', name: 'Permission source' });
    const archive = manager.exportProject(original.id, { scope: 'map' });
    const importedSource = path.join(
        process.env.BOX_LOCAL_PROJECTS_PATH,
        'permission-source-imported',
        'source',
    );
    const originalCopy = fs.cpSync;

    // This emulates Docker Desktop's bind-mount behavior: cpSync makes an
    // imported source/ unreadable while preserving archive permissions. The
    // import must use copyReadableDirectorySync instead and never invoke cpSync
    // for this destination.
    fs.cpSync = (source, destination, ...args) => {
        if (destination === importedSource) {
            const error = new Error(`EACCES: permission denied, copy '${destination}'`);
            error.code = 'EACCES';
            throw error;
        }
        return originalCopy(source, destination, ...args);
    };
    let imported;
    try {
        imported = manager.importProject(archive.archivePath);
    } finally {
        fs.cpSync = originalCopy;
    }

    assert.equal(imported.id, 'permission-source-imported');
    assert.ok(
        fs.readdirSync(importedSource).length > 0,
        'the imported source tree should be readable after a bind-mount-safe copy',
    );
    console.log('import bind-mount permission regression passed');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
