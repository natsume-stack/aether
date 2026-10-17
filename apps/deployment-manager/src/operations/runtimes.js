import {
    PROJECT_RUNTIME_EMPTY_POLL_MS,
    PROJECT_RUNTIME_HIDDEN_POLL_MS,
    PROJECT_RUNTIME_POLL_MS,
} from '../core/constants.js';
import { clearFeedback } from './feedback.js';
import { invoke, isWebManager, subscribeManager } from '../infrastructure/transport.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

let webSubscription;

let projectRuntimeTimer;

let projectRuntimeLoading = false;

let projectRuntimeRefreshTimer;

export function syncProjectRuntimePolling() {
    clearInterval(projectRuntimeTimer);
    projectRuntimeTimer = undefined;
    if (state.page !== 'runtimes' || state.runtimeCatalogTab === 'config') {
        webSubscription?.();
        webSubscription = undefined;
        clearTimeout(projectRuntimeRefreshTimer);
        projectRuntimeRefreshTimer = undefined;
        return;
    }
    if (isWebManager()) {
        if (!webSubscription) {
            webSubscription = subscribeManager('runtimes', applyRuntimeSnapshot);
        }
        return;
    }
    const hasProjects = state.projectRuntimes.creator?.length || state.projectRuntimes.play?.length;
    if (!hasProjects) {
        if (!state.projectRuntimesLoaded && !projectRuntimeLoading) {
            scheduleProjectRuntimeRefresh();
        }
    }
    projectRuntimeTimer = window.setInterval(
        refreshProjectRuntimes,
        hasProjects
            ? document.hidden
                ? PROJECT_RUNTIME_HIDDEN_POLL_MS
                : PROJECT_RUNTIME_POLL_MS
            : PROJECT_RUNTIME_EMPTY_POLL_MS,
    );
}

export function scheduleProjectRuntimeRefresh() {
    if (
        projectRuntimeRefreshTimer ||
        projectRuntimeLoading ||
        state.page !== 'runtimes' ||
        state.runtimeCatalogTab === 'config'
    ) {
        return;
    }
    projectRuntimeRefreshTimer = window.setTimeout(() => {
        projectRuntimeRefreshTimer = undefined;
        refreshProjectRuntimes();
    }, 0);
}

export async function refreshProjectRuntimes() {
    if (projectRuntimeLoading || state.page !== 'runtimes') {
        return;
    }
    projectRuntimeLoading = true;
    const previousRuntimes = JSON.stringify(state.projectRuntimes);
    const wasLoaded = state.projectRuntimesLoaded;
    const previousError = state.projectRuntimesError;
    state.projectRuntimesLoading = true;
    state.projectRuntimesError = '';
    try {
        state.projectRuntimes = await invoke('get_project_runtime_status');
    } catch (error) {
        state.projectRuntimesError = String(error);
    } finally {
        projectRuntimeLoading = false;
        state.projectRuntimesLoading = false;
        state.projectRuntimesLoaded = true;
        const runtimesChanged = previousRuntimes !== JSON.stringify(state.projectRuntimes);
        const errorChanged = previousError !== state.projectRuntimesError;
        if (
            state.page === 'runtimes' &&
            !state.runtimeDestroyDialog &&
            !state.mapRuntimeProfileDialog &&
            (!wasLoaded || runtimesChanged || errorChanged)
        ) {
            render();
        }
    }
}

export async function refreshMapRuntimeProfiles() {
    try {
        state.mapRuntimeProfiles = await invoke('list_map_runtime_profiles');
        state.mapRuntimeProfilesLoaded = true;
    } catch (error) {
        state.projectRuntimesError = String(error);
    }
}

export async function saveMapRuntimeProfile(profile) {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        await invoke('save_map_runtime_profile', { profile });
        await refreshMapRuntimeProfiles();
        state.mapRuntimeProfileDialog = false;
        state.notice = '地图容器配置已保存；新启动的运行时会使用该配置。';
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        render();
    }
}

export async function deleteMapRuntimeProfile(permanentMapId, mode) {
    if (!permanentMapId || !mode || state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    try {
        await invoke('delete_map_runtime_profile', { permanentMapId, mode });
        await refreshMapRuntimeProfiles();
        state.notice = '地图容器配置已删除；后续启动将使用默认共享运行时。';
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        render();
    }
}

export async function destroyProjectRuntime(projectId, mode, roomId) {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        await invoke('destroy_project_runtime', { projectId, mode, roomId });
        state.notice = roomId ? '房间已销毁。' : '运行实例已销毁。';
        state.projectRuntimesLoaded = false;
        await refreshProjectRuntimes();
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        if (state.page === 'runtimes') {
            render();
        }
    }
}

function applyRuntimeSnapshot(value, error) {
    if (state.page !== 'runtimes') {
        return;
    }
    if (error) {
        state.projectRuntimesError = error;
    } else {
        state.projectRuntimes = value;
        state.projectRuntimesError = '';
    }
    state.projectRuntimesLoaded = true;
    state.projectRuntimesLoading = false;
    if (!state.runtimeDestroyDialog && !state.mapRuntimeProfileDialog) {
        render();
    }
}
