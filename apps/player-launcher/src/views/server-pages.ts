import { playerSkinOptions } from '../features/player/skins';
import { SERVER_ADDRESS_HELP_TEXT } from '../features/servers/address-notice';
import { renderMapBrowser } from '../features/maps/browser';

function renderPlayerAccountControl(state, { icon, escapeHtml }) {
    if (!state.player) {
        return '';
    }
    const displayName = state.player.displayName || state.player.username || '已登录用户';
    const username = state.player.username || '';
    const skin =
        playerSkinOptions.find((item) => item.id === state.player.avatarSkinId) ||
        playerSkinOptions[0];

    return `
    <div class="player-account-control">
      <button class="player-account-trigger" type="button" data-action="toggle-player-menu" aria-haspopup="menu" aria-expanded="${state.playerMenuOpen}">
        <img src="${skin.preview}" alt="" class="player-account-avatar">
        <span class="player-account-copy"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(username)}</small></span>
        ${icon('chevron')}
      </button>
      ${
          state.playerMenuOpen
              ? `<div class="player-account-menu" role="menu">
        <div class="player-account-menu-identity"><strong>${escapeHtml(displayName)}</strong><small>${escapeHtml(username)}</small></div>
        <button type="button" role="menuitem" data-action="open-player-settings">账号设置</button>
        <button type="button" role="menuitem" data-action="logout">退出登录</button>
      </div>`
              : ''
      }
    </div>`;
}

function renderPlayerSettings(state, { icon, escapeHtml }) {
    if (!state.playerSettingsOpen || !state.player) {
        return '';
    }
    const username = state.player.username || '';
    return `
    <div class="player-profile-backdrop" data-player-profile-backdrop>
      <section class="player-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="player-profile-title">
        <header class="player-profile-heading">
          <div>
            <h2 id="player-profile-title">账号设置</h2>
            <p>昵称和角色皮肤仅在此服务器下生效。</p>
          </div>
          <button type="button" class="player-profile-close" data-close-player-settings aria-label="关闭">${icon('close')}</button>
        </header>
        <form id="player-profile-form">
          <div class="player-profile-content">
            <label class="player-profile-field">
              <span>玩家账号</span>
              <input value="${escapeHtml(username)}" disabled readonly>
              <small>账号由服务器管理，不可修改。</small>
            </label>
            <label class="player-profile-field" for="player-profile-name">
              <span>显示昵称</span>
              <input id="player-profile-name" name="displayName" value="${escapeHtml(state.playerProfileName || state.player.displayName || username)}" maxlength="32" required ${state.busy ? 'disabled' : ''}>
            </label>
            <fieldset class="player-profile-skin-field">
              <legend>角色皮肤</legend>
              <div class="player-profile-skins">
                ${playerSkinOptions
                    .map(
                        (
                            skin,
                        ) => `<button class="player-profile-skin ${state.playerProfileSkinId === skin.id ? 'selected' : ''}" type="button" data-player-skin="${skin.id}" aria-pressed="${state.playerProfileSkinId === skin.id}" ${state.busy ? 'disabled' : ''}>
                  <img src="${skin.preview}" alt="">
                  <span>${skin.name}</span>
                </button>`,
                    )
                    .join('')}
              </div>
            </fieldset>
            ${state.playerProfileError ? `<p class="player-profile-error" role="alert">${escapeHtml(state.playerProfileError)}</p>` : ''}
          </div>
          <footer class="player-profile-actions">
            <button class="button secondary" type="button" data-close-player-settings ${state.busy ? 'disabled' : ''}>取消</button>
            <button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在保存…' : '保存设置'}</button>
          </footer>
        </form>
      </section>
    </div>`;
}

export function renderServerPage(state, server, { icon, escapeHtml }) {
    if (state.page === 'home') {
        const hasServers = state.servers.length > 0;
        return `
      <section class="page welcome-page">
        <h1>准备好开始游玩了吗？</h1>
        <p>${hasServers ? '你已添加服务器，从左侧选择一个服务器开始游玩。' : '添加一个私服地址。启动器会为你找到可玩的地图，并在进入前自动准备好所需资源。'}</p>
        ${hasServers ? '' : `<button class="button primary" data-nav="add-server">${icon('plus')}添加服务器</button>`}
      </section>`;
    }

    if (state.page === 'add-server') {
        return `
    <section class="page narrow">
      <div class="page-heading"><h1>添加服务器</h1><p>输入服主提供的游玩地址。添加后，启动器会显示该服务器开放的地图。</p></div>
      <form id="server-form" class="surface add-form">
        <label for="server-endpoint">服务器地址</label>
        <div class="input-row"><span class="input-icon">${icon('globe')}</span><input id="server-endpoint" name="endpoint" value="${escapeHtml(state.endpointInput)}" placeholder="请输入游玩端服务器 IP 或域名" autocomplete="url" required autofocus ${state.busy ? 'disabled' : ''} /></div>
        <p class="field-help">${escapeHtml(SERVER_ADDRESS_HELP_TEXT)}</p>
        <div class="form-actions"><button type="button" class="button secondary" data-nav="home">取消</button><button class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在检查服务器…' : '添加服务器'}${icon('arrow')}</button></div>
      </form>
    </section>`;
    }

    if (!server) {
        return `
    <section class="page welcome-page">
      <h1>准备好开始游玩了吗？</h1>
      <p>从左侧选择一个服务器，或添加新的服务器开始游玩。</p>
    </section>`;
    }

    const editingName = state.editingServerId === server.id;
    const bootstrap = state.serverBootstrap;
    const loginRequired = bootstrap?.supported && bootstrap.loginRequired;
    const needsLogin = loginRequired && !state.player;

    return `
    <section class="page ${needsLogin ? 'login-required-page' : ''}">
      <div class="page-heading server-heading">
        <div class="server-heading-top">
          <div class="server-heading-copy">
            ${
                editingName
                    ? `
              <form id="server-name-form" class="server-name-edit">
                <input id="server-name-input" name="name" value="${escapeHtml(state.serverNameInput)}" maxlength="40" aria-label="服务器昵称" required autofocus ${state.busy ? 'disabled' : ''} />
                <button class="title-icon-button save-name" type="submit" title="保存昵称" aria-label="保存昵称" ${state.busy ? 'disabled' : ''}>${icon('check')}</button>
                <button class="title-icon-button" type="button" data-action="cancel-server-name" title="取消编辑" aria-label="取消编辑">${icon('close')}</button>
              </form>`
                    : `
              <div class="server-title-row">
                <h1>${escapeHtml(server.name || server.endpoint)}</h1>
                <button class="title-icon-button" type="button" data-action="edit-server-name" title="编辑服务器昵称" aria-label="编辑服务器昵称">${icon('edit')}</button>
              </div>`
            }
            <p>${escapeHtml(server.endpoint)}</p>
          </div>
          ${renderPlayerAccountControl(state, { icon, escapeHtml })}
        </div>
      </div>
      ${renderMapBrowser(state, server, { icon, escapeHtml })}
      ${renderPlayerSettings(state, { icon, escapeHtml })}
    </section>`;
}
