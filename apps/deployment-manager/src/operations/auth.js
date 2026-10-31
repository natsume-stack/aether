import { hasWebManagerToken, invoke, setWebManagerToken } from '../infrastructure/transport.js';
import { applySystemStatus, refreshStatus } from './status.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';
import { checkForUpdates } from './updates.js';

export async function submitWebManagerToken(event) {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get('token') || '').trim();
    const error = document.querySelector('#web-login-error');
    if (error) {
        error.textContent = '';
    }
    setWebManagerToken(token);
    try {
        const status = await invoke('get_system_status');
        applySystemStatus(status);
        state.page = 'overview';
        // Show the authenticated console before unrelated metadata loads finish.
        render();
        await refreshStatus();
        checkForUpdates();
    } catch (failure) {
        setWebManagerToken('');
        state.page = 'web-login';
        render();
        const loginError = document.querySelector('#web-login-error');
        if (loginError) {
            loginError.textContent = String(failure.message || failure);
        }
    }
}

export function startWebManager() {
    if (!hasWebManagerToken()) {
        state.page = 'web-login';
        render();
        return;
    }
    // A rotated or expired token must return to the gate. Without this check the
    // console renders as if Docker were unreachable, which hides the real cause.
    invoke('get_system_status')
        .then(async (status) => {
            applySystemStatus(status);
            state.page = 'overview';
            render();
            await refreshStatus();
            checkForUpdates();
        })
        .catch(() => {
            setWebManagerToken('');
            state.page = 'web-login';
            render();
        });
}
