import { escapeHtml } from '../ui/html.js';
import { formatBackupTime, formatBytes } from '../utils/format.js';
import { icon } from '../ui/icons.js';
import { state } from '../core/state.js';

export function backups() {
    const items = state.backups
        .map(
            (backup) =>
                `<article class="backup-row"><div><strong>${escapeHtml(backup.name)}</strong><span>${formatBackupTime(backup.modifiedAt)} · ${formatBytes(backup.sizeBytes)}</span></div><div class="backup-actions"><button class="button" data-export-backup="${escapeHtml(backup.path)}" ${state.busy ? 'disabled' : ''}>导出</button><button class="button" data-backup-action="restore" data-backup-path="${escapeHtml(backup.path)}" data-backup-name="${escapeHtml(backup.name)}" ${state.busy ? 'disabled' : ''}>恢复</button><button class="button danger" data-backup-action="delete" data-backup-path="${escapeHtml(backup.path)}" data-backup-name="${escapeHtml(backup.name)}" ${state.busy ? 'disabled' : ''}>删除</button></div></article>`,
        )
        .join('');
    return `<header><div><h1>数据与备份</h1></div><div class="header-actions"><button class="button" id="refresh-backups" ${state.backupsLoading || state.busy ? 'disabled' : ''}>${icon('refresh')}刷新</button><button class="button" id="import-backup" ${state.backupsLoading || state.busy ? 'disabled' : ''}>导入备份</button><button class="button primary" id="create-backup" ${state.backupsLoading || state.busy ? 'disabled' : ''}>${icon('archive')}立即备份</button></div></header>
    <section class="backup-list">${state.backupsLoading ? '<div class="empty-backup"><strong>正在读取备份…</strong></div>' : items || '<div class="empty-backup"><strong>尚无本地备份</strong><span>重要修改前可点击右上角“立即备份”。</span></div>'}</section>`;
}
