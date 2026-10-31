import { captureSetupForm } from '../configuration/form.js';
import { clearFeedback } from './feedback.js';
import { copyText } from '../utils/clipboard.js';
import { invoke } from '../infrastructure/transport.js';
import { ownerSecretKeys } from '../core/constants.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

async function loadOwnerSecrets() {
    if (state.ownerSecrets) {
        return true;
    }
    try {
        state.ownerSecrets = await invoke('get_owner_secrets');
        return true;
    } catch (error) {
        state.error = String(error);
        render();
        return false;
    }
}

export async function toggleOwnerSecretEditor(name) {
    if (!ownerSecretKeys.includes(name)) {
        return;
    }
    captureSetupForm();
    clearFeedback();
    if (state.ownerSecretEditing[name]) {
        state.ownerSecretEditing[name] = false;
        delete state.config?.[name];
        render();
        return;
    }
    if (!(await loadOwnerSecrets())) {
        return;
    }
    state.ownerSecretEditing[name] = true;
    render();
    document.querySelector(`[name="${CSS.escape(name)}"]`)?.focus();
}

export async function copyOwnerSecret(name) {
    if (!ownerSecretKeys.includes(name)) {
        return;
    }
    captureSetupForm();
    clearFeedback();
    if (!(await loadOwnerSecrets())) {
        return;
    }
    const secret = state.config?.[name] || state.ownerSecrets?.[name] || '';
    if (!secret) {
        state.error = '该密钥尚未生成，请先保存配置。';
        render();
        return;
    }
    try {
        await copyText(secret);
        state.ownerSecretCopied = name;
        render();
        window.setTimeout(() => {
            if (state.ownerSecretCopied !== name) {
                return;
            }
            state.ownerSecretCopied = '';
            if (
                state.page === 'overview' ||
                (state.page === 'setup' && state.setupSection === 'security')
            ) {
                render();
            }
        }, 1600);
    } catch (error) {
        state.error = `复制失败：${String(error)}`;
        render();
    }
}
