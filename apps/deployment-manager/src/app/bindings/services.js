import { copyText } from '../../utils/clipboard.js';
import { dockerPlatform, openExternal } from '../../infrastructure/transport.js';
import { recheckDocker, runAction, startDockerDesktop } from '../../operations/overview.js';
import { render } from '../../core/render-request.js';
import { state } from '../../core/state.js';
import { refreshStatus } from '../../operations/status.js';

function closeServiceMenuOnOutside(event) {
    if (!state.serviceMenu) {
        return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('.service-more')) {
        return;
    }
    state.serviceMenu = '';
    render();
}

export function bindServicesEvents() {
    document.removeEventListener('click', closeServiceMenuOnOutside);

    document.addEventListener('click', closeServiceMenuOnOutside);

    document.querySelector('#refresh-service-status')?.addEventListener('click', () => {
        if (!state.busy) {
            void refreshStatus();
        }
    });

    document.querySelector('#connect-docker')?.addEventListener('click', () => {
        void (dockerPlatform().canStart ? startDockerDesktop() : recheckDocker());
    });

    document.querySelector('#start')?.addEventListener('click', () => {
        state.startMenuOpen = true;
        render();
    });

    document.querySelectorAll('[data-start-scope]').forEach((node) =>
        node.addEventListener('click', () => {
            const scope = node.dataset.startScope;
            if (!scope) {
                return;
            }
            if (state.startScopes.has(scope)) {
                state.startScopes.delete(scope);
            } else {
                state.startScopes.add(scope);
            }
            render();
        }),
    );

    document.querySelector('#confirm-start-scopes')?.addEventListener('click', () => {
        const scope = state.startScopes.size > 1 ? 'all' : [...state.startScopes][0];
        if (!scope) {
            return;
        }
        void runAction('start_services', { scope });
    });

    document.querySelector('#cancel-start')?.addEventListener('click', () => {
        state.startMenuOpen = false;
        render();
    });

    document.querySelector('[data-start-dialog-dismiss]')?.addEventListener('click', (event) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        state.startMenuOpen = false;
        render();
    });

    document.querySelector('#stop')?.addEventListener('click', () => runAction('stop_services'));

    document.querySelectorAll('[data-open]').forEach((node) =>
        node.addEventListener('click', async () => {
            try {
                await openExternal(node.dataset.open);
            } catch (error) {
                state.error = String(error);
                render();
            }
        }),
    );

    document.querySelectorAll('[data-copy-url]').forEach((node) =>
        node.addEventListener('click', async () => {
            await copyText(node.dataset.copyUrl);
            node.title = '已复制';
        }),
    );

    document.querySelectorAll('[data-service-action]').forEach((node) =>
        node.addEventListener('click', () => {
            state.serviceMenu = '';
            runAction('control_service', {
                service: node.dataset.service,
                action: node.dataset.serviceAction,
            });
        }),
    );

    document.querySelectorAll('[data-service-menu]').forEach((node) =>
        node.addEventListener('click', () => {
            state.serviceMenu =
                state.serviceMenu === node.dataset.serviceMenu ? '' : node.dataset.serviceMenu;
            render();
        }),
    );
}
