import {
    accessChoice,
    isPublicMode,
    publicServices,
    publicEndpoints,
} from '../../configuration/public-access.js';
import { escapeHtml } from '../../ui/html.js';
import { icon } from '../../ui/icons.js';
import { input, settingToggle, setupExplanation } from '../../ui/forms.js';
import { isWebManager } from '../../infrastructure/transport.js';
import { progressPanel } from '../../ui/shell.js';
import { state } from '../../core/state.js';
import { authPortalImageSetting } from './auth-portal.js';
import { externalNginxEntry, externalProtocolSetting } from './external-nginx.js';
import { nginxMode } from '../../configuration/ssl.js';
import { nginxSetting, sslCertificateSetting } from './ssl.js';
import { dataServices } from './data-services.js';
import { setupNavigation, setupSectionLabel } from './navigation.js';

export function setup() {
    const config = state.config || {};
    const choice = accessChoice(config);
    const accessMode = isPublicMode(choice) ? 'public' : choice;
    const shared = choice === 'public-shared';
    const paths = config.publicServicePaths || {};
    const portInput = (name, label, value) =>
        input(name, label, value, 'number', '', false, { hideHint: true, min: 1, max: 65535 });
    const endpointAddressInput = (name, label) => {
        const service = publicServices.find(([, , field]) => field === name)?.[0];
        if (accessMode !== 'public') {
            return `<input name="${name}" type="hidden" value="${escapeHtml(config[name] || '')}"/><input name="publicPath-${service}" type="hidden" value="${escapeHtml(paths[service] || '')}"/>`;
        }
        let preview = '';
        if (shared) {
            try {
                preview =
                    publicEndpoints(config).find((endpoint) => endpoint.service === service)?.url ||
                    '';
            } catch {}
        }
        return `<div class="network-endpoint-setting">${shared ? `<input name="${name}" type="hidden" value="${escapeHtml(config[name] || '')}"/>` : input(name, '公网地址', config[name] || '', 'text', '', false, { hideHint: true, ariaLabel: `${label} 公网地址`, placeholder: '域名或 IP，可选协议和端口' })}
      ${shared ? input(`publicPath-${service}`, '入口路径（可选）', paths[service] || '', 'text', '', false, { hideHint: true, ariaLabel: `${label} 入口路径`, placeholder: { 'play': '/play', 'creator': '/arena', 'voxa': '/voxa', 'player-service': '/admin', 'player-auth-portal': '/login' }[service] }) : `<input name="publicPath-${service}" type="hidden" value="${escapeHtml(paths[service] || '')}"/>`}
      ${preview ? `<div class="network-endpoint-preview" data-public-preview="${service}" aria-label="实际访问地址"><code>${escapeHtml(preview)}</code></div>` : ''}
      ${shared || nginxMode() === 'external' ? '' : sslCertificateSetting(service)}</div>`;
    };
    const nginxConfigAvailable = Boolean(state.sslStatus?.nginxConfigAvailable);
    const rawNginxPanel = nginxConfigAvailable
        ? `<section class="setup-panel environment-panel ${state.setupSection === 'nginx' ? 'active' : ''}" data-setup-panel="nginx"><div class="config-group raw-config-group"><div class="group-title"><div><h2>原始 Nginx 配置</h2><span>保存前会校验语法，通过后重载内置 Nginx</span></div><button type="button" class="text-button" id="reload-raw-nginx" ${state.nginxConfigSaving ? 'disabled' : ''}>重新读取</button></div><textarea id="raw-nginx-config" class="raw-environment" spellcheck="false" ${state.nginxConfigSaving ? 'disabled' : ''}>${escapeHtml(state.nginxConfigFile)}</textarea></div>${setupExplanation(
              '配置说明：什么时候需要编辑原始 Nginx 配置？',
              [
                  ['适合场景', '需要手动调整代理头、超时、缓冲，或排查入口转发问题时使用。'],
                  [
                      '保存生效',
                      '保存前会先用内置 Nginx 校验语法；通过后写入并重载内置入口。校验失败不会改动现有配置。',
                  ],
                  [
                      '覆盖提醒',
                      '之后在“访问设置”保存配置时，会按页面设置重新生成该文件，手工修改的内容会被覆盖。',
                  ],
                  ['安全提醒', '错误配置可能导致入口不可用；修改前请先记下原内容。'],
              ],
          )}</section>`
        : '';
    const secretCard = (name, label, configured) => {
        const editing = Boolean(state.ownerSecretEditing[name]);
        const secret = config[name] || state.ownerSecrets?.[name] || '';
        const displayValue = configured || secret ? '•'.repeat(16) : '保存配置后自动生成';
        const copied = state.ownerSecretCopied === name;
        return `<article class="secret-row ${editing ? 'editing' : ''}">
      <div class="secret-meta"><strong>${label}</strong></div>
      <div class="secret-control">
        ${
            editing
                ? `<input class="secret-editor" name="${name}" type="text" value="${escapeHtml(secret)}" autocomplete="new-password" spellcheck="false" aria-label="编辑${label}"/>`
                : `<code class="secret-value ${secret || configured ? '' : 'empty'}">${displayValue}</code>`
        }
      </div>
      <div class="secret-actions">
        ${
            editing
                ? `<button type="submit" class="secret-action primary" data-secret-save="${name}" title="保存密钥">${icon('check')}<span>保存</span></button>
               <button type="button" class="secret-action" data-secret-edit="${name}" aria-pressed="true" title="取消编辑">${icon('edit')}<span>取消</span></button>`
                : `<button type="button" class="secret-action" data-secret-edit="${name}" aria-pressed="false" title="编辑密钥">${icon('edit')}<span>编辑</span></button>`
        }
        <button type="button" class="secret-action ${copied ? 'copied' : ''}" data-secret-copy="${name}" title="复制密钥">${icon(copied ? 'check' : 'copy')}<span>${copied ? '已复制' : '复制'}</span></button>
      </div>
    </article>`;
    };
    const rawEnvironmentPanel = `<section class="setup-panel environment-panel ${state.setupSection === 'environment' ? 'active' : ''}" data-setup-panel="environment"><div class="config-group raw-config-group"><div class="group-title"><div><h2>原始 .env</h2><span>含有敏感数据，请勿截图或转发</span></div><button type="button" class="text-button" id="reload-raw-environment" ${state.environmentFileSaving ? 'disabled' : ''}>重新读取</button></div><textarea id="raw-environment" class="raw-environment" spellcheck="false" ${state.environmentFileSaving ? 'disabled' : ''}>${escapeHtml(state.environmentFile)}</textarea></div>${setupExplanation(
        '配置说明：什么时候需要编辑原始 .env？',
        [
            ['适合场景', '需要调整模板中没有展示的高级参数，或排查服主部署问题时使用。'],
            ['保存生效', '保存只写入文件，不会自动重启；请回到总览重新启动受影响的服务。'],
            ['安全提醒', '这里会显示数据库密码和密钥，不要截图、提交到仓库或发送给其他人。'],
        ],
    )}</section>`;
    const storagePath = state.dataStorage?.path || '';
    const dataStoragePanel = `<section class="setup-panel storage-panel ${state.setupSection === 'storage' ? 'active' : ''}" data-setup-panel="storage">
      <section class="config-group data-storage-group" aria-label="数据存储位置">
        <div class="group-title"><div><h2>${isWebManager() ? 'Linux 数据目录' : '数据目录'}</h2></div><button type="button" class="text-button" id="choose-data-storage" ${state.busy || !state.dataStorage ? 'disabled' : ''}>${isWebManager() ? '迁移到此目录' : '更改位置'}</button></div>
        ${isWebManager() ? `<input id="linux-data-directory" class="storage-path" type="text" value="${escapeHtml(storagePath)}" placeholder="/data/BoxEngineData" spellcheck="false"/>` : `<code class="storage-path">${escapeHtml(storagePath || '正在读取…')}</code>`}
      </section>
      ${setupExplanation('配置说明：数据目录如何迁移？', [
          ['迁移内容', '地图、模型、构建产物和备份会一并迁移。'],
          ['开始前', '请先停止全部服务；迁移完成后从服务总览重新启动。'],
          [
              '目录格式',
              isWebManager()
                  ? '填写 Linux 服务器绝对路径，例如 /data/BoxEngineData。'
                  : '请选择目标磁盘中的一个目录。',
          ],
      ])}
    </section>`;
    return `<header><div><h1>数据配置</h1></div></header>
    ${state.busy || state.sslBusy ? progressPanel() : ''}
    <form id="setup-form" novalidate class="${['environment', 'nginx'].includes(state.setupSection) ? 'environment-mode' : ''}">
      ${setupNavigation(nginxConfigAvailable)}
      <div class="setup-panels"><div class="setup-content-heading"><h2>${setupSectionLabel()}</h2></div>
        <section class="setup-panel ${state.setupSection === 'data' ? 'active' : ''}" data-setup-panel="data">
          ${dataServices()}
          ${nginxSetting()}
          ${setupExplanation('配置说明：这些服务用来做什么？', [
              [
                  'PostgreSQL',
                  '用于保存玩家账号、权限和地图脚本等长期数据。桌面启动器可自动管理内置数据库，也可连接外部 PostgreSQL。',
              ],
              [
                  'Redis',
                  '用于缓存和运行时协调，可选择不启用、由启动器管理内置 Redis，或连接外部 Redis。它不是主要数据来源。',
              ],
              [
                  '业务 DB / 缓存 DB',
                  'Redis 中的两个逻辑空间。保持不同编号，避免业务数据和缓存互相影响。',
              ],
              ['连接池', '每个地图运行时可使用的 PostgreSQL 连接数；地图并发较多时不要盲目调高。'],
              ['构建缓存', 'Redis 中预烘焙构建结果的缓存秒数；设为 0 可关闭，推荐保持 240。'],
              [
                  'SSL',
                  '只有远程 PostgreSQL 要求加密连接时才勾选；不确定时按数据库服务商提供的连接要求填写。',
              ],
          ])}
        </section>
        ${dataStoragePanel}
        <section class="setup-panel ${state.setupSection === 'backup' ? 'active' : ''}" data-setup-panel="backup">
          <div class="config-group">
            <div class="group-title">
              <div><h2>自动备份</h2></div>
              <label class="backup-switch"><input name="autoBackupEnabled" type="checkbox" ${config.autoBackupEnabled ? 'checked' : ''}/><span aria-hidden="true"></span><strong>启用</strong></label>
            </div>
            <div class="form-grid compact three">${input('autoBackupIntervalMinutes', '备份间隔（分钟）', config.autoBackupIntervalMinutes || 60, 'number', '1–10080')}${input('autoBackupRetentionCount', '每张地图保留份数', config.autoBackupRetentionCount || 24, 'number', '1–1000')}${input('autoBackupRetentionDays', '最长保留天数', config.autoBackupRetentionDays || 30, 'number', '1–3650')}</div>
          </div>
          ${setupExplanation('配置说明：自动备份会保存什么？', [
              [
                  '备份范围',
                  '按计划导出每个地图组工程，包含地图、资源库与地图配置；不包含 PostgreSQL、Redis 或用户账号数据。',
              ],
              [
                  '保留规则',
                  '每地图保留份数与最长保留天数同时生效，达到任一限制时，最早的自动备份会被清理。',
              ],
              [
                  '关闭后的影响',
                  '关闭后停止创建新的自动备份，不会删除已有备份；已有文件可在左侧“数据与备份”中导出、恢复或删除。',
              ],
              [
                  '立即备份',
                  '需要在重要修改前手动保存时，请前往“数据与备份”使用右上角的“立即备份”。',
              ],
          ])}
        </section>
        <section class="setup-panel ${state.setupSection === 'network' ? 'active' : ''}" data-setup-panel="network">
          <div class="network-layout">
            <section class="network-service-card network-access-card">
              <div class="network-card-heading"><h2>访问范围</h2></div>
              <input name="playNetworkMode" type="hidden" value="${accessMode}"/>
              <input name="creatorNetworkMode" type="hidden" value="${state.accessMode ? accessMode : config.creatorNetworkMode || accessMode}"/>
              <input name="publicAddressMode" type="hidden" value="${shared ? 'shared' : 'independent'}"/>
              <div class="network-access-controls"><div class="access-choice">${[
                  ['local', '本机'],
                  ['lan', '局域网'],
                  ['public-shared', '公网（共用地址）'],
                  ['public-independent', '公网（独立地址）'],
              ]
                  .map(
                      ([mode, label]) =>
                          `<button type="button" class="${choice === mode ? 'active' : ''}" data-network-mode="${mode}" ${mode === 'lan' && !config.lanIp ? 'disabled' : ''}>${label}</button>`,
                  )
                  .join('')}</div>
              ${nginxMode() === 'external' && accessMode === 'public' ? externalProtocolSetting() : ''}</div>
              ${accessMode === 'public' && shared ? `<div class="network-access-address">${input('sharedPublicAddress', '共用公网地址', config.sharedPublicAddress || '', 'text', '', true, { hideHint: true, placeholder: '域名或 IP，可选协议和端口' })}${nginxMode() === 'external' ? '' : sslCertificateSetting('shared')}</div>` : `<input name="sharedPublicAddress" type="hidden" value="${escapeHtml(config.sharedPublicAddress || '')}"/>`}


            </section>
            <div class="network-primary-grid">
              <section class="network-service-card"><div class="network-card-heading"><h2>游玩端</h2></div><div class="form-grid single">${portInput('playPort', 'Play 端口', config.playPort || 3121)}${endpointAddressInput('playPublicAddressOverride', 'Play')}</div></section>
              <section class="network-service-card"><div class="network-card-heading"><h2>创作端</h2></div><div class="form-grid card-port-grid">${portInput('creatorPort', 'ARENA 端口', config.creatorPort || 3127)}${portInput('voxaPort', 'VOXA 端口', config.voxaPort || 3123)}${endpointAddressInput('creatorPublicAddressOverride', 'ARENA')}${endpointAddressInput('voxaPublicAddressOverride', 'VOXA')}</div></section>
            </div>
            <section class="network-service-card player-service-card"><div class="network-card-heading"><h2>账号服务</h2></div><div class="form-grid player-port-grid">${portInput('playerServicePort', '后台管理端口', config.playerServicePort || 3124)}${portInput('authPortalPort', '登录页面端口', config.authPortalPort || 3125)}${endpointAddressInput('playerServicePublicAddressOverride', '后台管理')}${endpointAddressInput('authPortalPublicAddressOverride', '登录页面')}</div></section>
            ${authPortalImageSetting()}
          </div>${
              nginxMode() === 'external' && accessMode === 'public'
                  ? externalNginxEntry()
                  : setupExplanation('配置说明：访问地址、路径与 SSL', [
                        [
                            '访问范围',
                            '本机仅当前电脑访问；局域网供同一网络内的设备访问。公网模式需要安装并运行 Nginx。',
                        ],
                        [
                            '共用地址',
                            '顶部填写一个 IP 或域名，所有服务共用。路径留空时按各服务端口访问，例如 https://abc.example.com:3121。',
                        ],
                        [
                            '独立地址',
                            '各服务分别填写完整地址，支持不同域名或同一域名的不同端口，例如 https://play.example.com 或 https://abc.example.com:3121。',
                        ],
                        [
                            '填写格式',
                            '域名或 IP 可直接填写，也可带端口。未写协议时，有 SSL 证书使用 HTTPS，没有则使用 HTTP；显式填写 http:// 或 https:// 时以填写的协议为准。证书需覆盖对应的域名或 IP。',
                        ],
                        [
                            '入口路径（共用地址）',
                            '仅共用地址模式显示。如 /play、/arena、/login，页面、资源和实时连接会保留此前缀。填写不同路径后，可共享 80 或 443；留空按服务端口访问。独立地址模式直接使用各服务填写的地址。',
                        ],
                        [
                            'SSL 证书',
                            'HTTPS 需上传证书和私钥。共用地址模式只在顶部配置一组，各服务统一使用；独立地址模式分别配置，证书需覆盖对应的域名或 IP。',
                        ],
                        [
                            '保存与生效',
                            '共用地址模式在卡片底部显示最终访问地址。缺少 Nginx 时可保存配置，安装并启动后再次保存，公网入口才会生效。',
                        ],
                    ])
          }
        </section>
        <section class="setup-panel ${state.setupSection === 'capacity' ? 'active' : ''}" data-setup-panel="capacity">
          <div class="config-group"><div class="group-title"><div><h2>实例容量</h2></div></div><div class="form-grid">${input('playRuntimes', '游玩运行时', config.playRuntimes || 8, 'number', '至少 1', false, { min: 1 })}${input('playerLimit', '单实例玩家上限', config.playerLimit || 70, 'number', '1–1000', false, { min: 1, max: 1000 })}${input('creatorEditRuntimes', '编辑运行时', config.creatorEditRuntimes || 6, 'number', '至少 1', false, { min: 1 })}${input('creatorPlayRuntimes', '创作预览', config.creatorPlayRuntimes || 4, 'number', '至少 1', false, { min: 1 })}</div></div>
          <div class="config-group"><div class="group-title"><div><h2>预热策略</h2></div></div><div class="form-grid">${input('playPrewarmRuntimes', 'Play 预热', config.playPrewarmRuntimes ?? 0, 'number', '0 表示按需启动', false, { min: 0 })}${input('creatorEditPrewarmRuntimes', '编辑预热', config.creatorEditPrewarmRuntimes ?? 0, 'number', '0 表示按需启动', false, { min: 0 })}</div></div>
          <div class="config-group"><div class="group-title"><div><h2>脚本与容器资源</h2></div></div><div class="form-grid three">${input('scriptMemoryMb', '单运行时脚本内存', config.scriptMemoryMb ?? 512, 'number', '128–8192 MiB', false, { min: 128, max: 8192 })}${input('playerServiceMemoryMb', '账号服务内存', config.playerServiceMemoryMb ?? 1024, 'number', '推荐 1024 MiB', false, { min: 128, max: 262144 })}${input('playerServiceCpuLimit', '账号服务 CPU', config.playerServiceCpuLimit ?? 1, 'number', '0.1–256 核', false, { min: 0.1, max: 256, step: 'any' })}${input('authPortalMemoryMb', '登录页面内存', config.authPortalMemoryMb ?? 128, 'number', '推荐 128 MiB', false, { min: 64, max: 262144 })}${input('authPortalCpuLimit', '登录页面 CPU', config.authPortalCpuLimit ?? 0.5, 'number', '0.1–256 核', false, { min: 0.1, max: 256, step: 'any' })}${input('creatorMemoryMb', 'Creator 内存', config.creatorMemoryMb ?? 6144, 'number', '推荐 6144 MiB', false, { min: 512, max: 262144 })}${input('creatorCpuLimit', 'Creator CPU', config.creatorCpuLimit ?? 2, 'number', '0.1–256 核', false, { min: 0.1, max: 256, step: 'any' })}${input('playMemoryMb', 'Play 内存', config.playMemoryMb ?? 4096, 'number', '推荐 4096 MiB', false, { min: 512, max: 262144 })}${input('playCpuLimit', 'Play CPU', config.playCpuLimit ?? 2, 'number', '0.1–256 核', false, { min: 0.1, max: 256, step: 'any' })}</div></div>
          <div class="config-group"><div class="group-title"><div><h2>回收与传送</h2></div></div><div class="form-grid">${input('runtimeIdleMinutes', '运行时空闲回收（分钟）', config.runtimeIdleMinutes || 15, 'number', '1–10080')}${input('runtimeStartTimeoutMinutes', '运行时启动超时（分钟）', config.runtimeStartTimeoutMinutes || 30, 'number', '1–1440')}${input('teleportMaxRooms', 'Teleport 私有房间上限', config.teleportMaxRooms || 64, 'number', '1–1024')}${input('teleportRoomIdleMinutes', '房间空闲回收（分钟）', config.teleportRoomIdleMinutes || 15, 'number', '1–10080')}</div></div>
          ${setupExplanation('配置说明：容量和回收策略如何选择？', [
              [
                  '游玩运行时',
                  '同时活跃的游玩地图和传送房间数量。人数、地图数越多，需要的上限越高。',
              ],
              ['单实例玩家', '一张地图的一个公共或私有运行实例能够同时容纳的玩家数量。'],
              ['编辑运行时', '同时打开进行编辑的地图数量；编辑器关闭后会按空闲策略回收。'],
              ['创作预览', '创作端点击运行时使用的预览实例数。'],
              [
                  '预热数量',
                  '提前常驻可减少首次访问等待，但会持续占用 CPU 和内存；设为 0 可按需启动。',
              ],
              ['脚本内存', '每个地图脚本运行时的独立上限，不是整个 Creator 或 Play 容器的总内存。'],
              ['运行时回收', '地图无人连接超过该时间后可被停止；再次访问时会自动启动。'],
              ['启动超时', '大型地图首次迁移和预烘焙允许等待的最长时间。'],
              [
                  '私有房间',
                  '限制 Teleport 可保留的私有房间数量；每个活跃房间仍占用一个游玩运行时。',
              ],
              ['房间回收', '私有房间无人连接超过该时间后，房间 ID 与对应运行时都会失效。'],
              [
                  '容量建议',
                  '上限越高，Docker 可用内存需求越大。首次部署可保持默认，出现排队再逐步提高。',
              ],
          ])}</section>
        <section class="setup-panel ${state.setupSection === 'security' ? 'active' : ''}" data-setup-panel="security"><div class="config-group"><div class="group-title"><div><h2>玩家与后台权限</h2></div></div><div class="setting-toggle-list">${settingToggle('registrationEnabled', '允许新玩家注册', '关闭后登录页面不再接受自助注册', config.registrationEnabled !== false)}</div></div><div class="config-group"><div class="group-title"><div><h2>管理密钥</h2></div></div><div class="secret-list">${secretCard('playAdminToken', '服主管理令牌', config.hasPlayAdminToken)}${secretCard('playerAuthApiKey', '账号服务 API Key', config.hasPlayerAuthApiKey)}${secretCard('permissionTokenSecret', '运行时身份密钥', config.hasPermissionTokenSecret)}</div></div>${setupExplanation(
            '配置说明：管理密钥分别做什么？',
            [
                ['自动生成', '首次保存配置时，三个密钥会自动生成；只有需要自定义时才填写新的值。'],
                [
                    '开放注册',
                    '关闭后新玩家不能自行注册，但已有玩家、服主和后台管理员仍可正常登录。',
                ],
                [
                    '服主管理',
                    '使用服主管理令牌登录玩家管理后台后，可管理后台账号、权限组和游玩地图。管理员能看到和操作的功能仍由其权限组决定。',
                ],
                ['密钥操作', '点击编辑可查看并修改完整密钥，也可直接复制；离开页面后会恢复隐藏。'],
                [
                    '服主管理令牌',
                    '用于验证服主登录，并保护玩家管理后台到游玩端的内部调用；它不直接授予普通管理员页面权限。',
                ],
                ['账号服务 API Key', '供登录、注册或用户接入程序调用账号服务。'],
                ['运行时身份密钥', '用于 Creator 和 Play 之间签发、校验运行时身份。'],
                [
                    '修改影响',
                    '保存新密钥后，旧会话和使用旧密钥的 API 调用会失效；请安全备份，不要分享。',
                ],
            ],
        )}</section>
        ${rawEnvironmentPanel}${rawNginxPanel}
      </div>
      <div class="form-actions submit-actions">${state.setupSection === 'environment' ? `<button class="button primary" type="button" data-save-raw-environment ${state.environmentFileSaving ? 'disabled' : ''}>保存配置</button>` : state.setupSection === 'nginx' ? `<button class="button primary" type="button" data-save-raw-nginx ${state.nginxConfigSaving ? 'disabled' : ''}>保存并重载</button>` : `<button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>保存配置</button>`}</div>
    </form>`;
}
