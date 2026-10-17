import { dockerPlatform } from '../infrastructure/transport.js';
import { escapeHtml } from '../ui/html.js';
import { getServiceUrl, publicEndpointUrl, sharedNetworkHost } from '../configuration/addresses.js';
import { icon } from '../ui/icons.js';
import { progressPanel } from '../ui/shell.js';
import { services, startPrompts } from '../core/constants.js';
import { state } from '../core/state.js';
import { serviceStatus } from '../ui/service-status.js';

export function overview() {
    // 总览提供业务级启动入口，并将运行中的用户数据服务与本地基础设施分组展示。
    const statusUnavailable = Boolean(state.statusErrors.system);
    const dockerReady = !statusUnavailable && state.status?.dockerReady === true;
    const installed = state.status?.configured;
    const allHealthy = Boolean(state.status?.allHealthy);
    const runningCount = state.status?.services?.filter((service) => service.running).length || 0;
    const summaryLabel = allHealthy
        ? '运行正常'
        : installed && runningCount
          ? `${runningCount} 个服务正在运行中`
          : installed
            ? '未启动'
            : '尚未配置';
    const databaseReady =
        state.config?.databaseMode === 'external'
            ? Boolean(state.config.databaseHost)
            : Boolean(state.managedDatabaseInfo?.configured);
    const canStart = Boolean(installed && databaseReady && !state.busy);
    const runningServices = (state.status?.services || []).filter(
        (service) => service.enabled !== false && service.running,
    );
    const environmentServiceIds = new Set(['creator', 'voxa', 'play']);
    const environmentRunning = runningServices.some((service) =>
        environmentServiceIds.has(service.name),
    );
    const action = (scope, label, detail) =>
        `<button type="button" class="overview-start-option ${state.startScopes.has(scope) ? 'selected' : ''}" data-start-scope="${scope}" aria-pressed="${state.startScopes.has(scope)}" ${canStart ? '' : 'disabled'}><span>${icon('play')}</span><strong>${label}</strong><small>${detail}</small></button>`;
    const actions = statusUnavailable
        ? `<div class="overview-required"><strong>暂时无法读取服务状态</strong><span>请检查管理器连接后重新读取。下方保留最近一次读取的服务信息。</span></div>`
        : !dockerReady
          ? `<div class="overview-required docker-required"><strong>Docker 服务未连接</strong><span>${dockerPlatform().hint}</span><button type="button" class="button primary" id="connect-docker" ${state.busy ? 'disabled' : ''}>${state.busy ? dockerPlatform().busy : dockerPlatform().action}</button></div>`
          : installed
            ? !databaseReady
                ? `<div class="overview-required"><strong>数据库还没有配置</strong><span>配置 PostgreSQL 后即可启动服务。</span><button type="button" class="button primary" data-page="setup">前往数据配置</button></div>`
                : `${environmentRunning ? '' : `<div class="overview-start-options">${action('play', '游玩端', '启动游玩环境，供玩家进入地图')}${action('creator', '创作端', '启动创作环境，用于编辑地图和模型')}</div><button type="button" class="button primary overview-confirm-start" id="confirm-start-scopes" ${state.startScopes.size ? '' : 'disabled'}>确认启动</button>`}${runningCount ? `<button type="button" class="button overview-stop" id="stop" ${state.busy ? 'disabled' : ''}>${icon('stop')}停止所有服务</button>` : ''}`
            : `<button type="button" class="button primary" data-page="setup">开始配置</button>`;
    const idle = Boolean(installed && !runningCount && databaseReady);
    const idlePrompt = idle
        ? state.startPrompt ||
          (state.startPrompt = startPrompts[Math.floor(Math.random() * startPrompts.length)])
        : '';
    const displayLabel =
        installed && !databaseReady ? '需要配置' : idle ? idlePrompt : summaryLabel;
    const needsDatabase = Boolean(dockerReady && installed && !databaseReady);
    const dockerUnavailable = !dockerReady;
    const overviewStatus = needsDatabase
        ? ''
        : dockerUnavailable
          ? ''
          : idle
            ? `<strong>${displayLabel}</strong>`
            : `<span class="status-dot ${allHealthy ? 'good' : ''}"></span><strong>${displayLabel}</strong>`;
    const statusMarkup = overviewStatus
        ? `<div class="overview-status">${overviewStatus}</div>`
        : '';
    const ownerSecretConfigured = Boolean(
        state.config?.hasPlayAdminToken || state.ownerSecrets?.playAdminToken,
    );
    const ownerSecretCopied = state.ownerSecretCopied === 'playAdminToken';
    const ownerSecretMarkup =
        dockerReady && environmentRunning && ownerSecretConfigured
            ? `<div class="overview-owner-secret" aria-label="服主密钥">
    <span>服主密钥</span>
    <code class="${ownerSecretConfigured ? '' : 'empty'}">${ownerSecretConfigured ? '••••••••••••••••' : '未生成'}</code>
    <button type="button" class="overview-owner-secret-copy" data-secret-copy="playAdminToken" aria-label="复制服主密钥" ${ownerSecretConfigured ? '' : 'disabled'}>${icon(ownerSecretCopied ? 'check' : 'copy')}</button>
  </div>`
            : '';
    const userDataServiceIds = new Set(['player-service', 'player-auth-portal']);
    const infrastructureServiceIds = new Set(['managed-postgres', 'managed-redis']);
    const serviceNames = new Map(services.map(([id, name]) => [id, name]));
    serviceNames.set('managed-postgres', 'PostgreSQL');
    serviceNames.set('managed-redis', 'Redis');
    const serviceRows = (items, { openable = true, detail = '' } = {}) =>
        items
            .map((service) => {
                const name = serviceNames.get(service.name);
                if (!name) {
                    return '';
                }
                const url =
                    openable && service.running && !statusUnavailable
                        ? getServiceUrl(service.name)
                        : '';
                const status = service.external
                    ? { label: '外部服务', tone: 'external' }
                    : serviceStatus(service);
                const detailText = typeof detail === 'function' ? detail(service) : detail;
                const detailMarkup = detailText ? `<small>${escapeHtml(detailText)}</small>` : '';
                return `<div class="running-service-row"><div class="running-service-identity"><strong>${name}</strong>${detailMarkup}</div><span class="service-status ${status.tone}">${status.label}</span>${url ? `<button type="button" class="button" data-open="${escapeHtml(url)}" aria-label="打开${escapeHtml(name)}">打开${icon('external')}</button>` : ''}</div>`;
            })
            .join('');
    const environmentOrder = ['creator', 'voxa', 'play'];
    const runningEnvironmentRows = serviceRows(
        environmentOrder
            .map((id) => runningServices.find((service) => service.name === id))
            .filter(Boolean),
    );
    const userDataRows = serviceRows(
        runningServices.filter((service) => userDataServiceIds.has(service.name)),
    );
    const configuredInfrastructureServices = runningServices.filter((service) => {
        if (service.name === 'managed-postgres') {
            return state.config?.databaseMode === 'managed';
        }
        if (service.name === 'managed-redis') {
            return state.config?.redisMode === 'managed';
        }
        return infrastructureServiceIds.has(service.name);
    });
    const externalInfrastructureServices = [
        state.config?.databaseMode === 'external'
            ? { name: 'managed-postgres', external: true }
            : null,
        state.config?.redisMode === 'external' ? { name: 'managed-redis', external: true } : null,
    ].filter(Boolean);
    const infrastructureRows = serviceRows(
        [...configuredInfrastructureServices, ...externalInfrastructureServices],
        {
            openable: false,
            detail: (service) => (service.external ? '' : '本机 Docker 服务'),
        },
    );
    const runningEnvironmentList = runningEnvironmentRows
        ? `<section class="running-services"><h2>创作与游玩</h2><div class="running-service-list">${runningEnvironmentRows}</div></section>`
        : '';
    const userDataList = userDataRows
        ? `<section class="running-services"><h2>用户数据</h2><div class="running-service-list">${userDataRows}</div></section>`
        : '';
    const infrastructureList =
        infrastructureRows && runningCount
            ? `<section class="running-services infrastructure-services"><h2>基础设施</h2><div class="running-service-list">${infrastructureRows}</div></section>`
            : '';
    const supportLists =
        userDataList || infrastructureList
            ? `<div class="overview-support-groups ${userDataList && infrastructureList ? '' : 'single'}">${userDataList}${infrastructureList}</div>`
            : '';
    const performanceAction = runningCount
        ? `<button class="button" data-page="performance">${icon('performance')}性能</button>`
        : '';
    return `<header><div><h1>服务总览</h1></div>
    <div class="header-actions"><button type="button" class="button" id="refresh-service-status" ${state.busy ? 'disabled' : ''}>${icon('refresh')}刷新状态</button>${performanceAction}</div></header>
    ${state.busy ? progressPanel() : ''}
    <section class="overview-simple">${environmentRunning && databaseReady ? `<div class="overview-toolbar">${statusMarkup}${actions}</div>` : `${statusMarkup}${actions}`}${runningEnvironmentList}${supportLists}${ownerSecretMarkup}</section>`;
}

