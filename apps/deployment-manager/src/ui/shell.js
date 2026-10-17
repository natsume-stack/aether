import { externalNginxDialog } from './external-nginx-dialog.js';
import {
    backupConfirmDialog,
    legalDocumentDialog,
    mapRuntimeProfileDialog,
    runtimeDestroyDialog,
    startScopeDialog,
} from './dialogs.js';
import { escapeHtml } from './html.js';
import { hasWebManagerToken, isWebManager } from '../infrastructure/transport.js';
import { icon } from './icons.js';
import { state } from '../core/state.js';
import { themeControl } from './theme.js';
import { updateDialog } from './update-dialog.js';
import { statusFeedback } from './status-feedback.js';

function navItem(page, iconName, label) {
    return `<button class="nav-item ${state.page === page ? 'active' : ''}" data-page="${page}">${icon(iconName)}<span>${label}</span></button>`;
}

export function shell(content) {
    const webLoginRequired = isWebManager() && !hasWebManagerToken();
    const updateLabel = state.updateChecking ? '正在检测更新' : '发现新版本，下载更新';
    const canCheckUpdates = !isWebManager() || hasWebManagerToken();
    const updateControl =
        canCheckUpdates && state.updateRelease
            ? `<button class="icon-button update-check update-available" id="check-version-updates" title="${updateLabel}" aria-label="${updateLabel}" ${state.updateChecking ? 'disabled' : ''}>${icon('download')}</button>`
            : '';
    const primaryNavigation = webLoginRequired
        ? navItem('web-login', 'device', '管理登录')
        : `${navItem('overview', 'home', '服务总览')}${navItem('setup', 'settings', '数据配置')}${navItem('backups', 'archive', '数据与备份')}`;
    return `<div class="shell" data-rendered-page="${state.page}">
    <aside>
      <div class="brand"><img class="brand-mark" src="/logo512.png" alt="BOX3 Engine"/><div><strong>BOX3 Engine</strong><span>本地部署</span></div></div>
      <nav>${primaryNavigation}${navItem('about', 'info', '关于')}</nav>
      <div class="sidebar-bottom">${isWebManager() && hasWebManagerToken() ? `<button class="web-logout" id="web-logout">${icon('logout')}<span>退出管理</span></button>` : ''}${themeControl()}${!webLoginRequired ? `<div class="sidebar-foot"><span class="status-dot ${state.status?.dockerReady ? 'good' : ''}"></span><span>${state.status?.dockerReady ? 'Docker 已连接' : 'Docker 未连接'}</span>${updateControl}</div>` : ''}</div>
    </aside>
    <main>${!webLoginRequired ? statusFeedback() : ''}${content}</main>
    ${feedbackToast()}
    ${state.startMenuOpen ? startScopeDialog() : ''}
    ${state.backupDialog ? backupConfirmDialog() : ''}
    ${state.runtimeDestroyDialog ? runtimeDestroyDialog() : ''}
    ${state.mapRuntimeProfileDialog ? mapRuntimeProfileDialog() : ''}
    ${state.legalDialog ? legalDocumentDialog() : ''}
    ${state.updateDialogOpen ? updateDialog() : ''}
    ${state.externalNginxDialog ? externalNginxDialog() : ''}
  </div>`;
}

function feedbackToast() {
    let type = '';
    let title = '';
    let message = '';
    if (state.error) {
        type = 'danger';
        title = '操作未完成';
        message = state.error;
    } else if (state.notice) {
        type = 'success';
        title = '操作完成';
        message = state.notice;
    } else if (state.backupMessage) {
        type = 'success';
        title = '数据与备份';
        message = state.backupMessage;
    } else if (state.performanceError) {
        type = 'danger';
        title = '性能数据读取失败';
        message = state.performanceError;
    } else if (state.diagnosticPath) {
        type = 'success';
        title = '诊断包已生成';
        message = state.diagnosticPath;
    }
    if (!message) {
        return '';
    }
    if (type === 'success') {
        return `<div class="toast success" role="status"><span>${title}</span><small>${escapeHtml(message)}</small><button type="button" data-dismiss-feedback aria-label="关闭提示">×</button></div>`;
    }
    return `<div class="toast danger" role="status"><span>${title}</span><small>${escapeHtml(message)}</small><button type="button" data-dismiss-feedback aria-label="关闭提示">×</button></div>`;
}

