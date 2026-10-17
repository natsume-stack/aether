import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindServerEvents } from '../src/features/servers/events';
import { createInitialState } from '../src/application/state';
import { expirePlayerSession } from '../src/features/player/session';

for (const entry of ['refresh', 'add'] as const) {
    for (const result of ['failure', 'success'] as const) {
        test(`stale ${entry} ${result} cannot overwrite A after A -> B -> C -> A or release newer busy state`, async () => {
            const previousDocument = Reflect.get(globalThis, 'document');
            const previousElement = Reflect.get(globalThis, 'Element');
            const state = createInitialState();
            state.servers = ['a', 'b', 'c'].map((id) => ({
                id,
                endpoint: 'https://' + id + '.example.test',
                name: id,
            }));
            state.selectedId = 'a';
            state.page = 'servers';
            state.player = { username: 'fixture' };
            state.serverBootstrap = { supported: true } as any;
            let rejectOld!:(error:Error) => void;
            let resolveOld!:(value:any) => void;
            const pending = new Promise((resolve, reject) => {
                rejectOld = reject;
                resolveOld = resolve;
            });
            let first = true;
            let discovery!:() => void;
            let addition!:() => Promise<void>;
            const clicks = new Map<string, () => Promise<void>>();
            class FakeElement {
                public closest() {
                    return null;
                }
            }
            Reflect.set(globalThis, 'Element', FakeElement);
            const nodes = state.servers.map((server) => ({
                dataset: { selectServer: server.id },
                addEventListener(_name, handler) {
                    clicks.set(server.id, () => handler({ target: new FakeElement() }));
                },
            }));
            Reflect.set(globalThis, 'document', {
                querySelector: (selector) => {
                    if (selector === '[data-action="discover"]') {
                        return {
                            addEventListener(_name, handler) {
                                discovery = handler;
                            },
                        };
                    }
                    if (selector === '[data-confirm-server-address]') {
                        return {
                            addEventListener(_name, handler) {
                                addition = handler;
                            },
                        };
                    }
                    return null;
                },
                querySelectorAll: (selector) => (selector === '[data-select-server]' ? nodes : []),
            });
            try {
                bindServerEvents({
                    state,
                    remoteApi: {},
                    render: () => {},
                    selectedServer: () =>
                        state.servers.find((server) => server.id === state.selectedId),
                    refreshPlayerSession: async () => {},
                    playerInvoke: async (command, payload) => {
                        if (command === 'add_server') {
                            return state.servers[0];
                        }
                        if (command !== 'get_server_bootstrap') {
                            return;
                        }
                        if (first) {
                            first = false;
                            return pending;
                        }
                        return { supported: true, serverName: payload.endpoint };
                    },
                });
                state.pendingServerEndpoint = state.servers[0].endpoint;
                const operation = entry === 'refresh' ? discovery() : addition();
                await new Promise((resolve) => setImmediate(resolve));
                // A delayed library/session 401 is an actual path that releases the busy flag.
                expirePlayerSession(state, 'a');
                await clicks.get('b')!();
                await clicks.get('c')!();
                await clicks.get('a')!();
                assert.equal(state.serverBootstrap?.supported, true);
                state.busy = true; // A newer action owns this flag; the old finally must not release it.
                if (result === 'failure') {
                    rejectOld(new Error('服务器连接被中断'));
                } else {
                    resolveOld({ supported: true, serverName: 'stale response' });
                }
                await operation;
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(state.selectedId, 'a');
                assert.equal(state.serverBootstrap?.supported, true);
                assert.equal(state.serverBootstrap?.error, undefined);
                assert.equal(state.serverBootstrap?.serverName, state.servers[0].endpoint);
                assert.equal(state.busy, true);
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
    }
}
