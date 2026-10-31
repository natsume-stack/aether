import type { PlayerLauncherState } from '../../types';

function formatBytes(bytes:number):string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024,
        index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(1)} ${units[index]}`;
}

export function renderStoragePage(
    state:PlayerLauncherState,
    escapeHtml:(value:unknown) => string,
):string {
    const storage = state.storage;
    const rows = (storage?.rows || []).filter((row) => row.maps?.length);
    const browserBytes = (storage?.rows || []).reduce((sum, row) => sum + row.httpBytes, 0);
    const browserBusy = (storage?.rows || []).some((row) => row.inUse);
    const browserCache =
        browserBytes > 0 && !storage?.loading
            ? `<section class="storage-browser-section" aria-labelledby="browser-cache-title">
    <div class="section-heading"><h2 id="browser-cache-title">浏览器缓存</h2></div>
    <div class="storage-browser-cache">
    <div class="browser-cache-copy"><h3>网页与字体</h3><p>网页和字体等通用数据，不包含地图资源或账号。</p>${browserBusy ? '<small class="browser-cache-warning">关闭游戏窗口后即可清理。</small>' : ''}</div>
    <div class="browser-cache-actions"><strong class="browser-cache-size">${formatBytes(browserBytes)}</strong>
      ${storage?.confirmBrowser ? `<div class="storage-confirm"><span>确定清理？</span><button class="button" data-cancel-cache>取消</button><button class="button danger" data-confirm-browser-cache ${state.busy ? 'disabled' : ''}>确认</button></div>` : `<button class="button secondary" data-clear-browser-cache ${browserBusy || state.busy ? 'disabled' : ''}>清理缓存</button>`}
    </div>
    </div>
  </section>`
            : '';
    const selected = rows.find((row) => row.serverId === storage?.selectedServerId);
    const server = state.servers.find((item) => item.id === selected?.serverId);
    const feedback = storage?.error
        ? `<p class="inline-error" role="alert">${escapeHtml(storage.error)}</p>`
        : '';
    const loading = storage?.loading ? '<p role="status">正在读取本机缓存…</p>' : '';
    if (!selected || !server) {
        return `<section class="page">
    <div class="page-heading"><h1>本机存储</h1></div>
    ${feedback}${loading}
    ${storage?.loading ? '' : '<div class="section-heading"><h2>地图缓存</h2></div>'}
    <div class="storage-list">${
        rows
            .map((usage) => {
                const item = state.servers.find((candidate) => candidate.id === usage.serverId);
                if (!item) {
                    return '';
                }
                const bytes = usage.maps.reduce((sum, map) => sum + map.bytes, 0);
                return `<button class="surface storage-row storage-server-trigger" data-open-storage-server="${escapeHtml(item.id)}">
        <div><h3>${escapeHtml(item.name || item.endpoint)}</h3><p>${escapeHtml(item.endpoint)}</p>
        <small>${usage.maps.length} 张缓存地图 · 地图资源 ${formatBytes(bytes)}</small></div>
        <span aria-hidden="true">›</span>
      </button>`;
            })
            .join('') ||
        (!storage?.loading
            ? '<div class="empty-maps surface"><h3>暂无地图缓存</h3><p>游玩地图后，有缓存的服务器会显示在这里。</p></div>'
            : '')
    }</div>
    ${browserCache}
  </section>`;
    }
    const confirmingAll = storage?.confirmServerId === server.id;
    return `<section class="page">
    <button class="button secondary storage-back" data-storage-back>‹ 返回服务器列表</button>
    <div class="page-heading"><h1>${escapeHtml(server.name || server.endpoint)}</h1><p>${escapeHtml(server.endpoint)}</p></div>
    ${feedback}${loading}
    <div class="section-heading"><h2>已缓存的地图</h2>
      ${confirmingAll ? `<div class="storage-confirm"><span>清理此服务器的全部地图缓存？</span><button class="button" data-cancel-cache>取消</button><button class="button danger" data-confirm-cache="${escapeHtml(server.id)}" ${state.busy ? 'disabled' : ''}>确认清理</button></div>` : `<button class="button secondary" data-clear-cache="${escapeHtml(server.id)}" ${selected.inUse || state.busy ? 'disabled' : ''}>清理全部地图缓存</button>`}
    </div>
    ${selected.inUse ? '<p class="field-help">游戏正在运行，关闭游戏窗口后即可清理缓存。</p>' : ''}
    <div class="storage-list">${selected.maps
        .map(
            (
                map,
            ) => `<article class="surface storage-row" data-map-cache="${escapeHtml(map.mapId)}">
      <div><h3>${escapeHtml(map.name)}</h3><small>${map.resources} 项资源 · ${formatBytes(map.bytes)}</small></div>
      ${storage?.confirmMapId === map.mapId ? `<div class="storage-confirm"><span>清理这张地图的缓存？</span><button class="button" data-cancel-cache>取消</button><button class="button danger" data-confirm-map-cache="${escapeHtml(map.mapId)}" ${state.busy ? 'disabled' : ''}>确认清理</button></div>` : `<button class="button secondary" data-clear-map-cache="${escapeHtml(map.mapId)}" ${selected.inUse || state.busy ? 'disabled' : ''}>清理地图缓存</button>`}
    </article>`,
        )
        .join('')}</div>
  </section>`;
}
