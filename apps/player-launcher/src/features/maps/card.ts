import type { PlayWorld } from '../../types';

export function renderWorldCard(world:PlayWorld, state, { escapeHtml }) {
    const preparing = state.preparingMapId === world.id;
    const active =
        state.activeGame?.serverId === state.selectedId &&
        state.activeGame?.mapId === (world.publicId || world.id);
    const label = preparing ? state.launchStage || '正在连接…' : active ? '返回游戏' : '开始游玩';
    const cover = world.cover || '';
    const onlineCount = Math.max(0, Number(world.onlineCount) || 0);
    const favoriteId = world.publicId || world.id;
    const favorite = state.favoriteMapIds?.includes(favoriteId);
    const star =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.75 5.58 6.16.9-4.46 4.35 1.05 6.14L12 17.07l-5.5 2.9 1.05-6.14-4.46-4.35 6.16-.9L12 3Z"/></svg>';

    return `<article class="world-card surface">
    <div class="world-cover-frame">
      ${
          cover
              ? `<img class="world-cover" src="${escapeHtml(cover)}" alt="" loading="lazy">`
              : '<div class="world-cover-placeholder" aria-hidden="true">◇</div>'
      }
      <span class="world-online">${onlineCount} 人在线</span>
      ${state.libraryEnabled ? `<button class="world-favorite ${favorite ? 'is-favorite' : ''}" type="button" data-action="toggle-favorite" data-map-id="${escapeHtml(favoriteId)}" aria-label="${favorite ? '取消收藏' : '收藏地图'}" aria-pressed="${Boolean(favorite)}" title="${favorite ? '取消收藏' : '收藏地图'}" ${state.busy || state.libraryLoading || state.pendingFavoriteMapIds?.includes(favoriteId) ? 'disabled' : ''}>${star}</button>` : ''}
    </div>
    <div class="world-copy">
      <h3>${escapeHtml(world.name || '未命名地图')}</h3>
      <p>${escapeHtml(world.description || '由服务器提供的可游玩地图。')}</p>
      <small>${escapeHtml(world.author || '未知作者')} · ${escapeHtml(world.version || '未知版本')}</small>
      <button class="button ${preparing ? 'secondary' : 'primary'}" type="button" data-action="prepare-map" data-map-id="${escapeHtml(world.id)}" ${state.busy || preparing ? 'disabled' : ''}>${label}</button>
    </div>
  </article>`;
}
