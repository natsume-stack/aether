import { state } from '../core/state.js';
import { escapeHtml } from './html.js';
import { icon } from './icons.js';
import { isWebManager } from '../infrastructure/transport.js';

function downloadProgress() {
    const progress = state.updateProgress || { bytes: 0, total: 0 };
    const percent = progress.total
        ? Math.min(100, Math.floor((progress.bytes / progress.total) * 100))
        : null;
    return { percent, label: `正在下载更新…${percent === null ? '' : ` ${percent}%`}` };
}

export function updateDownloadProgress() {
    const { percent, label } = downloadProgress();
    const text = document.querySelector('#launcher-update-progress-label');
    const bar = document.querySelector('#launcher-update-progress');
    if (text && text.textContent !== label) {
        text.textContent = label;
    }
    if (bar) {
        if (percent === null) {
            bar.removeAttribute('value');
        } else {
            bar.value = percent;
        }
    }
}

export function updateDialog() {
    const release = state.updateRelease;
    const productName = isWebManager() ? 'BOX3 Engine Linux Web 管理器' : 'BOX3 Engine Launcher';
    const { percent, label } = downloadProgress();
    const download = state.updateDownloading
        ? `<div class="update-download-status" role="status" aria-live="polite"><span id="launcher-update-progress-label">${label}</span><progress id="launcher-update-progress" aria-label="启动器更新下载进度" max="100" ${percent === null ? '' : `value="${percent}"`}></progress></div>`
        : '';
    const action = state.updateReady
        ? `<button class="button primary" id="restart-update" ${state.updateRestarting ? 'disabled' : ''}>${state.updateRestarting ? (state.updateCleanupOldImages ? '正在清理并更新…' : '正在重启…') : '重启并更新'}</button>`
        : `<button class="button primary" id="open-update-download" ${state.updateDownloading || state.updateRestarting ? 'disabled' : ''}>${state.updateRestarting ? '正在更新…' : state.updateDownloading ? '下载中…' : isWebManager() ? '下载并更新' : '下载新版'}</button>`;
    const cleanupChoice = state.updateReady
        ? `<label class="update-cleanup-choice"><input type="checkbox" id="update-cleanup-old-images" ${state.updateCleanupOldImages ? 'checked' : ''} ${state.updateRestarting ? 'disabled' : ''}><span>同时清理旧镜像</span></label>`
        : '';
    return `<div class="dialog-backdrop update-backdrop" data-update-dismiss>
    <section class="start-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" tabindex="-1">
      <header class="update-header"><div><h2 id="update-title">发现新版本 ${escapeHtml(release.version)}</h2><p>${escapeHtml(productName)} <span aria-hidden="true">·</span> ${escapeHtml(release.date)}</p></div><button class="dialog-close" id="close-update-dialog" aria-label="关闭" ${state.updateRestarting ? 'disabled' : ''}>×</button></header>
      <div class="update-notes">${release.sections.map((section) => `<section><h3>${escapeHtml(section.title)}</h3><ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`).join('')}</div>
      <footer class="update-footer">${download}${state.updateReady ? `<div class="update-ready-status" role="status">${icon('check')}<span>下载完成，可以重启并更新。</span></div>` : ''}${state.updateError ? `<p class="update-error" role="alert">${escapeHtml(state.updateError)}</p>` : ''}<div class="update-footer-actions">${cleanupChoice}<div class="dialog-actions">${action}</div></div></footer>
    </section>
  </div>`;
}
