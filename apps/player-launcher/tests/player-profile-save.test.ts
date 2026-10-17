import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bindPlayerAccountEvents } from '../src/features/player/account-events';
import { createInitialState } from '../src/application/state';

test('successful profile save closes the dialog and releases the saving state', async () => {
    const previousDocument = Reflect.get(globalThis, 'document');
    const previousFormData = Reflect.get(globalThis, 'FormData');
    let submit:(event:unknown) => Promise<void>;
    const form = {
        addEventListener(name, callback) {
            if (name === 'submit') {
                submit = callback;
            }
        },
    };
    Reflect.set(globalThis, 'document', {
        querySelector: (selector) => (selector === '#player-profile-form' ? form : null),
        querySelectorAll: () => [],
    });
    Reflect.set(
        globalThis,
        'FormData',
        class {
            public get() {
                return 'Fish';
            }
        },
    );
    try {
        const state = createInitialState();
        state.selectedId = 'server';
        state.player = { username: 'fish', displayName: 'fish', avatarSkinId: 'explorer' };
        state.playerSettingsOpen = true;
        state.playerProfileSkinId = 'cowboy';
        const savedPlayer = { username: 'fish', displayName: 'Fish', avatarSkinId: 'cowboy' };
        const rendered:{ busy:boolean; open:boolean }[] = [];
        bindPlayerAccountEvents({
            state,
            selectedServer: () => ({
                id: 'server',
                name: 'Play',
                endpoint: 'http://engine.test/abc',
            }),
            playerInvoke: async () => {},
            remoteApi: {
                updateProfile: async () => ({
                    response: { ok: true, status: 200 },
                    data: { player: savedPlayer },
                }),
            } as any,
            render: () => rendered.push({ busy: state.busy, open: state.playerSettingsOpen }),
        });
        await submit({ preventDefault() {}, currentTarget: form });
        assert.equal(state.player, savedPlayer);
        assert.equal(
            state.busy,
            false,
            'a new player object returned by the API must not leave the UI stuck saving',
        );
        assert.equal(state.playerSettingsOpen, false);
        assert.deepEqual(rendered.at(-1), { busy: false, open: false });
        assert.equal(state.notice, '账号设置已保存。');
    } finally {
        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis, 'document');
        } else {
            Reflect.set(globalThis, 'document', previousDocument);
        }
        if (previousFormData === undefined) {
            Reflect.deleteProperty(globalThis, 'FormData');
        } else {
            Reflect.set(globalThis, 'FormData', previousFormData);
        }
    }
});
