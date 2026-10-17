import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { createPlayerSessionStore } from './player-session-store';

test('encrypted sessions survive store recreation, are server-scoped, and can be deleted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-session-'));
    const key = randomBytes(32);
    const encryption = {
        isEncryptionAvailable: () => true,
        encryptString(value:string) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([cipher.update(value), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]);
        },
        decryptString(value:Buffer) {
            const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
            cipher.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
        },
    };
    try {
        const endpoint = 'https://a.example.test';
        createPlayerSessionStore(directory, encryption).write(
            endpoint,
            'box_local_player_session=fixture-secret',
        );
        const filename = path.join(directory, fs.readdirSync(directory)[0]);
        assert.equal(fs.readFileSync(filename).includes(Buffer.from('fixture-secret')), false);
        const restarted = createPlayerSessionStore(directory, encryption);
        assert.equal(restarted.read(endpoint), 'box_local_player_session=fixture-secret');
        assert.equal(restarted.read('https://b.example.test'), '');
        restarted.delete(endpoint);
        assert.equal(createPlayerSessionStore(directory, encryption).read(endpoint), '');
        restarted.write(endpoint, 'box_local_player_session=another');
        fs.writeFileSync(filename, 'corrupted');
        assert.equal(restarted.read(endpoint), '');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('missing secure OS storage does not write credentials as plaintext', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'box-player-session-'));
    try {
        for (const backend of ['unavailable', 'basic_text']) {
            const store = createPlayerSessionStore(directory, {
                isEncryptionAvailable: () => backend !== 'unavailable',
                getSelectedStorageBackend: () => backend,
                encryptString: () => {
                    throw new Error('Must not encrypt without secure storage');
                },
                decryptString: () => {
                    throw new Error('Must not decrypt without secure storage');
                },
            });
            store.write('https://a.example.test', 'box_local_player_session=fixture');
            assert.equal(store.read('https://a.example.test'), '');
            assert.deepEqual(fs.readdirSync(directory), []);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
