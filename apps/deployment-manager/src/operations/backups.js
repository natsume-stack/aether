import { clearFeedback } from './feedback.js';
import {
    exportBackupFile,
    exportDiagnosticsFile,
    invoke,
    selectBackup,
} from '../infrastructure/transport.js';
import { refreshStatus } from './status.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

export async function exportDiagnostics() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        state.diagnosticPath = (await exportDiagnosticsFile()) || '';
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        render();
    }
}

export async function loadBackups() {
    if (state.backupsLoading) {
        return;
    }
    state.backupsLoading = true;
    if (state.page === 'backups') {
        render();
    }
    try {
        state.backups = await invoke('list_backups');
    } catch (error) {
        state.error = String(error);
    } finally {
        state.backupsLoading = false;
        if (state.page === 'backups') {
            render();
        }
    }
}

export async function createBackup() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        const path = await invoke('create_backup');
        state.backupMessage = `备份已创建：${path}`;
        await loadBackups();
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        if (state.page === 'backups') {
            render();
        }
    }
}

export async function importBackup() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        const path = await selectBackup();
        if (path) {
            state.backupMessage = `备份已导入：${path}`;
            await loadBackups();
        }
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        if (state.page === 'backups') {
            render();
        }
    }
}

export async function exportBackup(archive) {
    if (state.busy || !archive) {
        return;
    }
    state.busy = true;
    clearFeedback();
    render();
    try {
        state.backupMessage = await exportBackupFile(archive);
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        if (state.page === 'backups') {
            render();
        }
    }
}

export function closeBackupDialog() {
    state.backupDialog = null;
    render();
}

export async function openBackupDialog(action, archive, name) {
    if (state.busy || !archive) {
        return;
    }
    clearFeedback();
    state.backupDialog = {
        action,
        archive,
        name,
        hasEnv: false,
        includeEnv: false,
        inspected: action !== 'restore',
    };
    render();
    if (action !== 'restore') {
        return;
    }
    try {
        const info = await invoke('inspect_backup', { archive });
        if (state.backupDialog?.archive !== archive) {
            return;
        }
        state.backupDialog.hasEnv = Boolean(info?.hasEnv);
    } catch (error) {
        if (state.backupDialog?.archive !== archive) {
            return;
        }
        state.error = `无法检查备份内容：${String(error)}`;
    } finally {
        if (state.backupDialog?.archive === archive) {
            state.backupDialog.inspected = true;
            render();
        }
    }
}

export async function confirmBackupAction() {
    const dialog = state.backupDialog;
    if (state.busy || !dialog?.archive) {
        return;
    }
    const includeEnv = Boolean(dialog.includeEnv);
    state.backupDialog = null;
    state.busy = true;
    clearFeedback();
    render();
    try {
        if (dialog.action === 'delete') {
            await invoke('delete_backup', { archive: dialog.archive });
            state.backupMessage = '备份已删除。';
            await loadBackups();
        } else {
            const cleanupWarning = await invoke('restore_backup', {
                archive: dialog.archive,
                includeEnv,
            });
            state.backupMessage = '恢复完成，请在服务总览检查并按需启动服务。';
            if (cleanupWarning) {
                state.backupMessage += ` 清理提示：${cleanupWarning}`;
            }
            await refreshStatus();
        }
    } catch (error) {
        state.error = String(error);
    } finally {
        state.busy = false;
        if (state.page === 'backups') {
            render();
        }
    }
}
