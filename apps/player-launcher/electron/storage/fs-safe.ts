import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OpenedFile {
    handle:fs.promises.FileHandle;
    stat:fs.Stats;
}

export async function openRegularFile(
    filename:string,
    expectedSize?:number,
):Promise<OpenedFile | null> {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    let handle;
    try {
        const pathStat = await fs.promises.lstat(filename);
        if (
            !pathStat.isFile() ||
            pathStat.isSymbolicLink() ||
            (expectedSize !== undefined && pathStat.size !== expectedSize)
        ) {
            return null;
        }
        handle = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollow);
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.dev !== pathStat.dev ||
            stat.ino !== pathStat.ino ||
            (expectedSize !== undefined && stat.size !== expectedSize)
        ) {
            await handle.close();
            return null;
        }
        return { handle, stat };
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined);
        }
        if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR') {
            return null;
        }
        throw error;
    }
}

export async function ensureDirectory(filename:string):Promise<void> {
    await fs.promises.mkdir(filename, { recursive: true });
    const stat = await fs.promises.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('本地地图资源目录状态异常');
    }
}

export async function ensureSubdirectories(root:string, ...segments:string[]):Promise<string> {
    await ensureDirectory(root);
    let current = root;
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..' || segment.includes(path.sep)) {
            throw new Error('本地地图资源目录路径无效');
        }
        current = path.join(current, segment);
        try {
            await fs.promises.mkdir(current);
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
        const stat = await fs.promises.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('本地地图资源目录状态异常');
        }
    }
    return current;
}

export async function assertSubdirectories(root:string, ...segments:string[]):Promise<boolean> {
    const rootStat = await fs.promises
        .lstat(root)
        .catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!rootStat) {
        return false;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('本地地图资源目录状态异常');
    }
    let current = root;
    for (const segment of segments) {
        if (!segment || segment === '.' || segment === '..' || segment.includes(path.sep)) {
            throw new Error('本地地图资源目录路径无效');
        }
        current = path.join(current, segment);
        let stat;
        try {
            stat = await fs.promises.lstat(current);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                return false;
            }
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('本地地图资源目录状态异常');
        }
    }
    return true;
}

export async function readRegularFile(
    filename:string,
    maxBytes = 16 * 1024 * 1024,
):Promise<Buffer | null> {
    const opened = await openRegularFile(filename);
    if (!opened) {
        return null;
    }
    try {
        if (opened.stat.size > maxBytes) {
            throw new Error('本地地图包索引文件超过安全上限');
        }
        return await opened.handle.readFile();
    } finally {
        await opened.handle.close().catch(() => undefined);
    }
}

export function readRegularFileSync(filename:string, maxBytes = 16 * 1024 * 1024):Buffer {
    let descriptor;
    try {
        const pathStat = fs.lstatSync(filename);
        if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
            throw new Error('本地地图包索引文件状态无效');
        }
        descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
            throw new Error('本地地图包索引文件状态无效');
        }
        if (stat.size > maxBytes) {
            throw new Error('本地地图包索引文件超过安全上限');
        }
        return fs.readFileSync(descriptor);
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
