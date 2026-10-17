import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApiTransport } from '../electron/network/api-transport';
import { createLauncherController } from '../src/application/controller';
import { createInitialState } from '../src/application/state';
import { bindEvents } from '../src/events';

function deferred<T>() {
    let resolve!:(value:T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('a restarted transport restores each server session and logout remains cleared', async () => {
    const saved = new Map<string, string>();
    const sessionStore = {
        read: (endpoint:string) => saved.get(endpoint) || '',
        write: (endpoint:string, cookie:string) => {
            saved.set(endpoint, cookie);
        },
        delete: (endpoint:string) => {
            saved.delete(endpoint);
        },
    };
    const endpoint = 'https://a.example.test';
    const fetchImpl = async (_input, options) =>
        Response.json(
            {},
            {
                headers:
                    options.method === 'POST'
                        ? { 'set-cookie': 'box_local_player_session=fixture; Path=/; HttpOnly' }
                        : {},
            },
        );
    const first = createApiTransport({ fetchImpl, sessionStore } as any);
    await first.request({ endpoint, url: endpoint + '/api/auth/login', method: 'POST' });
    const restarted = createApiTransport({ fetchImpl, sessionStore } as any);
    assert.deepEqual(restarted.cookies(endpoint), [['box_local_player_session', 'fixture']]);
    assert.deepEqual(restarted.cookies('https://b.example.test'), []);
    restarted.clear(endpoint);
    assert.deepEqual(createApiTransport({ sessionStore } as any).cookies(endpoint), []);
});

test('late server A session and maps cannot overwrite selected server B', async () => {
    const a = { id: 'a', endpoint: 'https://a.example.test', name: 'A' };
    const b = { id: 'b', endpoint: 'https://b.example.test', name: 'B' };
    const state = createInitialState();
    state.servers = [a, b];
    state.selectedId = a.id;
    state.serverBootstrap = { supported: true, loginRequired: true } as any;
    const sessionA = deferred<any>();
    const controller = createLauncherController({
        state,
        invoke: async () => undefined,
        isDesktopLauncher: () => false,
        selectedServer: () => state.servers.find((item) => item.id === state.selectedId)!,
        remoteApi: {
            readSession: async (endpoint) =>
                endpoint === a.endpoint
                    ? sessionA.promise
                    : { response: { ok: true }, data: { player: { username: 'B' } } },
            getMaps: async (endpoint) => ({
                response: { ok: true },
                data: { worlds: [{ id: endpoint }] },
            }),
            readLibrary: async () => ({
                response: { ok: true },
                data: { entries: [], libraryEnabled: true },
            }),
        } as any,
    });
    const old = controller.refreshPlayerSession(a);
    state.selectedId = b.id;
    await controller.refreshPlayerSession(b);
    sessionA.resolve({ response: { ok: true }, data: { player: { username: 'A' } } });
    await old;
    assert.equal(state.player?.username, 'B');
    assert.equal(state.worlds[0]?.id, b.endpoint);
});

test('a late response after logout cannot restore a cleared persistent session', async () => {
    const saved = new Map<string, string>();
    const pending = deferred<Response>();
    const sessionStore = {
        read: (endpoint:string) => saved.get(endpoint) || '',
        write: (endpoint:string, cookie:string) => {
            saved.set(endpoint, cookie);
        },
        delete: (endpoint:string) => {
            saved.delete(endpoint);
        },
    };
    const endpoint = 'http://127.0.0.1:3121';
    const transport = createApiTransport({ sessionStore, fetchImpl: async () => pending.promise });
    const request = transport.request({
        endpoint,
        url: endpoint + '/api/auth/login',
        method: 'POST',
    });
    transport.clear(endpoint);
    pending.resolve(
        Response.json({}, { headers: { 'set-cookie': 'box_local_player_session=late; Path=/' } }),
    );
    await request;
    assert.deepEqual(transport.cookies(endpoint), []);
    assert.equal(saved.size, 0);
});

test('server expiry removes stored credentials, but a connection failure does not', async () => {
    const endpoint = 'https://a.example.test';
    const saved = new Map([[endpoint, 'box_local_player_session=fixture']]);
    const sessionStore = {
        read: (endpoint:string) => saved.get(endpoint) || '',
        write: (endpoint:string, cookie:string) => {
            saved.set(endpoint, cookie);
        },
        delete: (endpoint:string) => {
            saved.delete(endpoint);
        },
    };
    const offline = createApiTransport({
        sessionStore,
        fetchImpl: async () => {
            throw new Error('offline');
        },
    });
    await assert.rejects(
        offline.request({ endpoint, url: endpoint + '/api/auth/session', method: 'GET' }),
    );
    assert.equal(saved.size, 1);
    const expired = createApiTransport({
        sessionStore,
        fetchImpl: async () => Response.json({}, { status: 401 }),
    });
    await expired.request({ endpoint, url: endpoint + '/api/auth/session', method: 'GET' });
    assert.equal(saved.size, 0);
});

test('startup verifies the saved session and opens maps without another login', async () => {
    const server = { id: 'a', endpoint: 'https://a.example.test', name: 'A' };
    const state = createInitialState();
    state.selectedId = server.id;
    state.servers = [server];
    const calls:string[] = [];
    const controller = createLauncherController({
        state,
        invoke: async () => undefined,
        isDesktopLauncher: () => false,
        selectedServer: () => server,
        remoteApi: {
            readBootstrap: async () => {
                calls.push('bootstrap');
                return { supported: true, loginRequired: true };
            },
            readSession: async () => {
                calls.push('session');
                return { response: { ok: true }, data: { player: { username: 'A' } } };
            },
            getMaps: async () => {
                calls.push('maps');
                return { response: { ok: true }, data: { worlds: [{ id: 'map-a' }] } };
            },
            readLibrary: async () => ({
                response: { ok: true },
                data: { entries: [], libraryEnabled: true },
            }),
        } as any,
    });
    await controller.restoreSelectedServer();
    assert.deepEqual(calls, ['bootstrap', 'session', 'maps']);
    assert.equal(state.page, 'servers');
    assert.equal(state.player?.username, 'A');
    assert.equal(state.worlds[0].id, 'map-a');
});

test('rapid A -> B -> A clicks ignore both stale bootstrap data and stale failures', async () => {
    const previousDocument = Reflect.get(globalThis, 'document');
    const previousElement = Reflect.get(globalThis, 'Element');
    const handlers = new Map<string, () => Promise<void>>();
    const state = createInitialState();
    state.servers = ['a', 'b'].map((id) => ({
        id,
        endpoint: 'https://' + id + '.example.test',
        name: id,
    }));
    const oldA = deferred<any>();
    const oldB = deferred<any>();
    let aLoads = 0;
    const refreshes:string[] = [];
    class FakeElement {
        public closest() {
            return null;
        }
    }
    Reflect.set(globalThis, 'Element', FakeElement);
    const nodes = state.servers.map((server) => ({
        dataset: { selectServer: server.id },
        addEventListener(_name:string, handler:(event:any) => Promise<void>) {
            handlers.set(server.id, () => handler({ target: new FakeElement() }));
        },
    }));
    Reflect.set(globalThis, 'document', {
        querySelector: () => null,
        querySelectorAll: (selector:string) => (selector === '[data-select-server]' ? nodes : []),
    });
    try {
        bindEvents({
            state,
            remoteApi: {},
            selectedServer: () => state.servers.find((server) => server.id === state.selectedId),
            refreshPlayerSession: async (server) => {
                refreshes.push(server.id);
            },
            render: () => {},
            playerInvoke: async (command, payload) => {
                if (command !== 'get_server_bootstrap') {
                    return undefined;
                }
                if (payload.endpoint.includes('a.example')) {
                    aLoads++;
                    return aLoads === 1
                        ? oldA.promise
                        : { supported: true, serverName: 'latest A' };
                }
                return oldB.promise;
            },
        });
        const firstA = handlers.get('a')!();
        await Promise.resolve();
        const b = handlers.get('b')!();
        await Promise.resolve();
        await handlers.get('a')!();
        oldA.resolve({ supported: true, serverName: 'stale A' });
        oldB.resolve(Promise.reject(new Error('stale B failure')));
        await Promise.all([firstA, b]);
        assert.equal(state.selectedId, 'a');
        assert.equal(state.serverBootstrap?.serverName, 'latest A');
        assert.equal(state.serverBootstrap?.error, undefined);
        assert.deepEqual(refreshes, ['a']);
    } finally {
        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', previousDocument);
        }
        if (previousElement === undefined) {
            Reflect.deleteProperty(globalThis, 'Element');
        } else {
            Reflect.set(globalThis, 'Element', previousElement);
        }
    }
});

test('a successful session response without a player expires a previously logged-in account', async () => {
    const server = { id: 'a', endpoint: 'https://a.example.test', name: 'A' };
    const state = createInitialState();
    state.selectedId = server.id;
    state.player = { username: 'remembered-account' };
    state.serverBootstrap = { supported: true, loginRequired: true } as any;
    const controller = createLauncherController({
        state,
        invoke: async () => undefined,
        isDesktopLauncher: () => false,
        selectedServer: () => server,
        remoteApi: {
            readSession: async () => ({ response: { ok: true }, data: { player: null } }),
        } as any,
    });
    await controller.refreshPlayerSession(server);
    assert.equal(state.player, null);
    assert.equal(state.loginDraft?.username, 'remembered-account');
    assert.equal(state.loginDraft?.password, '');
    assert.equal(state.authError, '登录状态已过期，请重新登录。');
});

test('A -> B -> A rejects the original A maps even when the account is the same', async () => {
    const a = { id: 'a', endpoint: 'https://a.example.test', name: 'A' };
    const b = { id: 'b', endpoint: 'https://b.example.test', name: 'B' };
    const state = createInitialState();
    state.selectedId = a.id;
    const pending = deferred<any>();
    const started = deferred<void>();
    let aMaps = 0;
    const controller = createLauncherController({
        state,
        invoke: async () => undefined,
        isDesktopLauncher: () => false,
        selectedServer: () => (state.selectedId === a.id ? a : b),
        remoteApi: {
            readBootstrap: async () => ({ supported: true, loginRequired: true }),
            readSession: async () => ({
                response: { ok: true },
                data: { player: { username: 'same-account' } },
            }),
            getMaps: async (endpoint:string) => {
                if (endpoint === a.endpoint && ++aMaps === 1) {
                    started.resolve();
                    return pending.promise;
                }
                return { response: { ok: true }, data: { worlds: [{ id: 'latest-map' }] } };
            },
            readLibrary: async () => ({
                response: { ok: true },
                data: { entries: [], libraryEnabled: true },
            }),
        } as any,
    });
    const old = controller.restoreSelectedServer();
    await started.promise;
    state.selectedId = b.id;
    await controller.restoreSelectedServer();
    state.selectedId = a.id;
    await controller.restoreSelectedServer();
    pending.resolve({ response: { ok: true }, data: { worlds: [{ id: 'stale-map' }] } });
    await old;
    assert.equal(state.worlds[0].id, 'latest-map');
});
