import { PERFORMANCE_HIDDEN_POLL_MS, PERFORMANCE_POLL_MS } from '../core/constants.js';
import { clearFeedback } from './feedback.js';
import { invoke, isWebManager, subscribeManager } from '../infrastructure/transport.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

let webSubscription;

let performanceTimer;

export function syncPerformancePolling() {
    clearInterval(performanceTimer);
    performanceTimer = undefined;
    if (state.page !== 'performance') {
        webSubscription?.();
        webSubscription = undefined;
        return;
    }
    if (isWebManager()) {
        if (!webSubscription) {
            webSubscription = subscribeManager('performance', applyPerformanceSnapshot);
        }
        return;
    }
    if (!state.performance && !state.performanceLoading) {
        refreshPerformance();
    }
    performanceTimer = window.setInterval(
        refreshPerformance,
        document.hidden ? PERFORMANCE_HIDDEN_POLL_MS : PERFORMANCE_POLL_MS,
    );
}

export async function refreshPerformance() {
    if (state.performanceLoading || state.page !== 'performance') {
        return;
    }
    state.performanceLoading = true;
    clearFeedback();
    render();
    try {
        state.performance = await invoke('get_performance_status');
    } catch (error) {
        state.performanceError = String(error);
    } finally {
        state.performanceLoading = false;
        if (state.page === 'performance') {
            render();
        }
    }
}

function applyPerformanceSnapshot(value, error) {
    if (state.page !== 'performance') {
        return;
    }
    if (error) {
        state.performanceError = error;
    } else {
        state.performance = value;
        state.performanceError = '';
    }
    state.performanceLoading = false;
    render();
}