function serviceCard([id, name, description, portKey, defaultPort], options = {}) {
    const service = state.status?.services?.find((item) => item.name === id);
    const enabled = service?.enabled !== false;
    const running = service?.running;
    const openable = options.openable !== false;
    const url = openable ? getServiceUrl(id) : '';
    const port = portKey ? Number(state.config?.[portKey]) || defaultPort : null;
    const host = portKey ? sharedNetworkHost() : '';
    const hostOverrideKey = {
        'creator': 'creatorPublicAddressOverride',
        'voxa': 'voxaPublicAddressOverride',
        'play': 'playPublicAddressOverride',
        'player-service': 'playerServicePublicAddressOverride',
        'player-auth-portal': 'authPortalPublicAddressOverride',
    }[id];
    const serviceHostOverride = state.config?.[hostOverrideKey];
    const endpoint =
        options.endpoint ||
        (port
            ? state.config?.playNetworkMode === 'public' && serviceHostOverride
                ? publicEndpointUrl(serviceHostOverride, port)
                : `${host || '127.0.0.1'}:${port}`
            : '');
    const availability = !enabled ? '需要 PostgreSQL 配置' : description;
    const moreMenu =
        state.serviceMenu === id
            ? `<div class="service-more-menu">${running && url ? `<button data-copy-url="${escapeHtml(url)}">${icon('copy')}复制访问地址</button>` : ''}<button data-service-action="restart" data-service="${id}" ${!running ? 'disabled' : ''}>${icon('refresh')}重启服务</button></div>`
            : '';
    return `<article class="service-card ${enabled ? '' : 'disabled'}"><div class="service-copy"><h3>${name}</h3><p>${availability}${running && endpoint ? `<span>· ${escapeHtml(endpoint)}</span>` : ''}</p></div><span class="service-state ${running ? 'running' : ''}"><i></i>${!enabled ? '未启用' : running ? '运行中' : '已停止'}</span><div class="service-commands">${running && openable ? `<button class="service-open" data-open="${escapeHtml(url)}">打开</button>` : ''}<button class="service-action" data-service-action="${running ? 'stop' : 'start'}" data-service="${id}" ${!enabled || state.busy ? 'disabled' : ''}>${running ? '停止' : '启动'}</button><div class="service-more">${moreMenu}<button class="service-more-trigger" data-service-menu="${id}" aria-expanded="${state.serviceMenu === id}" title="更多操作">•••</button></div></div></article>`;
}
