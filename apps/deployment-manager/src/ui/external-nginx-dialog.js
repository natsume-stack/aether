import { state } from '../core/state.js';
import { escapeHtml } from './html.js';

export function externalNginxDialog() {
    const dialog = state.externalNginxDialog;
    if (!dialog) {
        return '';
    }
    return `<div class="dialog-backdrop" data-external-nginx-dismiss>
    <section class="start-dialog external-nginx-dialog" role="dialog" aria-modal="true" aria-labelledby="external-nginx-title" tabindex="-1">
      <div class="network-card-heading"><h2 id="external-nginx-title">外部 Nginx 配置</h2><button type="button" class="dialog-close" id="close-external-nginx-dialog" aria-label="关闭外部 Nginx 配置">×</button></div>
      <p>${escapeHtml(dialog.message || '复制配置到外部 Nginx，修改证书路径，校验并重载。')}</p>
      ${dialog.error ? `<p role="alert">${escapeHtml(dialog.error)}</p>` : ''}
      <pre id="external-example-nginx"><code>${escapeHtml(dialog.content)}</code></pre>
      <div class="dialog-actions"><button type="button" class="button primary" data-copy-example="external-example-nginx" ${dialog.content ? '' : 'disabled'}>复制配置</button></div>
    </section>
  </div>`;
}
