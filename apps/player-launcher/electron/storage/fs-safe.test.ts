import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { ensureSubdirectories, readRegularFile } from './fs-safe';

test('does not follow symlinks when reading app-managed data', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-fs-safe-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const secret = path.join(root, 'outside');
    const linked = path.join(root, 'packages');
    fs.writeFileSync(secret, 'outside');
    try {
        fs.symlinkSync(secret, path.join(root, 'blob-link'));
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
            return context.skip('symlink creation unavailable');
        }
        throw error;
    }
    try {
        fs.symlinkSync(root, linked, 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
            return context.skip('directory symlink creation unavailable');
        }
        throw error;
    }
    assert.equal(await readRegularFile(path.join(root, 'blob-link')), null);
    await assert.rejects(ensureSubdirectories(root, 'packages', 'child'), /状态异常/);
});
