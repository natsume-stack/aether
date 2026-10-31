import { createInitialState } from './application/state';
import { createLauncherController } from './application/controller';
import { createShellViews } from './views/shell';
import { icon } from './views/icons';
import { escapeHtml } from './views/html';
import { invoke, listen, isDesktopLauncher } from './platform/launcher-bridge';
import brandIcon from '../resources/brand-icon.png';
import { createPlayerApi } from './api/player-api';
import { bindEvents } from './events';
import { renderServerPage } from './views/server-pages';
import { renderStoragePage } from './features/storage/page';
import { bindDialogFocus } from './platform/ui-interactions';
import { refreshStorage } from './features/storage/events';
import { expirePlayerSession } from './features/player/session';
import type { PlayerLauncherState, PlayerServer } from './types';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
    throw new Error('启动器界面根节点缺失');
}
document.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });
const state = createInitialState();
let composingInput:Element | null = null;
let renderAfterComposition = false;
document.addEventListener(
    'compositionstart',
    (event) => {
        composingInput = event.target instanceof Element ? event.target : null;
    },
    true,
);
document.addEventListener(
    'compositionend',
    () => {
        composingInput = null;
        if (renderAfterComposition) {
            setTimeout(render, 0);
        }
    },
    true,
);
const { serverRows, removeServerDialog, serverAddressNoticeDialog } = createShellViews(state);

document.addEventListener('click', (event) => {
    if (!state.playerMenuOpen) {
        return;
    }
    if (event.target instanceof Element && event.target.closest('.player-account-control')) {
        return;
    }
    state.playerMenuOpen = false;
    render();
});

const remoteApi = createPlayerApi({
    invoke,
    isNative: isDesktopLauncher,
    onSessionExpired: (endpoint) => {
        const server = selectedServer();
        if (!server || server.endpoint !== endpoint || !expirePlayerSession(state, server.id)) {
            return;
        }
        render();
        document
            .querySelector<HTMLInputElement>(
                state.loginDraft?.username ? '#player-password' : '#player-username',
            )
            ?.focus();
    },
});
const { playerInvoke, refreshPlayerSession, refreshMapLibrary, restoreSelectedServer } =
    createLauncherController({
        state,
        remoteApi,
        invoke,
        isDesktopLauncher,
        selectedServer,
        onLibraryChange: render,
    });
let lastContentKey = '';
let lastLibraryFocusAt = 0;

window.addEventListener('focus', () => {
    const server = selectedServer();
    if (
        !server ||
        state.page !== 'servers' ||
        !state.serverBootstrap?.supported ||
        state.busy ||
        state.libraryLoading ||
        state.pendingFavoriteMapIds.length
    ) {
        return;
    }
    if (state.serverBootstrap.loginRequired && !state.player) {
        return;
    }
    // Avoid replacing an input while the player is typing with an IME.
    if (document.activeElement instanceof HTMLInputElement) {
        return;
    }
    if (Date.now() - lastLibraryFocusAt < 750) {
        return;
    }
    lastLibraryFocusAt = Date.now();
    void refreshMapLibrary(server).then(() => {
        if (state.page === 'servers' && state.selectedId === server.id) {
            render();
        }
    });
});

document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        const search = document.querySelector<HTMLInputElement>('#map-search');
        if (search) {
            event.preventDefault();
            search.focus();
            search.select();
        }
    }
    if (
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') ||
        event.key === 'F5'
    ) {
        event.preventDefault();
        if (!state.busy) {
            if (state.page === 'packages') {
                void refreshStorage({ state, playerInvoke, render });
            } else {
                document.querySelector<HTMLButtonElement>('[data-action="discover"]')?.click();
            }
        }
    }
    if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        if (state.playerMenuOpen) {
            state.playerMenuOpen = false;
            render();
        }
    }
});

function selectedServer():PlayerServer | null {
    return state.servers.find((server) => server.id === state.selectedId) || null;
}

function serverPage():string {
    return renderServerPage(state, selectedServer(), { icon, escapeHtml });
}

function render():void {
    // Metadata may arrive while an input method still owns the focused input.
    if (composingInput?.isConnected) {
        renderAfterComposition = true;
        return;
    }
    renderAfterComposition = false;
    const focused =
        document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    const focusId = focused?.id;
    const selection =
        focused && ['text', 'search', 'url', 'password'].includes(focused.type)
            ? [focused.selectionStart, focused.selectionEnd]
            : null;
    const contentKey = `${state.page}:${state.selectedId}`;
    const contentScroll =
        contentKey === lastContentKey ? document.querySelector('.content')?.scrollTop || 0 : 0;
    lastContentKey = contentKey;
    app.innerHTML =
        `
    <main class="shell">
      <aside class="sidebar">
        <header class="brand"><img class="brand-icon" src="${brandIcon}" alt="" /><span class="brand-copy"><strong>BOX3 Player</strong><small>本地游玩</small></span></header>
        <div class="sidebar-section">
          <div class="sidebar-section-heading"><span>已添加的服务器</span><button class="icon-button" data-nav="add-server" title="添加服务器">${icon('plus')}</button></div>
          <div class="server-list">${serverRows()}</div>
        </div>
        <div class="sidebar-bottom"><button class="storage-nav ${state.page === 'packages' ? 'active' : ''}" data-nav="packages">${icon('device')}本机存储</button><span class="launcher-copyright">©深圳奇梦岛科技有限公司 版权所有</span></div>
      </aside>
      <section class="main-area">
        ${state.error || state.notice ? `<div class="toast ${state.error ? 'danger' : 'success'}" role="status"><span>${state.error ? '操作未完成' : '操作完成'}</span><small>${escapeHtml(state.error || state.notice)}</small><button type="button" data-dismiss-feedback aria-label="关闭提示">×</button></div>` : ''}
        <main class="content ${state.page === 'home' || (state.page === 'servers' && !selectedServer()) ? 'welcome-content' : ''} ${state.page === 'add-server' ? 'add-server-content' : ''}">${state.page === 'packages' ? renderStoragePage(state, escapeHtml) : serverPage()}</main>
      </section>
    </main>` +
        serverAddressNoticeDialog() +
        removeServerDialog();
    bindEvents({
        state,
        playerInvoke,
        remoteApi,
        selectedServer,
        refreshPlayerSession,
        refreshMapLibrary,
        render,
    });
    bindDialogFocus();
    if (focusId) {
        const next = document.getElementById(focusId) as HTMLInputElement | null;
        if (next && !next.disabled) {
            next.focus({ preventScroll: true });
            if (selection) {
                next.setSelectionRange(selection[0], selection[1]);
            }
        }
    }
    const content = document.querySelector('.content');
    if (content) {
        content.scrollTop = contentScroll;
    }
}

async function bootstrap() {
    try {
        const launcher = await playerInvoke('launcher_state');
        state.servers = launcher.servers || [];
        state.selectedId = launcher.selectedServerId || state.servers[0]?.id || '';
        state.page = 'home';
        if (isDesktopLauncher()) {
            state.activeGame = await invoke('game_status');
            await listen<PlayerLauncherState['activeGame']>('game-state', ({ payload }) => {
                state.activeGame = payload;
                if (!payload && state.page === 'packages') {
                    void refreshStorage({ state, playerInvoke, render });
                    return;
                }
                if (state.storage) {
                    state.storage.rows = state.storage.rows.map((row) => ({
                        ...row,
                        inUse: row.serverId === payload?.serverId,
                    }));
                }
                render();
            });
        }
        await restoreSelectedServer();
    } catch (error) {
        state.error = `无法读取本机启动器数据：${error}`;
    }
    render();
}

bootstrap();
