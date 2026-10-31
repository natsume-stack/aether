const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('snapshot restore never renames project source across /tmp and the project volume', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-project-restore-exdev-'));
    process.env.BOX_LOCAL_PROJECTS_PATH = temporaryRoot;
    process.env.BOX_PROJECT_BACKUP_PATH = path.join(temporaryRoot, '.backups');

    const manager = require('../apps/local-engine/src/project-manager');
    const originalRenameSync = fs.renameSync;

    try {
        const project = manager.createProject({
            id: 'restore-exdev-test',
            name: 'Restore EXDEV test',
        });
        const projectRoot = path.join(temporaryRoot, project.id);
        const sourceRoot = path.join(projectRoot, 'source');
        const blobRoot = path.join(sourceRoot, 'blobs');
        fs.mkdirSync(blobRoot, { recursive: true });

        const writeVersion = (permissionHash, marker) => {
            fs.writeFileSync(
                path.join(blobRoot, permissionHash),
                JSON.stringify({ type: 'permission', marker }),
            );
            fs.writeFileSync(
                path.join(sourceRoot, 'project-state.json'),
                JSON.stringify({ permissionHash, marker }),
            );
        };

        writeVersion('permission-one', 'one');
        const snapshot = manager.createProjectSnapshot(project.id, 'manual');
        writeVersion('permission-two', 'two');

        fs.renameSync = (source, destination) => {
            const sourceParent = path.dirname(path.dirname(String(source)));
            if (
                sourceParent === os.tmpdir() &&
                path.resolve(String(destination)) === path.resolve(sourceRoot)
            ) {
                const error = new Error('cross-device link not permitted');
                error.code = 'EXDEV';
                throw error;
            }
            return originalRenameSync(source, destination);
        };

        const restored = manager.restoreProjectSnapshot(
            project.id,
            path.basename(snapshot.archivePath),
        );
        assert.equal(restored.restored, true);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(sourceRoot, 'project-state.json'), 'utf8')).marker,
            'one',
        );
        assert.deepEqual(
            fs.readdirSync(projectRoot).filter((name) => name.startsWith('.box-project-restore-')),
            [],
            'same-volume staging directories must be cleaned after restore',
        );
    } finally {
        fs.renameSync = originalRenameSync;
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
