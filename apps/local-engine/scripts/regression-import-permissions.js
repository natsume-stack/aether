const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeImportedProjectPermissions } = require('../src/project-manager');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-import-permissions-'));
try {
    const nested = path.join(root, 'source', 'blobs');
    const blob = path.join(nested, 'test-blob');
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    fs.writeFileSync(blob, 'blob', { mode: 0o200 });

    // Docker Desktop on macOS may reject lstat before chmod for mode 0200
    // files. Reproduce that behavior so the permission repair cannot regress
    // to inspecting an unreadable file before fixing its mode.
    const originalLstatSync = fs.lstatSync;
    fs.lstatSync = (target, ...args) => {
        if (target === blob) {
            const error = new Error(`EACCES: permission denied, lstat '${blob}'`);
            error.code = 'EACCES';
            throw error;
        }
        return originalLstatSync(target, ...args);
    };
    try {
        normalizeImportedProjectPermissions(root);
    } finally {
        fs.lstatSync = originalLstatSync;
    }

    assert.strictEqual(fs.statSync(root).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(nested).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(blob).mode & 0o777, 0o644);
    assert.strictEqual(fs.readFileSync(blob, 'utf8'), 'blob');
    console.log('import permission regression passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
