import { clearFeedback } from '../operations/feedback.js';
import { numericConfigFields, ownerSecretKeys } from '../core/constants.js';
import { render } from '../core/render-request.js';
import { resetOwnerSecretState, state } from '../core/state.js';
import { isPublicMode } from './public-access.js';
import { normalizeAuthPortalImage } from './auth-portal-image.js';

export function captureSetupForm() {
    const form = document.querySelector('#setup-form');
    if (!form) {
        return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    for (const key of ownerSecretKeys) {
        if (values[key] === state.ownerSecrets?.[key]) {
            delete values[key];
        }
    }
    const databaseSsl = form.elements.namedItem('databaseSsl');
    const autoBackupEnabled = form.elements.namedItem('autoBackupEnabled');
    const registrationEnabled = form.elements.namedItem('registrationEnabled');
    const next = {
        ...state.config,
        ...values,
        publicAddressMode:
            state.accessMode === 'public-shared'
                ? 'shared'
                : state.accessMode === 'public-independent'
                  ? 'independent'
                  : state.config?.publicAddressMode || 'independent',
        publicServicePaths: Object.fromEntries(
            ['play', 'creator', 'voxa', 'player-service', 'player-auth-portal'].map((service) => [
                service,
                values[`publicPath-${service}`] ??
                    state.config?.publicServicePaths?.[service] ??
                    '',
            ]),
        ),
        playNetworkMode: isPublicMode(state.accessMode)
            ? 'public'
            : state.accessMode || state.config?.playNetworkMode || 'local',
        creatorNetworkMode: isPublicMode(state.accessMode)
            ? 'public'
            : state.accessMode ||
              state.config?.creatorNetworkMode ||
              state.config?.playNetworkMode ||
              'local',
        databaseSsl: databaseSsl instanceof HTMLInputElement ? databaseSsl.checked : false,
        autoBackupEnabled:
            autoBackupEnabled instanceof HTMLInputElement ? autoBackupEnabled.checked : false,
        registrationEnabled:
            registrationEnabled instanceof HTMLInputElement ? registrationEnabled.checked : false,
    };
    // Password inputs are intentionally blank after rendering. An empty field
    // means “keep the saved/session value”, not “erase it”, unless the user has
    // explicitly cleared the database address (which disables that service).
    if (!values.databasePassword && state.config?.databasePassword) {
        next.databasePassword = state.config.databasePassword;
    }
    if (!values.redisPassword && state.config?.redisPassword) {
        next.redisPassword = state.config.redisPassword;
    }
    for (const key of ownerSecretKeys) {
        if (!values[key] && state.config?.[key]) {
            next[key] = state.config[key];
        }
    }
    for (const key of Object.keys(next)) {
        if (
            key.startsWith('publicPath-') ||
            key.startsWith('ssl-cert-path-') ||
            key.startsWith('ssl-key-path-')
        ) {
            delete next[key];
        }
    }
    state.config = normalizeInactiveServicePorts(next);
    state.config.authPortalImage = normalizeAuthPortalImage(state.config.authPortalImage);
}

export function revealInvalidSetupField(form) {
    const invalid = form.querySelector(':invalid');
    if (!invalid) {
        return false;
    }
    const panel = invalid.closest('[data-setup-panel]');
    const label = invalid.closest('label')?.querySelector('span')?.textContent?.trim();
    captureRawEnvironment();
    captureSetupForm();
    if (panel?.dataset.setupPanel) {
        state.setupSection = panel.dataset.setupPanel;
    }
    const range = [
        invalid.min !== '' ? `最小 ${invalid.min}` : '',
        invalid.max !== '' ? `最大 ${invalid.max}` : '',
    ]
        .filter(Boolean)
        .join('，');
    const reason = invalid.validity.valueMissing
        ? '请填写'
        : range
          ? `取值范围 ${range}`
          : '请检查填写的值';
    state.error = `${label || invalid.name || '配置项'}：${reason}`;
    render();
    const target = invalid.name
        ? document.querySelector(`#setup-form [name="${CSS.escape(invalid.name)}"]`)
        : null;
    if (target) {
        for (
            let disclosure = target.closest('details');
            disclosure;
            disclosure = disclosure.parentElement?.closest('details')
        ) {
            disclosure.open = true;
        }
        target.focus();
        target.reportValidity();
    }
    return true;
}

export function switchSetupSection(section) {
    if (!section || section === state.setupSection) {
        return;
    }
    captureRawEnvironment();
    captureSetupForm();
    if (section !== 'security') {
        resetOwnerSecretState();
    }
    state.setupSection = section;
    clearFeedback();
    render();
}

function captureRawEnvironment() {
    const textarea = document.querySelector('#raw-environment');
    if (textarea) {
        state.environmentFile = textarea.value;
    }
    const nginx = document.querySelector('#raw-nginx-config');
    if (nginx) {
        state.nginxConfigFile = nginx.value;
    }
}

export function normalizeInactiveServicePorts(config) {
    if (config.databaseMode !== 'external') {
        config.databasePort = '5432';
    }
    if (config.redisMode !== 'external') {
        config.redisPort = '6379';
    }
    return config;
}

export function normalizedConfig() {
    const config = { ...(state.config || {}) };
    config.authPortalImage = normalizeAuthPortalImage(config.authPortalImage);
    normalizeInactiveServicePorts(config);
    for (const key of numericConfigFields) {
        config[key] = Number(config[key]);
    }
    return config;
}
