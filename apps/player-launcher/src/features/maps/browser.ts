import { renderLoginCard } from '../player/login-form';
import { renderWorldCard } from './card';
import { filterMapLibrary } from './search';

import type { PlayerLauncherState, PlayerServer } from '../../types';

interface ViewHelpers {
    icon:(name:string) => string;
    escapeHtml:(value:unknown) => string;
}

export function renderMapBrowser(
    state:PlayerLauncherState,
    server:PlayerServer,
    helpers:ViewHelpers,
):string {
    const { icon, escapeHtml } = helpers;
    const bootstrap = state.serverBootstrap;
    const needsLogin = bootstrap?.supported && bootstrap.loginRequired && !state.player;
    const filter = state.mapFilter || 'all';
    const worlds = filterMapLibrary(
        state.worlds,
        state.mapSearch || '',
        filter,
        state.recentWorlds || [],
        state.favoriteMapIds || [],
    );
    const empty = (title:string, message:string, role = '') =>
        `<div class="empty-maps surface" ${role ? `role="${role}"` : ''}><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;

    function content():string {
        if (bootstrap?.loading) {
            return empty('正在检查服务器…', '正在读取服务器支持信息。', 'status');
        }
        if (bootstrap?.error) {
            return empty('无法读取服务器状态', bootstrap.error, 'alert');
        }
        if (!bootstrap?.supported) {
            return empty('服务器暂不支持玩家启动器', '请服主升级 Play 服务后，再重新检查。');
        }
        if (needsLogin) {
            return renderLoginCard(state, server, helpers);
        }
        if (state.mapsError) {
            return empty('暂时无法读取地图', state.mapsError, 'alert');
        }
        if (filter !== 'all') {
            if (state.libraryLoading && !worlds.length) {
                return empty('正在同步地图记录…', '请稍候。', 'status');
            }
            if (state.libraryError) {
                return empty('暂时无法同步地图记录', state.libraryError, 'alert');
            }
            if (!state.libraryEnabled) {
                return empty('收藏和最近游玩暂不可用', '请联系服主开启玩家资料服务。');
            }
        }
        if (worlds.length) {
            return `<div class="world-grid">${worlds.map((world) => renderWorldCard(world, state, { escapeHtml })).join('')}</div>`;
        }
        if (state.mapSearch) {
            return empty('没有找到匹配的地图', '试试其他地图名称或作者。');
        }
        if (filter === 'recent') {
            return empty('还没有最近游玩的地图', '开始游玩后，地图会出现在这里。');
        }
        if (filter === 'favorites') {
            return empty('还没有收藏的地图', '点击作品封面上的星标，即可收藏地图。');
        }
        return empty('暂无可游玩的地图', '该服务器目前没有向你开放的地图。');
    }

    const toolbar = needsLogin
        ? ''
        : `<div class="section-heading map-section-heading">
    <div class="map-filter-tabs" role="tablist" aria-label="地图分类">
      ${(
          [
              ['all', '全部'],
              ['recent', '最近游玩'],
              ['favorites', '收藏'],
          ] as const
      )
          .map(
              ([key, label]) =>
                  `<button class="map-filter-tab ${filter === key ? 'active' : ''}" type="button" role="tab" aria-selected="${filter === key}" data-map-filter="${key}">${label}</button>`,
          )
          .join('')}
    </div>
    <div class="map-tools">
      ${state.worlds.length ? `<input id="map-search" type="search" placeholder="搜索地图或作者" aria-label="搜索地图或作者" value="${escapeHtml(state.mapSearch || '')}" />` : ''}
      <button class="button secondary" data-action="discover" ${state.busy ? 'disabled' : ''}>重新检查</button>
    </div>
  </div>`;
    const feedback =
        !needsLogin && filter === 'all' && state.libraryError
            ? `<p class="field-help" role="status">${escapeHtml(state.libraryError)}</p>`
            : '';
    return `${toolbar}${content()}${feedback}`;
}
