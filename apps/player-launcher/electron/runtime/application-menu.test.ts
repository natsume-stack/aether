import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installEditingShortcuts } from './application-menu';

import type { WebContents, Input } from 'electron';

test('hidden-menu editing shortcuts use each platform modifier and preserve unrelated keys', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
        let listener:(event:{ preventDefault():void }, input:Input) => void;
        const commands:string[] = [];
        let prevented = 0;
        const contents = {
            on(name, callback) {
                assert.equal(name, 'before-input-event');
                listener = callback;
            },
            ...Object.fromEntries(
                ['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo', 'pasteAndMatchStyle'].map(
                    (command) => [command, () => commands.push(command)],
                ),
            ),
        };
        installEditingShortcuts(contents as unknown as WebContents, platform);
        const send = (key:string, overrides = {}) =>
            listener(
                {
                    preventDefault() {
                        prevented += 1;
                    },
                },
                {
                    type: 'keyDown',
                    key,
                    meta: platform === 'darwin',
                    control: platform !== 'darwin',
                    alt: false,
                    shift: false,
                    ...overrides,
                } as Input,
            );
        for (const key of ['c', 'v', 'x', 'a', 'z']) {
            send(key);
        }
        send('z', { shift: true });
        send('v', { shift: true });
        assert.deepEqual(commands, [
            'copy',
            'paste',
            'cut',
            'selectAll',
            'undo',
            'redo',
            'pasteAndMatchStyle',
        ]);
        for (const [key, overrides] of [
            ['c', { meta: false, control: false }],
            ['c', { alt: true }],
            ['c', { type: 'keyUp' }],
            ['r', {}],
            ['c', { shift: true }],
        ] as const) {
            send(key, overrides);
        }
        assert.equal(prevented, 7);
    }
});
