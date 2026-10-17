import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

export function dismissFeedback() {
    clearFeedback();
    render();
}

export function clearFeedback() {
    state.error = '';
    state.notice = '';
    state.backupMessage = '';
    state.performanceError = '';
    state.diagnosticPath = '';
    state.environmentMessage = '';
}
