import { dismissFeedback } from '../../operations/feedback.js';
import {
    hasWebManagerToken,
    isWebManager,
    setWebManagerToken,
} from '../../infrastructure/transport.js';
import { loadBackups } from '../../operations/backups.js';
import { loadLegalNotices } from '../../operations/legal.js';
import { refreshManagedServiceInfo } from '../../operations/status.js';
import {
    refreshMapRuntimeProfiles,
    scheduleProjectRuntimeRefresh,
} from '../../operations/runtimes.js';
import { render } from '../../core/render-request.js';
import { resetOwnerSecretState, state } from '../../core/state.js';
import { submitWebManagerToken } from '../../operations/auth.js';

export function bindNavigationEvents() {
    document.querySelectorAll('[data-page]').forEach((node) =>
        node.addEventListener('click', () => {
            if (
                isWebManager() &&
                !hasWebManagerToken() &&
                !['web-login', 'about'].includes(node.dataset.page)
            ) {
                state.page = 'web-login';
                render();
                return;
            }
            if (node.dataset.page !== 'setup') {
                resetOwnerSecretState();
            }
            state.page = node.dataset.page;
            if (state.page === 'runtimes' && !state.projectRuntimesLoaded) {
                state.projectRuntimesLoading = true;
            }
            render();
            if (state.page === 'backups') {
                loadBackups();
            }
            if (state.page === 'about') {
                loadLegalNotices();
            }
            if (state.page === 'setup') {
                refreshManagedServiceInfo();
            }
            if (state.page === 'runtimes') {
                scheduleProjectRuntimeRefresh();
                if (!state.mapRuntimeProfilesLoaded) {
                    void refreshMapRuntimeProfiles();
                }
            }
        }),
    );

    document.querySelector('[data-dismiss-feedback]')?.addEventListener('click', dismissFeedback);

    document.querySelector('#web-logout')?.addEventListener('click', () => {
        setWebManagerToken('');
        state.page = 'web-login';
        state.status = null;
        state.config = null;
        state.about = null;
        state.legal = null;
        state.environmentFile = '';
        state.environmentFileLoaded = false;
        state.nginxConfigFile = '';
        state.nginxConfigLoaded = false;
        resetOwnerSecretState();
        state.backups = [];
        state.performance = null;
        state.projectRuntimes = { creator: [], play: [] };
        state.projectRuntimesLoaded = false;
        state.error = '';
        state.notice = '';
        render();
    });

    document.querySelector('#web-login-form')?.addEventListener('submit', submitWebManagerToken);

    document.querySelector('#web-login-form input')?.focus();
}
