import type { PlayerLauncherState } from '../../types';

type SearchInput = Pick<HTMLInputElement, 'value' | 'addEventListener'>;

/** Keep the input node alive until IME composition commits its final text. */
export function bindMapSearch(
    input:SearchInput,
    state:PlayerLauncherState,
    render:() => void,
):void {
    let composing = false;
    let compositionCommitTimer:ReturnType<typeof setTimeout> | undefined;
    const commit = () => {
        state.mapSearch = input.value;
        render();
    };

    input.addEventListener('compositionstart', () => {
        composing = true;
    });
    input.addEventListener('compositionend', () => {
        composing = false;
        if (compositionCommitTimer !== undefined) {
            clearTimeout(compositionCommitTimer);
        }
        // Some IMEs dispatch one last input event after compositionend. Defer the
        // redraw so it cannot replace the input while that committed text arrives.
        compositionCommitTimer = setTimeout(() => {
            compositionCommitTimer = undefined;
            commit();
        }, 0);
    });
    input.addEventListener('input', (event) => {
        state.mapSearch = input.value;
        if (
            composing ||
            (event as InputEvent).isComposing ||
            compositionCommitTimer !== undefined
        ) {
            return;
        }
        render();
    });
}
