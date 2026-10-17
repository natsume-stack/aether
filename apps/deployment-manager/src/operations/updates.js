import { state } from '../core/state.js';
import { render } from '../core/render-request.js';
import { invoke, isWebManager, listen } from '../infrastructure/transport.js';
import { fetchLatestRelease } from '../infrastructure/releases.js';
import {
    installerTarget,
    isNewerVersion,
    releaseBase,
    validateRelease,
} from '../utils/releases.js';
import { captureSetupForm } from '../configuration/form.js';
import { updateDownloadProgress } from '../ui/update-dialog.js';

let pending;

function renderUpdateState() {
    if (state.page === 'setup') {
        captureSetupForm();
    }
    render();
}

export async function checkForUpdates(manual = false) {
    if (state.updateDownloading || state.updateReady || state.updateRestarting) {
        return;
    }
    if (manual) {
        state.error = '';
        state.notice = '';
    }
    if (!pending) {
        state.updateChecking = true;
        pending = invoke('get_about_info')
            .then(async (info) => {
                if (/(?:-|\.)dev$/.test(info.applicationVersion)) {
                    return { info, release: null, newer: false, development: true };
                }
                if (info.imageTag?.startsWith('test-')) {
                    return { info, release: null, newer: false, testing: true };
                }
                const release = await (isWebManager()
                    ? invoke('get_latest_release').then(validateRelease)
                    : fetchLatestRelease(info.applicationVersion));
                return {
                    info,
                    release,
                    newer: isNewerVersion(release.version, info.applicationVersion),
                };
            })
            .finally(() => {
                pending = null;
                state.updateChecking = false;
            });
    }
    if (manual) {
        renderUpdateState();
    }
    try {
        const result = await pending;
        if (result.newer) {
            state.updateDownloadTarget = installerTarget(result.info);
            state.updateRelease = result.release;
            state.updateDialogOpen = true;
        } else {
            state.updateRelease = null;
            state.updateDownloadTarget = null;
            state.updateDialogOpen = false;
            if (manual) {
                state.notice = result.development
                    ? '开发版请重新打包更新。'
                    : result.testing
                      ? '测试启动器请下载新的预发布包更新。'
                      : '当前已是最新版本。';
            }
        }
    } catch (error) {
        if (manual) {
            state.error = `无法检测更新：${error?.message || String(error)}`;
        }
    }
    renderUpdateState();
}

export function openUpdateDialog() {
    state.updateDialogOpen = true;
    renderUpdateState();
}

export async function downloadUpdate() {
    if (
        !state.updateRelease ||
        !state.updateDownloadTarget ||
        state.updateDownloading ||
        state.updateReady
    ) {
        return;
    }
    if (isWebManager()) {
        state.updateRestarting = true;
        state.updateError = '';
        renderUpdateState();
        try {
            const version = state.updateRelease.version.replace(/^v/, '');
            const result = await invoke('start_server_update', { version });
            const updater = result?.updater;
            if (typeof updater !== 'string' || !updater) {
                throw new Error('更新任务未返回有效标识。');
            }
            const deadline = Date.now() + 10 * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise((resolve) => window.setTimeout(resolve, 2000));
                try {
                    const info = await invoke('get_about_info');
                    if (info.applicationVersion.replace(/^v/, '') === version) {
                        state.about = info;
                        state.updateDialogOpen = false;
                        state.updateRelease = null;
                        state.notice = `Web 管理器已更新到 v${version}。`;
                        window.location.reload();
                        return;
                    }
                } catch {
                    // The old manager is expected to be unavailable during replacement.
                }
            }
            throw new Error(
                `更新任务 ${updater} 已启动，但 Web 管理器未在 10 分钟内恢复。可在服务器运行 docker logs ${updater} 排查。`,
            );
        } catch (error) {
            state.updateError = String(error);
        } finally {
            state.updateRestarting = false;
            renderUpdateState();
        }
        return;
    }
    state.updateDownloading = true;
    state.updateError = '';
    state.updateProgress = { bytes: 0, total: 0 };
    renderUpdateState();
    let stop;
    try {
        stop = await listen('launcher-update-progress', ({ payload }) => {
            state.updateProgress = payload;
            updateDownloadProgress();
        });
        await invoke('download_launcher_update', {
            url: `${releaseBase(state.updateRelease.version)}/BOX-Local-Engine-${state.updateRelease.version.replace(/^v/, '')}-${state.updateDownloadTarget}.zip`,
        });
        state.updateReady = true;
    } catch (error) {
        state.updateError = String(error);
    } finally {
        stop?.();
        state.updateDownloading = false;
        renderUpdateState();
    }
}

export async function restartAndUpdate() {
    if (!state.updateReady || state.updateRestarting) {
        return;
    }
    state.updateRestarting = true;
    state.updateError = '';
    renderUpdateState();
    try {
        await invoke('apply_launcher_update', { cleanupOldImages: state.updateCleanupOldImages });
    } catch (error) {
        state.updateError = String(error);
        state.updateRestarting = false;
        renderUpdateState();
    }
}

export function closeUpdateDialog() {
    if (state.updateRestarting) {
        return;
    }
    state.updateDialogOpen = false;
    renderUpdateState();
    document.querySelector('#check-version-updates')?.focus();
}
