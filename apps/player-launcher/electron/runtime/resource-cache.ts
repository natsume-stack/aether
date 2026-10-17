import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Session } from 'electron';

async function directoryBytes(root:string):Promise<number> {
    let stat;
    try {
        stat = await fs.lstat(root);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
    if (stat.isSymbolicLink()) {
        return 0;
    }
    if (stat.isFile()) {
        return stat.size;
    }
    if (!stat.isDirectory()) {
        return 0;
    }
    let bytes = 0;
    const entries = await fs.readdir(root);
    for (let index = 0; index < entries.length; index += 8) {
        const sizes = await Promise.all(
            entries.slice(index, index + 8).map((entry) => directoryBytes(path.join(root, entry))),
        );
        bytes += sizes.reduce((sum, size) => sum + size, 0);
    }
    return bytes;
}

export async function readResourceCache(session:Session) {
    const root = session.getStoragePath();
    const [staticBytes, httpBytes] = await Promise.all([
        root ? directoryBytes(path.join(root, 'Service Worker', 'CacheStorage')) : 0,
        session.getCacheSize(),
    ]);
    return {
        staticBytes,
        httpBytes,
    };
}

export async function clearResourceCache(session:Session):Promise<void> {
    await session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await session.clearCache();
}
