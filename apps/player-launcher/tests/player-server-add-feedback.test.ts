import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindEvents } from '../src/events';
import { SERVER_ADDRESS_HELP_TEXT } from '../src/features/servers/address-notice';
import { bindServerEvents } from '../src/features/servers/events';

test('rechecking a stopped server displays clean copy and restores the retry button', async () => {
    const originalDocument = Reflect.get(globalThis, 'document');
    let discover:(() => void) | undefined;
    const button = {
        addEventListener(_name:string, listener:() => void) {
            discover = listener;
        },
    };
    Reflect.set(globalThis, 'document', {
        querySelector: (selector:string) =>
            selector === '[data-action="discover"]' ? button : null,
        querySelectorAll: () => [],
    });
    const state = { busy: false, serverBootstrap: {} as { loading?:boolean; error?:string } };
    let completed:() => void;
    const done = new Promise<void>((resolve) => {
        completed = resolve;
    });
    try {
        bindServerEvents({
            state,
            playerInvoke: async () => {
                throw new Error(
                    "Error invoking remote method 'launcher:invoke': Error: 服务器服务未启动或连接端口不可用",
                );
            },
            remoteApi: {},
            selectedServer: () => ({ endpoint: 'http://127.0.0.1:3121' }),
            refreshPlayerSession: async () => {
                assert.fail('must not load a session after connection failure');
            },
            render: () => {
                if (!state.busy) {
                    completed();
                }
            },
        });
        assert.ok(discover);
        discover();
        assert.equal(state.serverBootstrap.loading, true);
        await done;
        assert.equal(state.busy, false);
        assert.equal(
            state.serverBootstrap.error,
            '无法连接游玩服务，请确认服务已启动、地址和端口正确后重新检查。',
        );
        assert.doesNotMatch(state.serverBootstrap.error, /launcher:invoke|Error:/);
    } finally {
        if (originalDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', originalDocument);
        }
    }
});

test('shows a clean connection error when an invalid server address cannot be reached', async () => {
    const originalDocument = Reflect.get(globalThis, 'document');
    const originalFormData = Reflect.get(globalThis, 'FormData');
    const form = {
        addEventListener(_name:string, listener:(event:unknown) => Promise<void>) {
            submit = listener;
        },
    };
    let submit:((event:unknown) => Promise<void>) | undefined;
    class TestFormData {
        public get(name:string) {
            return name === 'endpoint' ? '撒打算大' : null;
        }
    }
    Reflect.set(globalThis, 'FormData', TestFormData);
    Reflect.set(globalThis, 'document', {
        querySelector: (selector:string) => (selector === '#server-form' ? form : null),
        querySelectorAll: () => [],
    });

    const state = { endpointInput: '', error: '', notice: '', busy: false, page: 'add-server' };
    try {
        bindEvents({
            state,
            playerInvoke: async () => {
                throw new Error(
                    "Error invoking remote method 'launcher:invoke': Error: 无法连接到游玩端服务器，请检查地址和网络",
                );
            },
            remoteApi: {},
            selectedServer: () => null,
            refreshPlayerSession: async () => {},
            render: () => {},
        });
        assert.ok(submit, 'server address form should bind its submit handler');
        await submit?.({ preventDefault() {}, currentTarget: form });
    } finally {
        if (originalDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', originalDocument);
        }
        if (originalFormData === undefined) {
            Reflect.deleteProperty(globalThis, 'FormData');
        } else {
            Reflect.set(globalThis, 'FormData', originalFormData);
        }
    }

    assert.equal(state.error, '无法连接到游玩端服务器，请检查地址、端口和网络后重试。');
    assert.doesNotMatch(state.error, /Error invoking remote method|^Error:/);
});

test('explains HTTP and IP address reminders in the add-server helper text', () => {
    assert.match(SERVER_ADDRESS_HELP_TEXT, /本机地址默认 HTTP/);
    assert.match(SERVER_ADDRESS_HELP_TEXT, /公网地址建议使用 HTTPS/);
});
