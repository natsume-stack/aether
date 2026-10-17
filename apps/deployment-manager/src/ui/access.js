import { hasWebManagerToken, isWebManager } from '../infrastructure/transport.js';
import { resetOwnerSecretState, state } from '../core/state.js';

export function normalizeAccessiblePage() {
    if (isWebManager() && !hasWebManagerToken()) {
        if (!['web-login', 'about'].includes(state.page)) {
            state.page = 'web-login';
        }
        resetOwnerSecretState();
        return;
    }
    if (state.page === 'runtimes' && state.status && !runtimeServiceRunning()) {
        state.page = 'overview';
    }
}

function runtimeServiceRunning() {
    return Boolean(
        state.status?.services?.some(
            (service) => ['creator', 'play'].includes(service.name) && service.running,
        ),
    );
}