function progressPanelMarkup() {
    if (state.progress?.stage === 'dependency-image-download') {
        return `<div class="progress-backdrop" role="alertdialog" aria-modal="true" aria-live="polite"><section class="progress-dialog"><span class="progress-spinner" aria-hidden="true"></span><strong>正在下载依赖镜像</strong><p>${escapeHtml(state.progress.message || '正在下载，可能需要几分钟，请耐心等待…')}</p></section></div>`;
    }
    if (state.progress?.stage === 'image-download') {
        const downloads = state.progress.downloads;
        if (Array.isArray(downloads) && downloads.length) {
            const rows = downloads
                .map((download) => {
                    const percent = Math.max(0, Math.min(100, Number(download.percent) || 0));
                    const image = escapeHtml(download.image);
                    const bytes = Math.floor((Number(download.bytes) || 0) / 1_048_576);
                    const total = Math.floor((Number(download.total) || 0) / 1_048_576);
                    return `<li class="image-download-row${percent === 100 ? ' complete' : ''}"><div class="image-download-row-label"><span>${image}</span><small>${percent === 100 ? '已完成' : `${percent}%`}</small></div><progress class="image-download-progress" role="progressbar" aria-label="${image} 下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" max="100" value="${percent}"></progress><small class="image-download-bytes">${bytes} / ${total} MB</small></li>`;
                })
                .join('');
            return `<div class="progress-backdrop" role="alertdialog" aria-modal="true" aria-live="polite"><section class="progress-dialog image-download-dialog"><span class="progress-spinner" aria-hidden="true"></span><strong>正在下载服务镜像</strong><p>${escapeHtml(state.progress.message)}</p><ul class="image-download-list">${rows}</ul></section></div>`;
        }
        const percent = Math.max(0, Math.min(100, Number(state.progress.percent) || 0));
        return `<div class="progress-backdrop" role="alertdialog" aria-modal="true" aria-live="polite"><section class="progress-dialog image-download-dialog"><span class="progress-spinner" aria-hidden="true"></span><strong>正在下载服务镜像</strong><p>${escapeHtml(state.progress.message || '正在准备下载…')}</p><progress class="image-download-progress" role="progressbar" aria-label="服务镜像下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" max="100" value="${percent}"></progress><small class="image-download-percent">${percent}%</small></section></div>`;
    }
    if (state.progress?.stage === 'image-import') {
        return `<div class="progress-backdrop" role="alertdialog" aria-modal="true" aria-live="polite"><section class="progress-dialog"><span class="progress-spinner" aria-hidden="true"></span><strong>正在导入服务镜像</strong><p>${escapeHtml(state.progress.message || '镜像下载完成，正在导入 Docker…')}</p></section></div>`;
    }
    return `<div class="progress-backdrop" role="alertdialog" aria-modal="true" aria-live="polite"><section class="progress-dialog"><span class="progress-spinner" aria-hidden="true"></span><strong>正在处理</strong><p>这可能需要几分钟，请耐心等待…</p></section></div>`;
}

function progressContent(markup) {
    return markup.slice(markup.indexOf('</span>') + 7, markup.lastIndexOf('</section>'));
}

export function progressPanel() {
    const markup = progressPanelMarkup();
    return markup.replace(
        progressContent(markup),
        `<div class="progress-dialog-content">${progressContent(markup)}</div>`,
    );
}

export function refreshProgressPanel() {
    const content = document.querySelector('.progress-dialog-content');
    if (!content) {
        return false;
    }
    const markup = progressPanelMarkup();
    content.innerHTML = progressContent(markup);
    content.parentElement.className =
        state.progress?.stage === 'image-download'
            ? 'progress-dialog image-download-dialog'
            : 'progress-dialog';
    return true;
}
