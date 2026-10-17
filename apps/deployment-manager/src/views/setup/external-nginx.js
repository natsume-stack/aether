import { state } from '../../core/state.js';
import { externalProtocol } from '../../configuration/public-access.js';

export function externalNginxEntry() {
    return '<button type="button" class="text-button external-nginx-entry" id="open-external-nginx-dialog">查看 Nginx 配置</button>';
}

export function externalProtocolSetting() {
    const selected = externalProtocol(state.config || {});
    return `<div class="external-guide-choices"><span>公网协议</span><div class="access-choice" aria-label="公网协议">${['http', 'https'].map((protocol) => `<button type="button" data-external-guide-protocol="${protocol}" aria-pressed="${selected === protocol}" class="${selected === protocol ? 'active' : ''}">${protocol.toUpperCase()}</button>`).join('')}</div></div>`;
}
