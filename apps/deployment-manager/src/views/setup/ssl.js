import { state } from '../../core/state.js';
import { fileInput } from '../../ui/forms.js';
import { escapeHtml } from '../../ui/html.js';
import { nginxMode } from '../../configuration/ssl.js';
import { icon } from '../../ui/icons.js';
import { serviceModeChoice } from './controls.js';

export function nginxSetting() {
    const mode = nginxMode();
    const disabled = state.sslBusy || state.busy ? 'disabled' : '';
    const available = state.sslStatus?.imageAvailable;
    const label = `Nginx ${escapeHtml(state.sslStatus?.imageVersion || '稳定版')}`;
    const panel = state.sslStatus?.running
        ? `<div class="managed-install-card"><div><span class="managed-state running">正在运行</span><strong>内置 ${label}</strong></div><button type="button" class="button primary" id="nginx-reload" ${disabled}>重载</button></div>`
        : `<div class="managed-install-card"><strong>${available ? `内置 ${label} 已下载` : '尚未安装 Nginx 最新稳定版'}</strong><button type="button" class="button primary" id="${available ? 'nginx-enable' : 'nginx-download'}" ${disabled}>${available ? '启用并启动' : '立即下载'}</button></div>`;
    return `<div class="config-group data-service-group"><div class="group-title"><h2>Nginx</h2></div>
    <input type="hidden" id="ssl-mode" value="${mode}"/>
    ${serviceModeChoice(
        'data-nginx-mode',
        [
            ['managed', '内置 Nginx'],
            ['external', '已有外部 Nginx'],
        ],
        mode,
    )}
    ${mode === 'managed' ? panel : externalNginxPanel()}
  </div>`;
}

function externalNginxPanel() {
    return '<div class="managed-install-card"><strong>外部 Nginx 由你维护</strong><button type="button" class="button" data-setup-section="network">配置访问入口</button></div>';
}

export function sslCertificateSetting(service) {
    const files = state.sslFiles?.[service] || {};
    const saved = state.sslStatus?.config;
    const sharedDates =
        service === 'shared'
            ? Object.entries(saved?.certificateSources || {})
                  .filter(([, source]) => source === 'shared')
                  .map(([key]) => saved?.certificateExpiries?.[key])
                  .filter(Boolean)
                  .sort()
            : [];
    const expiry =
        sharedDates[0] ||
        saved?.certificateExpiries?.[service] ||
        (saved?.settings?.routes?.some((route) => route.service === service)
            ? saved.expiresAt
            : null);
    const remaining = Date.parse(expiry) - Date.now();
    const expiryClass = remaining <= 0 ? 'expired' : remaining <= 30 * 86400000 ? 'expiring' : '';
    const expiryHint =
        expiryClass === 'expired'
            ? '（已过期，请更换）'
            : expiryClass === 'expiring'
              ? '（即将到期，请更换）'
              : '';
    const titleStatus =
        expiryClass === 'expired'
            ? '已配置 · 已过期'
            : expiryClass === 'expiring'
              ? '已配置 · 即将到期'
              : '已配置';
    const pathRecords = state.sslStatus?.certificatePaths || {};
    const savedPath =
        service === 'shared'
            ? Object.values(pathRecords).find((pair) => pair.source === 'shared')
            : pathRecords[service];
    const inputMode = files.inputMode || (savedPath ? 'path' : 'upload');
    const pathFields = `<div class="form-grid single">
    <label class="field no-hint"><span>证书文件路径</span><input name="ssl-cert-path-${service}" data-ssl-cert-path="${service}" value="${escapeHtml(files.certificatePath ?? savedPath?.certificatePath ?? '')}" placeholder="/etc/letsencrypt/live/example.com/fullchain.pem"/></label>
    <label class="field no-hint"><span>私钥文件路径</span><input name="ssl-key-path-${service}" data-ssl-key-path="${service}" value="${escapeHtml(files.privateKeyPath ?? savedPath?.privateKeyPath ?? '')}" placeholder="/etc/letsencrypt/live/example.com/privkey.pem"/></label>
  </div>`;
    const picker = (kind, title, accept, filename, hint) =>
        fileInput(
            title,
            filename,
            { 'data-ssl-service': service, 'data-ssl-kind': kind, accept },
            hint,
        );
    return `<details class="setup-explainer ssl-address-certificate" data-disclosure="ssl-${service}" ${state.sslDisclosureOpen?.[service] ? 'open' : ''}><summary><span>SSL 证书</span>${expiry ? `<span class="ssl-title-status ${expiryClass}">（${titleStatus}）</span>` : ''}</summary>

    ${nginxMode() === 'external' && state.sslStatus?.config?.pendingLocal ? '<div class="database-download-note"><span>SSL 配置已保存，需要安装并启动本机 Nginx 才能启用；安装后再次点击“保存配置”即可应用。</span></div>' : ''}
    ${expiry ? `<div class="database-download-note ssl-expiry-card ${expiryClass}"><span>有效期至 ${escapeHtml(new Date(expiry).toLocaleDateString('zh-CN'))}${expiryHint}</span><button type="button" class="ssl-delete-certificate" data-delete-ssl="${escapeHtml(service)}" title="删除该服务的 SSL 证书和私钥" aria-label="删除 SSL 证书" ${state.busy || state.sslBusy ? 'disabled' : ''}>${icon('trash')}</button></div>` : ''}
    <div class="access-choice ssl-input-choice" aria-label="证书配置方式">${[
        ['upload', '文件上传'],
        ['path', '证书路径'],
    ]
        .map(
            ([mode, label]) =>
                `<button type="button" data-ssl-input-mode="${mode}" data-ssl-input-service="${service}" aria-pressed="${inputMode === mode}" class="${inputMode === mode ? 'active' : ''}">${label}</button>`,
        )
        .join('')}</div>
    ${state.sslStatus?.certificatePathError ? `<p role="alert">${escapeHtml(state.sslStatus.certificatePathError)}</p>` : ''}
    ${
        inputMode === 'path'
            ? pathFields
            : `<div class="form-grid single">
      ${picker('certificate', '证书文件（.pem / .crt / .cer）', '.pem,.crt,.cer', files.certificateName)}
      ${picker('privateKey', '证书密钥文件（.key / .pem）', '.pem,.key', files.keyName)}
    </div>`
    }
  </details>`;
}
