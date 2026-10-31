import {
    openExternalNginxDialog,
    closeExternalNginxDialog,
} from '../../operations/external-nginx.js';
import { isPublicMode, publicEndpoints } from '../../configuration/public-access.js';
import { captureSetupForm, switchSetupSection } from '../../configuration/form.js';
import { clearFeedback } from '../../operations/feedback.js';
import { copyOwnerSecret, toggleOwnerSecretEditor } from '../../operations/owner-secrets.js';
import { copyText } from '../../utils/clipboard.js';
import {
    installManagedService,
    loadRawNginxConfig,
    reloadRawEnvironment,
    reloadRawNginxConfig,
    relocateDataStorage,
    saveConfiguration,
    saveRawEnvironment,
    saveRawNginxConfig,
    testConnection,
} from '../../operations/configuration.js';
import { render } from '../../core/render-request.js';
import { state } from '../../core/state.js';
import { restoreDefaultAuthPortalImage } from '../../operations/auth-portal.js';
import {
    applySsl,
    exportSsl,
    captureSslDraft,
    refreshSsl,
    selectSslFile,
    chooseCertificateInput,
    setCertificatePath,
    stopSsl,
    chooseNginx,
    downloadNginx,
    enableNginx,
    reloadNginx,
    deleteSslCertificate,
} from '../../operations/ssl.js';

