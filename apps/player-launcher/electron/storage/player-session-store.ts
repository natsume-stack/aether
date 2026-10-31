import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { readRegularFileSync } from './fs-safe';

export interface PlayerSessionStore {
    read(endpoint:string):string;
    write(endpoint:string, cookies:string):void;
    delete(endpoint:string):void;
}

interface SessionEncryption {
    isEncryptionAvailable():boolean;
    getSelectedStorageBackend?:() => string;
    encryptString(value:string):Buffer;
    decryptString(value:Buffer):string;
}

/** Main-process only. Never fall back to plaintext when an OS key store is unavailable. */
export function createPlayerSessionStore(
    directory:string,
    encryption:SessionEncryption,
):PlayerSessionStore {
    const available = () =>
        encryption.isEncryptionAvailable() &&
        encryption.getSelectedStorageBackend?.() !== 'basic_text';
    const filename = (endpoint:string) =>
        path.join(directory, createHash('sha256').update(endpoint).digest('hex') + '.session');
    return {
        read(endpoint) {
            if (!available()) {
                return '';
            }
            try {
                const data = JSON.parse(
                    encryption.decryptString(readRegularFileSync(filename(endpoint), 64 * 1024)),
                );
                if (data.endpoint !== endpoint || typeof data.cookies !== 'string') {
                    return '';
                }
                return data.cookies;
            } catch {
                // Missing, corrupted or no longer decryptable credentials require a new login.
                return '';
            }
        },
        write(endpoint, cookies) {
            if (!available()) {
                return;
            }
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            if (fs.lstatSync(directory).isSymbolicLink()) {
                throw new Error('会话存储目录无效');
            }
            const temporary = filename(endpoint) + '.' + randomUUID() + '.tmp';
            try {
                const encrypted = encryption.encryptString(JSON.stringify({ endpoint, cookies }));
                fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
                fs.renameSync(temporary, filename(endpoint));
            } finally {
                fs.rmSync(temporary, { force: true });
            }
        },
        delete(endpoint) {
            fs.rmSync(filename(endpoint), { force: true });
        },
    };
}
