import { escapeHtml } from '../ui/html.js';
import { formatDuration } from '../utils/format.js';
import { icon } from '../ui/icons.js';
import { state } from '../core/state.js';

function runtimePhase(status = {}) {
    const phase = status.phase || 'idle';
    if (phase === 'ready') {
        return ['运行中', 'running'];
    }
    if (phase === 'starting' || phase === 'loading') {
        return ['启动中', 'starting'];
    }
    if (phase === 'error') {
        return ['异常', 'error'];
    }
    if (phase === 'unavailable') {
        return ['未启动', ''];
    }
    return ['空闲', ''];
}

function runtimeCell(status, projectId, mode) {
    const [labelText, stateClass] = runtimePhase(status);
    const detail =
        status?.message && !['运行时未启动', '等待启动'].includes(status.message)
            ? status.message
            : '';
    const progress = ['starting', 'loading'].includes(status?.phase)
        ? `<progress class="runtime-progress" aria-label="地图运行时准备进度" max="100" value="${Math.max(0, Math.min(100, Number(status?.percent) || 0))}"></progress>`
        : '';
    const metrics =
        status?.phase === 'ready'
            ? `<p class="runtime-metrics">CPU ${formatRuntimeCpu(status)} · 内存 ${status.memoryBytes ? formatRuntimeMemory(status.memoryBytes) : '—'} · ${formatRuntimeUptime(status.uptimeMs)}</p>`
            : '';
    const rooms = Array.isArray(status?.rooms) ? status.rooms : [];
    const roomList = rooms.length
        ? `<div class="runtime-rooms"><strong>房间 ${rooms.length}</strong><div>${rooms
              .map(
                  (room) =>
                      `<span class="runtime-room ${room.active ? 'active' : ''}" title="${escapeHtml(room.roomId)}"><i></i>${escapeHtml(room.roomId.slice(0, 10))}<button type="button" class="icon-button runtime-destroy room" data-runtime-destroy="${escapeHtml(projectId)}" data-runtime-mode="${mode}" data-runtime-room="${escapeHtml(room.roomId)}" aria-label="销毁房间" title="销毁房间">${icon('stop')}</button></span>`,
              )
              .join('')}</div></div>`
        : '';
    const destroy =
        status?.phase === 'ready'
            ? `<button type="button" class="button danger runtime-destroy" data-runtime-destroy="${escapeHtml(projectId)}" data-runtime-mode="${mode}">${icon('stop')}销毁</button>`
            : '';
    return `<div class="runtime-mode"><div class="runtime-mode-info"><div class="runtime-mode-head"><span class="service-state ${stateClass}"><i></i>${labelText}</span></div>${metrics || (detail ? `<p>${escapeHtml(detail)}</p>` : '')}${roomList}${progress}</div>${destroy}</div>`;
}

function formatRuntimeCpu(status = {}) {
    const cpuPercent = Number(status.cpuPercent);
    if (!Number.isFinite(cpuPercent)) {
        return '—';
    }
    const usedCores = Math.max(0, cpuPercent / 100);
    const availableCores = Math.max(
        1,
        Number(status.cpuCapacityCores) || Number(globalThis.navigator?.hardwareConcurrency) || 1,
    );
    const machinePercent = (usedCores / availableCores) * 100;
    const usedText = usedCores >= 10 ? usedCores.toFixed(1) : usedCores.toFixed(2);
    const machineText =
        machinePercent >= 10 ? machinePercent.toFixed(0) : machinePercent.toFixed(1);
    return `${usedText} 核（${machineText}%）`;
}

function formatRuntimeMemory(value) {
    const megabytes = Number(value) / 1024 / 1024;
    return `${Math.max(1, Math.round(megabytes))} MB`;
}

