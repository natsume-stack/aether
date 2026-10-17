import { state } from '../../core/state.js';
import { input } from '../../ui/forms.js';
import { escapeHtml } from '../../ui/html.js';
import { icon } from '../../ui/icons.js';
import { serviceModeChoice } from './controls.js';

const field = (name, label, value, type = 'text', limits = {}) =>
    input(name, label, value, type, '', Boolean(limits.required), { hideHint: true, ...limits });

function databaseFields(config) {
    return `<div class="form-grid compact database-fields">
        ${field('databaseHost', '服务器地址', config.databaseHost === 'managed-postgres' ? '' : config.databaseHost, 'text', { placeholder: 'IP 或域名', required: true })}
        ${field('databasePort', '端口', config.databasePort || '5432', 'number', { min: 1, max: 65535, required: true })}
        ${field('databaseName', '数据库', config.databaseName || 'box', 'text', { required: true })}
        ${field('databaseUser', '账号', config.databaseUser || 'box', 'text', { required: true })}
        ${input('databasePassword', '密码', '', 'password', config.databasePassword ? '本次配置已输入，保存时会使用' : config.hasDatabasePassword ? '留空保留原密码' : '无密码认证可留空')}
    </div><details class="setup-advanced" data-disclosure="database-advanced"><summary>高级连接设置</summary>
        <div class="form-grid compact">
            ${field('databasePoolSize', '每运行时连接池', config.databasePoolSize ?? 10, 'number', { min: 1, max: 100 })}
            <label class="check-field"><input name="databaseSsl" type="checkbox" ${config.databaseSsl ? 'checked' : ''}/><span>使用 SSL</span></label>
        </div>
    </details>`;
}

function redisFields(config) {
    return `<div class="form-grid compact database-fields">
        ${field('redisHost', '服务器地址', config.redisHost === 'managed-redis' ? '' : config.redisHost, 'text', { placeholder: 'IP 或域名', required: true })}
        ${field('redisPort', '端口', config.redisPort || '6379', 'number', { min: 1, max: 65535, required: true })}
        ${input('redisPassword', '密码', '', 'password', config.redisPassword ? '本次配置已输入，保存时会使用' : config.hasRedisPassword ? '留空保留原密码' : '外部 Redis 无密码时可留空')}
    </div><details class="setup-advanced" data-disclosure="redis-advanced"><summary>高级缓存设置</summary>
        <div class="form-grid compact three">
            ${field('redisDb', '业务 DB', config.redisDb ?? 0, 'number', { min: 0, max: 255 })}
            ${field('storageCacheRedisDb', '缓存 DB', config.storageCacheRedisDb ?? 1, 'number', { min: 0, max: 255 })}
            ${field('storageCacheRedisTtl', '缓存时间（秒）', config.storageCacheRedisTtl ?? 240, 'number', { min: 0, max: 255 })}
        </div>
    </details>`;
}

export function dataServices() {
    const config = state.config || {};
    const databaseMode = config.databaseMode || 'managed';
    const redisMode = config.redisMode || 'disabled';
    const connectionButton = (service) =>
        `<button type="button" class="text-button" data-test-connection="${service}">测试连接</button>`;
    return `<div class="config-group data-service-group">
        <div class="group-title"><h2>PostgreSQL</h2>${databaseMode === 'external' ? connectionButton('postgresql') : ''}</div>
        <input name="databaseMode" type="hidden" value="${databaseMode}"/>
        ${serviceModeChoice(
            'data-database-mode',
            [
                ['managed', '内置数据库'],
                ['external', '外部数据库'],
            ],
            databaseMode,
        )}
        ${databaseMode === 'managed' ? managedServicePanel('postgresql', state.managedDatabaseInfo) : databaseFields(config)}
    </div><div class="config-group data-service-group">
        <div class="group-title"><h2>Redis</h2>${redisMode === 'external' ? connectionButton('redis') : ''}</div>
        <input name="redisMode" type="hidden" value="${redisMode}"/>
        ${serviceModeChoice(
            'data-redis-mode',
            [
                ['disabled', '不启用'],
                ['managed', '内置 Redis'],
                ['external', '外部 Redis'],
            ],
            redisMode,
        )}
        ${redisMode === 'managed' ? managedServicePanel('redis', state.managedRedisInfo) : redisMode === 'external' ? redisFields(config) : ''}
    </div>`;
}

function managedServicePanel(service, info) {
    const isDatabase = service === 'postgresql';
    const label = isDatabase ? 'PostgreSQL 16' : 'Redis 7';
    if (!info?.imageAvailable) {
        return `<div class="managed-install-card"><strong>尚未安装 ${label}</strong><button type="button" class="button primary" data-install-managed="${service}" ${state.busy ? 'disabled' : ''}>立即下载</button></div>`;
    }
    if (!info?.configured) {
        return `<div class="managed-install-card"><strong>内置 ${label} 已下载</strong><button type="button" class="button primary" data-install-managed="${service}" ${state.busy ? 'disabled' : ''}>启用并启动</button></div>`;
    }
    const fields = [
        ['地址', info.host],
        ['端口', info.port],
        ...(isDatabase
            ? [
                  ['数据库', info.database],
                  ['账号', info.user],
              ]
            : [
                  ['业务 DB', info.database],
                  ['缓存 DB', '1'],
              ]),
        ['密码', info.password],
    ];
    return `<div class="managed-connection-card">
        <div class="managed-connection-heading"><span class="managed-state ${info.running ? 'running' : 'stopped'}">${info.running ? '正在运行' : '当前未运行'}</span>${info.running ? '' : `<button type="button" class="button" data-install-managed="${service}" ${state.busy ? 'disabled' : ''}>启动服务</button>`}</div>
        <details class="managed-connection-details" data-disclosure="connection-${service}"><summary>连接信息</summary><dl class="managed-connection-grid">${fields.map(([name, value]) => `<div><dt>${name}</dt><dd><code>${escapeHtml(value)}</code><button type="button" class="copy-connection" data-copy-managed="${escapeHtml(value)}" aria-label="复制${name}" title="复制${name}">${icon('copy')}</button></dd></div>`).join('')}<div class="connection-url"><dt>连接地址</dt><dd><code>${escapeHtml(info.connectionUrl)}</code><button type="button" class="copy-connection" data-copy-managed="${escapeHtml(info.connectionUrl)}" aria-label="复制连接地址" title="复制连接地址">${icon('copy')}</button></dd></div></dl></details>
    </div>`;
}