export function bindConfigurationEvents() {
    document
        .querySelector('#open-external-nginx-dialog')
        ?.addEventListener('click', openExternalNginxDialog);
    document
        .querySelector('#close-external-nginx-dialog')
        ?.addEventListener('click', closeExternalNginxDialog);
    document.querySelector('[data-external-nginx-dismiss]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
            closeExternalNginxDialog();
        }
    });
    const panel = document.querySelector('.external-nginx-dialog');
    panel?.focus();
    panel?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeExternalNginxDialog();
        }
        if (event.key !== 'Tab') {
            return;
        }
        const controls = [...panel.querySelectorAll('button:not(:disabled), summary')];
        const first = controls[0],
            last = controls.at(-1);
        if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === panel)
        ) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    });

    if (state.page !== 'setup' || state.setupSection !== 'network') {
        state.sslFiles = {};
    }
    for (const [id, handler] of [
        ['ssl-apply', applySsl],
        ['ssl-export', exportSsl],
        ['ssl-stop', stopSsl],
        ['ssl-apply-network', applySsl],
        ['nginx-download', downloadNginx],
        ['nginx-enable', enableNginx],
        ['nginx-reload', reloadNginx],
    ]) {
        document.querySelector(`#${id}`)?.addEventListener('click', handler);
    }
    document.querySelectorAll('[data-external-guide-protocol]').forEach((node) =>
        node.addEventListener('click', () => {
            captureSetupForm();
            const protocol = node.dataset.externalGuideProtocol;
            state.externalGuideProtocol = protocol;
            const fields =
                state.config.publicAddressMode === 'shared'
                    ? ['sharedPublicAddress']
                    : [
                          'playPublicAddressOverride',
                          'creatorPublicAddressOverride',
                          'voxaPublicAddressOverride',
                          'playerServicePublicAddressOverride',
                          'authPortalPublicAddressOverride',
                      ];
            for (const field of fields) {
                if (/^https?:\/\//i.test(state.config[field] || '')) {
                    state.config[field] = state.config[field].replace(
                        /^https?:\/\//i,
                        `${protocol}://`,
                    );
                }
            }
            render();
        }),
    );
    document.querySelectorAll('[data-copy-example]').forEach((node) =>
        node.addEventListener('click', async () => {
            const code = document.getElementById(node.dataset.copyExample)?.textContent;
            if (!code) {
                return;
            }
            try {
                await copyText(code);
                node.textContent = '已复制';
            } catch (error) {
                state.error = String(error);
                render();
            }
        }),
    );
    document
        .querySelectorAll('[data-ssl-input-mode]')
        .forEach((node) =>
            node.addEventListener('click', () =>
                chooseCertificateInput(node.dataset.sslInputService, node.dataset.sslInputMode),
            ),
        );
    document
        .querySelectorAll('[data-ssl-cert-path]')
        .forEach((node) =>
            node.addEventListener('input', () =>
                setCertificatePath(node.dataset.sslCertPath, 'certificatePath', node.value),
            ),
        );
    document
        .querySelectorAll('[data-ssl-key-path]')
        .forEach((node) =>
            node.addEventListener('input', () =>
                setCertificatePath(node.dataset.sslKeyPath, 'privateKeyPath', node.value),
            ),
        );
    document.querySelectorAll('[data-ssl-kind]').forEach((node) =>
        node.addEventListener('change', async (event) => {
            const valid = await selectSslFile(
                node.dataset.sslKind,
                event.target.files?.[0],
                node.dataset.sslService,
            );
            const name =
                state.sslFiles?.[node.dataset.sslService]?.[
                    node.dataset.sslKind === 'certificate' ? 'certificateName' : 'keyName'
                ];
            if (valid && name) {
                node.closest('label').querySelector('.file-picker-name').textContent = name;
                try {
                    const endpoints = publicEndpoints();
                    document.querySelectorAll('[data-public-preview]').forEach((preview) => {
                        const endpoint = endpoints.find(
                            (endpoint) => endpoint.service === preview.dataset.publicPreview,
                        );
                        if (endpoint) {
                            preview.querySelector('code').textContent = endpoint.url;
                        }
                    });
                } catch {}
            }
        }),
    );
    document
        .querySelectorAll('[data-nginx-mode]')
        .forEach((node) =>
            node.addEventListener('click', () => chooseNginx(node.dataset.nginxMode)),
        );
    document
        .querySelectorAll('[data-delete-ssl]')
        .forEach((node) =>
            node.addEventListener('click', () => deleteSslCertificate(node.dataset.deleteSsl)),
        );
    document
        .querySelectorAll(
            '[name="sharedPublicAddress"], [name^="publicPath-"], [name$="PublicAddressOverride"], [name="playPort"], [name="creatorPort"], [name="voxaPort"], [name="playerServicePort"], [name="authPortalPort"]',
        )
        .forEach((node) =>
            node.addEventListener('input', () => {
                captureSetupForm();
                try {
                    const endpoints = publicEndpoints();
                    document.querySelectorAll('[data-public-preview]').forEach((preview) => {
                        const endpoint = endpoints.find(
                            (item) => item.service === preview.dataset.publicPreview,
                        );
                        if (endpoint) {
                            preview.querySelector('code').textContent = endpoint.url;
                        }
                    });
                } catch {}
            }),
        );
    if (
        state.page === 'setup' &&
        ['network', 'data'].includes(state.setupSection) &&
        !state.sslLoaded
    ) {
        void refreshSsl();
    }
    document
        .querySelector('#restore-default-login-image')
        ?.addEventListener('click', restoreDefaultAuthPortalImage);
    document
        .querySelectorAll('[data-install-managed]')
        .forEach((node) =>
            node.addEventListener('click', () =>
                installManagedService(node.dataset.installManaged),
            ),
        );

    document.querySelectorAll('[data-copy-managed]').forEach((node) =>
        node.addEventListener('click', async () => {
            await copyText(node.dataset.copyManaged);
            node.classList.add('copied');
            node.title = '已复制';
        }),
    );

    document.querySelector('#setup-form')?.addEventListener('submit', saveConfiguration);

    document
        .querySelector('[data-save-raw-environment]')
        ?.addEventListener('click', saveRawEnvironment);

    document
        .querySelector('#reload-raw-environment')
        ?.addEventListener('click', reloadRawEnvironment);

    document.querySelector('[data-save-raw-nginx]')?.addEventListener('click', saveRawNginxConfig);

    document.querySelector('#reload-raw-nginx')?.addEventListener('click', reloadRawNginxConfig);

    document
        .querySelectorAll('[data-secret-edit]')
        .forEach((node) =>
            node.addEventListener(
                'click',
                () => void toggleOwnerSecretEditor(node.dataset.secretEdit),
            ),
        );

    document
        .querySelectorAll('[data-secret-copy]')
        .forEach((node) =>
            node.addEventListener('click', () => void copyOwnerSecret(node.dataset.secretCopy)),
        );

    document.querySelector('#choose-data-storage')?.addEventListener('click', relocateDataStorage);

    document
        .querySelectorAll('[data-test-connection]')
        .forEach((node) =>
            node.addEventListener('click', () => testConnection(node.dataset.testConnection)),
        );

    document.querySelectorAll('[data-setup-section]').forEach((node) =>
        node.addEventListener('click', (event) => {
            // These tabs live in a form. Keep the interaction explicit so a WebView
            // never treats a tab click as an implicit form action, and preserve any
            // values already typed before changing the visible section.
            event.preventDefault();
            switchSetupSection(node.dataset.setupSection);
            if (node.dataset.setupSection === 'nginx' && !state.nginxConfigLoaded) {
                void loadRawNginxConfig();
            }
        }),
    );

    document.querySelectorAll('[data-database-mode]').forEach((node) =>
        node.addEventListener('click', () => {
            captureSetupForm();
            const mode = node.dataset.databaseMode;
            if (!mode) {
                return;
            }
            state.config.databaseMode = mode;
            if (mode === 'external' && state.config.databaseHost === 'managed-postgres') {
                state.config.databasePassword = '';
                state.config.hasDatabasePassword = false;
            }
            clearFeedback();
            render();
        }),
    );

    document.querySelectorAll('[data-redis-mode]').forEach((node) =>
        node.addEventListener('click', () => {
            captureSetupForm();
            const mode = node.dataset.redisMode;
            if (!mode) {
                return;
            }
            state.config.redisMode = mode;
            if (mode === 'external' && state.config.redisHost === 'managed-redis') {
                state.config.redisPassword = '';
                state.config.hasRedisPassword = false;
            }
            clearFeedback();
            render();
        }),
    );

    document.querySelectorAll('[data-network-mode]').forEach((node) =>
        node.addEventListener('click', () => {
            captureSetupForm();
            const mode = node.dataset.networkMode;
            if (!mode) {
                return;
            }
            state.config.playNetworkMode = isPublicMode(mode) ? 'public' : mode;
            state.config.creatorNetworkMode = isPublicMode(mode) ? 'public' : mode;
            if (mode === 'public-shared') {
                state.config.publicAddressMode = 'shared';
                if (!state.config.sharedPublicAddress && state.config.playPublicAddressOverride) {
                    try {
                        const endpoint = publicEndpoints({
                            ...state.config,
                            publicAddressMode: 'independent',
                        }).find((route) => route.service === 'play');
                        if (endpoint) {
                            state.config.sharedPublicAddress = new URL(endpoint.url).origin;
                        }
                    } catch {}
                }
            } else if (isPublicMode(mode)) {
                state.config.publicAddressMode = 'independent';
            }
            if (!isPublicMode(mode)) {
                state.sslFiles = {};
            }
            state.accessMode = mode;
            render();
        }),
    );
}
