import { state } from '../core/state.js';
import { render } from '../core/render-request.js';
import { captureSetupForm } from '../configuration/form.js';
import { externalNginxConfiguration } from '../configuration/external-nginx.js';

export function showExternalNginxConfiguration(config, message = '') {
    state.externalNginxDialog = { ...externalNginxConfiguration(config), message };
}

export function openExternalNginxDialog() {
    captureSetupForm();
    showExternalNginxConfiguration(state.config || {});
    render();
}

export function closeExternalNginxDialog() {
    state.externalNginxDialog = null;
    render();
    document.querySelector('#open-external-nginx-dialog')?.focus();
}
