import test from 'node:test';
import assert from 'node:assert/strict';

import { bindMapSearch } from '../src/features/maps/search-events';

import type { PlayerLauncherState } from '../src/types';

class FakeInput {
    public value = '';
    private listeners = new Map<string, (event:Event) => void>();
    public addEventListener(type:string, listener:EventListenerOrEventListenerObject | null):void {
        if (typeof listener === 'function') {
            this.listeners.set(type, listener);
        }
    }
    public dispatch(type:string, init:Partial<InputEvent> = {}):void {
        this.listeners.get(type)?.({ isComposing: false, ...init } as Event);
    }
}

test('map search does not replace its input during Chinese IME composition', async () => {
    const input = new FakeInput();
    const state = { mapSearch: '' } as PlayerLauncherState;
    let renders = 0;
    bindMapSearch(input, state, () => renders++);

    input.dispatch('compositionstart');
    input.value = '星';
    input.dispatch('input', { isComposing: true });
    input.value = '星梦';
    input.dispatch('input', { isComposing: true });
    assert.equal(state.mapSearch, '星梦');
    assert.equal(renders, 0);

    input.dispatch('compositionend');
    input.value = '星梦小镇';
    input.dispatch('input');
    assert.equal(renders, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.mapSearch, '星梦小镇');
    assert.equal(renders, 1);
});

test('map search still filters immediately for ordinary typing', () => {
    const input = new FakeInput();
    const state = { mapSearch: '' } as PlayerLauncherState;
    let renders = 0;
    bindMapSearch(input, state, () => renders++);
    input.value = 'town';
    input.dispatch('input');
    assert.equal(state.mapSearch, 'town');
    assert.equal(renders, 1);
});
