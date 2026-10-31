import { captureSetupForm } from '../configuration/form.js';
import { state } from '../core/state.js';
import { render } from '../core/render-request.js';
import { clearFeedback } from './feedback.js';

export function restoreDefaultAuthPortalImage() {
    if (state.busy) {
        return;
    }
    captureSetupForm();
    state.config.authPortalImage = '';
    clearFeedback();
    render();
}
