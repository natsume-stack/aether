import { OVERVIEW_HIDDEN_POLL_MS, OVERVIEW_POLL_MS } from '../core/constants.js';
import { clearFeedback } from './feedback.js';
import {
    dockerPlatform,
    invoke,
    isWebManager,
    subscribeManager,
} from '../infrastructure/transport.js';
import { applySystemStatus, refreshStatus } from './status.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

let webSubscription;

let overviewStatusTimer;

let overviewStatusLoading = false;

let dockerStartupPollTimer;

export function syncOverviewPolling() {
    clearInterval(overviewStatusTimer);
    overviewStatusTimer = undefined;
    if (state.page !== 'overview') {
        webSubscription?.();
        webSubscription = undefined;
        clearTimeout(dockerStartupPollTimer);
        dockerStartupPollTimer = undefined;
        return;
    }
    if (isWebManager()) {
        if (!webSubscription) {
            webSubscription = subscribeManager('overview', applyOverviewSnapshot);
        }
        return;
    }
    overviewStatusTimer = window.setInterval(
        refreshOverviewStatus,
        document.hidden ? OVERVIEW_HIDDEN_POLL_MS : OVERVIEW_POLL_MS,
    );
}

export async function refreshOverviewStatus() {
    if (overviewStatusLoading || state.page !== 'overview') {
        return;
    }
    overviewStatusLoading = true;
    try {
        const status = await invoke('get_system_status');
        applySystemStatus(status);
    } catch (error) {
        applySystemStatus(null, error);
    } finally {
        overviewStatusLoading = false;
        if (state.page === 'overview') {
            render();
        }
    }
}

export async function recheckDocker() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    state.progress = {
        stage: 'docker-check',
        message: `正在检测 ${dockerPlatform().name}…`,
        percent: 20,
    };
    render();
    try {
        const timeout = new Promise((_, reject) => {
            window.setTimeout(
                () =>
                    reject(
                        new Error(
                            `${dockerPlatform().name} 未在 8 秒内响应。请确认它已启动后重试。`,
                        ),
                    ),
                8000,
            );
        });
        const check = await Promise.race([invoke('get_docker_check'), timeout]);
        state.dockerCheck = check;
        state.status = {
            ...(state.status || {}),
            dockerReady: check.engineReady,
            dockerCliAvailable: check.cliAvailable,
            dockerCliVersion: check.cliVersion,
            dockerMessage: check.message,
        };
        if (check.engineReady) {
            state.notice = `${dockerPlatform().name} 已连接。`;
            state.progress = {
                stage: 'docker-ready',
                message: `${dockerPlatform().name} 已就绪`,
                percent: 100,
            };
        } else if (check.cliAvailable) {
            state.notice = `Docker CLI 已检测到；${dockerPlatform().name} 尚未启动。${dockerPlatform().hint}`;
            state.progress = { stage: 'docker-waiting', message: check.message, percent: 100 };
        } else {
            state.error = check.message || `未检测到可用的 ${dockerPlatform().name}。`;
            state.progress = { stage: 'docker-unavailable', message: state.error, percent: 100 };
        }
    } catch (error) {
        state.error = String(error);
        state.progress = { stage: 'docker-timeout', message: state.error, percent: 100 };
    } finally {
        state.busy = false;
        render();
    }
}

export async function startDockerDesktop() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    state.progress = { stage: 'docker-start', message: '正在启动 Docker Desktop…', percent: 20 };
    render();
    try {
        await invoke('start_docker_desktop');
        state.notice = '已发送启动请求。Docker Desktop 初始化可能需要一点时间，请稍后重新检测。';
        state.progress = { stage: 'docker-started', message: state.notice, percent: 100 };
    } catch (error) {
        state.error = String(error);
        state.progress = { stage: 'docker-start-error', message: state.error, percent: 100 };
    } finally {
        state.busy = false;
        render();
        scheduleDockerStartupCheck();
    }
}

function scheduleDockerStartupCheck() {
    clearTimeout(dockerStartupPollTimer);
    if (state.page !== 'overview' || state.status?.dockerReady) {
        return;
    }
    dockerStartupPollTimer = window.setTimeout(async () => {
        await recheckDocker();
        if (!state.status?.dockerReady) {
            scheduleDockerStartupCheck();
        }
    }, 3000);
}

export async function runAction(command, payload = {}) {
    if (state.busy) {
        return;
    }
    const startsDockerWork =
        command === 'start_services' ||
        (command === 'control_service' && ['start', 'restart'].includes(payload.action));
    if (startsDockerWork && (state.statusErrors.system || !state.status?.dockerReady)) {
        state.error = dockerPlatform().hint;
        state.progress = { stage: 'docker-required', message: state.error, percent: 100 };
        state.page = 'overview';
        render();
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        await invoke(command, payload);
        state.notice =
            {
                start_services: '服务已启动。',
                stop_services: '服务已停止。',
                control_service: '服务操作已完成。',
            }[command] || '操作已完成。';
    } catch (error) {
        state.progress = { stage: 'error', message: String(error), percent: 100 };
        state.error = String(error);
    } finally {
        state.busy = false;
        await refreshStatus();
    }
}

function applyOverviewSnapshot(status, error) {
    if (state.page !== 'overview') {
        return;
    }
    applySystemStatus(status, error);
    render();
}
