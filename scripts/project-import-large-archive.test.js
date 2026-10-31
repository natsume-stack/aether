const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

function writeOctal(header, offset, length, value) {
    const encoded = value.toString(8).padStart(length - 1, '0') + '\0';
    header.write(encoded, offset, length, 'ascii');
}

function tarEntry(name, type = '0') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, 0);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return header;
}

test('large project archive entry listings do not overflow spawnSync buffers', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box-large-import-test-'));
    process.env.BOX_LOCAL_PROJECTS_PATH = path.join(temporaryRoot, 'projects-root');
    const { archiveEntriesAreSafe } = require('../apps/local-engine/src/project-manager');
    const archivePath = path.join(temporaryRoot, 'large.boxproject');
    try {
        const entries = [tarEntry('group.json'), tarEntry('projects/', '5')];
        for (let index = 0; index < 24_000; index += 1) {
            entries.push(tarEntry(`projects/map/blobs/Qm${String(index).padStart(44, '1')}`));
        }
        entries.push(Buffer.alloc(1024));
        fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat(entries)));

        assert.doesNotThrow(() => archiveEntriesAreSafe(archivePath));
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
});
