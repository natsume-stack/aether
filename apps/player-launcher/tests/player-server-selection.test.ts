import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindEvents } from '../src/events';

test('clicking the server that is already selected on its page does not refresh it', async () => {
    const originalDocument = Reflect.get(globalThis, 'document');
    const originalElement = Reflect.get(globalThis, 'Element');
    let clickHandler:((event:{ target:Element }) => Promise<void>) | undefined;
    const serverButton = {
        dataset: { selectServer: 'server-one' },
        addEventListener(_name:string, listener:(event:{ target:Element }) => Promise<void>) {
            clickHandler = listener;
        },
    };
    class TestElement {
        public closest() {
            return null;
        }
    }
    Reflect.set(globalThis, 'Element', TestElement);
    Reflect.set(globalThis, 'document', {
        querySelector: () => null,
        querySelectorAll: (selector:string) =>
            selector === '[data-select-server]' ? [serverButton] : [],
    });

    const state = {
        servers: [{ id: 'server-one', endpoint: 'http://127.0.0.1:3121', name: '本机' }],
        selectedId: 'server-one',
        page: 'servers',
        busy: false,
        player: { username: 'fixture-player' },
        worlds: [{ id: 'map-one', name: '测试地图' }],
        playerMenuOpen: true,
        playerSettingsOpen: true,
        editingServerId: 'server-one',
        serverNameInput: '本地备注',
        serverBootstrap: { supported: true },
        error: 'existing error',
        notice: 'existing notice',
    };
    let invokeCount = 0;
    let refreshCount = 0;
    let renderCount = 0;

    try {
        bindEvents({
            state,
            playerInvoke: async () => {
                invokeCount += 1;
                return { supported: true };
            },
            remoteApi: {},
            selectedServer: () => state.servers[0],
            refreshPlayerSession: async () => {
                refreshCount += 1;
            },
            render: () => {
                renderCount += 1;
            },
        });
        assert.ok(clickHandler, 'server row click handler should be bound');
        await clickHandler?.({ target: new TestElement() as unknown as Element });
    } finally {
        if (originalDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', originalDocument);
        }
        if (originalElement === undefined) {
            Reflect.deleteProperty(globalThis, 'Element');
        } else {
            Reflect.set(globalThis, 'Element', originalElement);
        }
    }

    assert.equal(invokeCount, 0);
    assert.equal(refreshCount, 0);
    assert.equal(renderCount, 0);
    assert.equal(state.player?.username, 'fixture-player');
    assert.equal(state.worlds.length, 1);
    assert.equal(state.serverBootstrap?.supported, true);
    assert.equal(state.error, 'existing error');
    assert.equal(state.notice, 'existing notice');
});

test('opening the already-selected server from home loads its missing bootstrap', async () => {
    const originalDocument = Reflect.get(globalThis, 'document');
    const originalElement = Reflect.get(globalThis, 'Element');
    const server = { id: 'server-one', endpoint: 'http://127.0.0.1:3121', name: '本机' };
    let clickHandler:((event:{ target:Element }) => Promise<void>) | undefined;
    const serverButton = {
        dataset: { selectServer: server.id },
        addEventListener(_name:string, listener:(event:{ target:Element }) => Promise<void>) {
            clickHandler = listener;
        },
    };
    class TestElement {
        public closest() {
            return null;
        }
    }
    Reflect.set(globalThis, 'Element', TestElement);
    Reflect.set(globalThis, 'document', {
        querySelector: () => null,
        querySelectorAll: (selector:string) =>
            selector === '[data-select-server]' ? [serverButton] : [],
    });

    const state = {
        servers: [server],
        selectedId: server.id,
        page: 'home',
        busy: false,
        player: null,
        worlds: [],
        playerMenuOpen: false,
        playerSettingsOpen: false,
        editingServerId: '',
        serverNameInput: '',
        serverBootstrap: null,
        error: '',
        notice: '',
    };
    const commands:string[] = [];
    let refreshCount = 0;
    try {
        bindEvents({
            state,
            playerInvoke: async (command:string) => {
                commands.push(command);
                return { supported: true, loginRequired: true };
            },
            remoteApi: {},
            selectedServer: () => server,
            refreshPlayerSession: async () => {
                refreshCount += 1;
            },
            render: () => {},
        });
        assert.ok(clickHandler, 'server row click handler should be bound');
        await clickHandler?.({ target: new TestElement() as unknown as Element });
    } finally {
        if (originalDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', originalDocument);
        }
        if (originalElement === undefined) {
            Reflect.deleteProperty(globalThis, 'Element');
        } else {
            Reflect.set(globalThis, 'Element', originalElement);
        }
    }

    assert.equal(state.page, 'servers');
    assert.deepEqual(commands, ['get_server_bootstrap']);
    assert.equal(state.serverBootstrap?.supported, true);
    assert.equal(refreshCount, 1);
});
