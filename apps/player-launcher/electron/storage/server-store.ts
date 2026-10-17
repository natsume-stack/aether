import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { ensureDirectory, readRegularFileSync } from './fs-safe';
import { normalizeServerAddress } from '../../shared/server-address';

import type { PlayerServerRecord, PlayerServerState } from '../types';

export interface ServerStore {
    load():PlayerServerState;
    add(value:string):Promise<PlayerServerRecord>;
    select(serverId:string):Promise<PlayerServerState>;
    rename(serverId:string, value:string):Promise<PlayerServerRecord>;
    remove(serverId:string):Promise<PlayerServerState>;
}

export function normalizeEndpoint(value:string):string {
    return normalizeServerAddress(value);
}

export function normalizeName(value:string):string {
    const name = String(value || '').trim();
    if (!name) {
        throw new Error('服务器昵称不能为空');
    }
    if ([...name].length > 40) {
        throw new Error('服务器昵称不能超过 40 个字符');
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('服务器昵称不能包含控制字符');
    }
    return name;
}

async function writeFile(filename:string, state:PlayerServerState):Promise<void> {
    await ensureDirectory(path.dirname(filename));
    const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fs.promises.rename(temporary, filename);
    } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function createServerStore(filename:string):ServerStore {
    const load = () => {
        try {
            const contents = readRegularFileSync(filename);
            const state = JSON.parse(contents.toString('utf8'));
            if (!state || !Array.isArray(state.servers)) {
                throw new Error('服务器列表格式无效');
            }
            return { servers: state.servers, selectedServerId: state.selectedServerId || null };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { servers: [], selectedServerId: null };
            }
            throw new Error(`无法读取服务器列表：${error.message}`);
        }
    };
    const save = async (state) => {
        await writeFile(filename, state);
        return state;
    };

    return Object.freeze({
        load,
        async add(value) {
            const endpoint = normalizeEndpoint(value);
            const id = endpoint.toLowerCase();
            const server = { id, endpoint, name: new URL(endpoint).host };
            const state = load();
            state.servers = [server, ...state.servers.filter((item) => item.id !== id)];
            state.selectedServerId = id;
            await save(state);
            return server;
        },
        async select(serverId) {
            const state = load();
            if (!state.servers.some((server) => server.id === serverId)) {
                throw new Error('这个服务器已不在列表中');
            }
            state.selectedServerId = serverId;
            return save(state);
        },
        async rename(serverId, value) {
            const state = load();
            const server = state.servers.find((item) => item.id === serverId);
            if (!server) {
                throw new Error('这个服务器已不在列表中');
            }
            server.name = normalizeName(value);
            await save(state);
            return server;
        },
        async remove(serverId) {
            const state = load();
            state.servers = state.servers.filter((server) => server.id !== serverId);
            if (state.selectedServerId === serverId) {
                state.selectedServerId = state.servers[0]?.id || null;
            }
            return save(state);
        },
    });
}
