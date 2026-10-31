import { icon } from './icons';
import { escapeHtml } from './html';

import type { PlayerLauncherState } from '../types';

export function createShellViews(state:PlayerLauncherState) {
    function serverRows():string {
        if (!state.servers.length) {
            return '<div class="nav-empty">还没有添加服务器</div>';
        }
        return state.servers
            .map(
                (server) => `
    <button class="server-nav ${state.selectedId === server.id && state.page === 'servers' ? 'active' : ''}" data-select-server="${escapeHtml(server.id)}">
      <span class="server-dot"></span>
      <span class="server-nav-copy"><strong>${escapeHtml(server.name || server.endpoint)}</strong><small>${escapeHtml(server.endpoint)}</small></span>
      <span class="server-remove" data-remove-server="${escapeHtml(server.id)}" title="从列表移除">${icon('trash')}</span>
    </button>`,
            )
            .join('');
    }

    function removeServerDialog():string {
        const server = state.servers.find((item) => item.id === state.confirmRemoveServerId);
        if (!server) {
            return '';
        }
        return `
    <div class="confirm-backdrop" data-remove-server-dialog-dismiss>
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-server-title" aria-describedby="remove-server-description">
        <header><div><h2 id="remove-server-title">移除服务器并删除本地地图数据？</h2><p id="remove-server-description">“${escapeHtml(server.name || server.endpoint)}”将从本机启动器列表中移除，同时会删除本机为该服务器保存的地图数据。</p></div></header>
        <div class="confirm-actions"><button class="button" type="button" data-cancel-remove-server autofocus>取消</button><button class="button danger" type="button" data-confirm-remove-server ${state.busy ? 'disabled' : ''}>确认移除</button></div>
      </section>
    </div>`;
    }

    function serverAddressNoticeDialog():string {
        const notice = state.serverAddressNotice;
        if (!notice || !state.pendingServerEndpoint) {
            return '';
        }
        return `
    <div class="confirm-backdrop" data-server-address-dismiss>
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="server-address-notice-title" aria-describedby="server-address-notice-description" data-server-address-dialog>
        <header><div><h2 id="server-address-notice-title">${escapeHtml(notice.title)}</h2><p id="server-address-notice-description">${escapeHtml(notice.message)}<br><br>地址：${escapeHtml(state.pendingServerEndpoint)}<br>确认后仍可添加。</p></div></header>
        <div class="confirm-actions"><button class="button" type="button" data-cancel-server-address autofocus>返回修改</button><button class="button primary" type="button" data-confirm-server-address>仍然添加</button></div>
      </section>
    </div>`;
    }

    return { serverRows, removeServerDialog, serverAddressNoticeDialog };
}