function formatRuntimeUptime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) / 1000));
    if (seconds < 60) {
        return `已运行 ${seconds} 秒`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `已运行 ${minutes} 分钟`;
    }
    return `已运行 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function runtimes() {
    const catalog = state.projectRuntimes || { creator: [], play: [], playMaps: [] };
    const creatorItems = catalog.creator || [];
    const playItems = catalog.play || [];
    const playMapItems = catalog.playMaps || playItems;
    const catalogTab = ['play', 'config'].includes(state.runtimeCatalogTab)
        ? state.runtimeCatalogTab
        : 'creator';
    if (catalogTab === 'config') {
        const profiles = state.mapRuntimeProfiles.filter((profile) => profile.mode === 'play');
        const rows = profiles.length
            ? profiles
                  .map(
                      (profile) =>
                          `<article class="runtime-project runtime-profile-card"><header><div><div class="runtime-profile-title"><h2>${escapeHtml((playMapItems.find((project) => project.permanentMapId === profile.permanentMapId) || {}).name || profile.permanentMapId)}</h2></div><p>地图 ID：<code>${escapeHtml(profile.permanentMapId)}</code> · ${profile.playerLimit} 人 · ${profile.roomLimit} 房间 · ${formatDuration(profile.idleTimeoutMs)}</p></div><div class="runtime-actions"><button type="button" data-runtime-profile-delete="${escapeHtml(profile.permanentMapId)}" data-runtime-profile-mode="play" ${state.busy ? 'disabled' : ''}>删除</button></div></header><div class="runtime-profile-limits">${profile.cpuMilli || profile.memoryMb ? `<strong>独立容器</strong><span>CPU ${profile.cpuMilli || '未限制'} m · 内存 ${profile.memoryMb || '未限制'} MB</span>` : `<strong>共享运行时</strong><span>使用全局 Node 容量</span>`}</div></article>`,
                  )
                  .join('')
            : '<div class="runtime-empty runtime-profile-empty">未单独配置的游玩地图将使用全局人数、房间与空闲回收设置，并运行在共享 Node 中。</div>';
        return `<header><div><h1>地图容器管理</h1></div></header><nav class="runtime-catalog-tabs" aria-label="运行时分类"><button type="button" data-runtime-catalog="creator">创作端 <span>${creatorItems.length}</span></button><button type="button" data-runtime-catalog="play">游玩端 <span>${playItems.length}</span></button><button type="button" data-runtime-catalog="config" class="active">容器配置 <span>${profiles.length}</span></button></nav><section class="runtime-profile-saved"><div class="runtime-profile-saved-heading runtime-profile-actions"><button class="button primary" id="add-map-runtime-profile" ${state.busy || !playMapItems.length ? 'disabled' : ''}>新增配置</button></div><div class="runtime-list runtime-profile-list">${rows}</div></section>`;
    }
    const items = catalogTab === 'play' ? playItems : creatorItems;
    const submapsByMain = new Map();
    const mainMaps = [];
    const activeProjectIds = new Set(items.map((project) => project.projectId));
    for (const project of items) {
        const isSubmap =
            project.mapRole === 'submap' ||
            (project.mainProjectId && project.mainProjectId !== project.projectId);
        if (isSubmap && activeProjectIds.has(project.mainProjectId)) {
            const submaps = submapsByMain.get(project.mainProjectId) || [];
            submaps.push(project);
            submapsByMain.set(project.mainProjectId, submaps);
        } else {
            mainMaps.push(project);
        }
    }
    const runtimeCells = (project) =>
        catalogTab === 'creator'
            ? runtimeCell(project.edit, project.projectId, 'creator')
            : runtimeCell(project.play, project.projectId, 'play');
    const runtimeProject = (project, submaps = []) => {
        const expansionKey = `${catalogTab}:${project.projectId}`;
        const submapSection = submaps.length
            ? `<details class="runtime-submaps" data-runtime-submaps="${escapeHtml(expansionKey)}" ${state.runtimeExpandedProjects.has(expansionKey) ? 'open' : ''}><summary><span class="runtime-submaps-title"><small>共 ${submaps.length} 张</small></span></summary><div class="runtime-submap-list">${submaps
                  .map(
                      (submap) =>
                          `<article class="runtime-submap"><header><div><h3>${escapeHtml(submap.name || submap.projectId)}</h3><p>地图 ID：<code>${escapeHtml(submap.permanentMapId || submap.projectId)}</code></p></div></header><div class="runtime-mode-grid single">${runtimeCells(submap)}</div></article>`,
                  )
                  .join('')}</div></details>`
            : '';
        return `<article class="runtime-project"><header><div><h2>${escapeHtml(project.name || project.projectId)}</h2><p>地图 ID：<code>${escapeHtml(project.permanentMapId || project.projectId)}</code></p></div></header><div class="runtime-mode-grid single">${runtimeCells(project)}</div>${submapSection}</article>`;
    };
    const body =
        state.projectRuntimesLoading && !items.length
            ? '<div class="runtime-empty">正在读取地图容器管理…</div>'
            : state.projectRuntimesError
              ? `<div class="runtime-empty">${escapeHtml(state.projectRuntimesError)}</div>`
              : !mainMaps.length
                ? `<div class="runtime-empty">${catalogTab === 'creator' ? '创作端当前没有已启动的地图容器。' : '游玩端当前没有已启动的地图容器。'}</div>`
                : `<div class="runtime-list">${mainMaps
                      .map((project) =>
                          runtimeProject(project, submapsByMain.get(project.projectId) || []),
                      )
                      .join('')}</div>`;
    return `<header><div><h1>地图容器管理</h1></div><div class="header-actions"><button class="button" id="refresh-project-runtimes" ${state.projectRuntimesLoading ? 'disabled' : ''}>刷新</button></div></header><nav class="runtime-catalog-tabs" aria-label="运行时分类"><button type="button" data-runtime-catalog="creator" class="${catalogTab === 'creator' ? 'active' : ''}">创作端 <span>${creatorItems.length}</span></button><button type="button" data-runtime-catalog="play" class="${catalogTab === 'play' ? 'active' : ''}">游玩端 <span>${playItems.length}</span></button><button type="button" data-runtime-catalog="config">容器配置 <span>${state.mapRuntimeProfiles.length}</span></button></nav>${body}`;
}
