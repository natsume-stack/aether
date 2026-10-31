import { escapeHtml } from './html.js';
import { input } from './forms.js';
import { state } from '../core/state.js';

export function startScopeDialog() {
    return `<div class="dialog-backdrop" data-start-dialog-dismiss><section class="start-dialog" role="dialog" aria-modal="true" aria-labelledby="start-dialog-title"><header><div><h2 id="start-dialog-title">启动服务</h2><p>选择本次需要运行的服务。</p></div><button class="dialog-close" id="cancel-start" aria-label="取消">×</button></header><div class="start-scope-list"><button data-start-scope="all"><strong>全部服务</strong><span>创作端、游玩与已配置的附属服务</span></button><button data-start-scope="play"><strong>游玩端</strong><span>Play 与游玩所需服务</span></button><button data-start-scope="creator"><strong>创作端</strong><span>地图创作工具及作品管理、模型创作工具与创作所需服务</span></button></div></section></div>`;
}

export function backupConfirmDialog() {
    const dialog = state.backupDialog;
    const restoring = dialog.action === 'restore';
    const title = restoring ? '恢复此备份？' : '删除此备份？';
    const description = restoring
        ? '恢复会停止全部服务，并替换当前地图、游玩包和 VOXA 本地资源。当前未备份的修改将丢失。'
        : '删除后无法恢复此备份文件。';
    const confirmLabel = restoring ? '确认恢复' : '确认删除';
    const envChoice =
        restoring && dialog.hasEnv
            ? `<label class="backup-env-choice"><input type="checkbox" id="restore-backup-env" ${dialog.includeEnv ? 'checked' : ''}/><span>同时恢复备份中的启动器配置（.env）</span></label><p class="backup-env-hint">勾选后会覆盖当前启动器的密码、密钥和访问配置；不勾选则保留当前 .env。</p>`
            : '';
    return `<div class="dialog-backdrop" data-backup-dialog-dismiss><section class="start-dialog backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title"><header><div><h2 id="backup-dialog-title">${title}</h2><p>${description}</p></div></header><div class="backup-dialog-file"><span>备份文件</span><strong>${escapeHtml(dialog.name)}</strong></div>${envChoice}<div class="dialog-actions"><button class="button" id="cancel-backup-action-secondary">取消</button><button class="button ${restoring ? 'primary' : 'danger'}" id="confirm-backup-action">${confirmLabel}</button></div></section></div>`;
}

export function runtimeDestroyDialog() {
    const dialog = state.runtimeDestroyDialog;
    const target = dialog.roomId ? `房间 ${dialog.roomId}` : '这个作品的运行实例';
    return `<div class="dialog-backdrop runtime-destroy-backdrop" data-runtime-destroy-dialog-dismiss><section class="start-dialog runtime-destroy-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-destroy-title"><header><div><h2 id="runtime-destroy-title">销毁运行实例？</h2><p>将销毁${escapeHtml(target)}，不会删除作品数据。</p></div></header><div class="dialog-actions"><button class="button" id="cancel-runtime-destroy-secondary">取消</button><button class="button danger" id="confirm-runtime-destroy">确认销毁</button></div></section></div>`;
}

export function mapRuntimeProfileDialog() {
    const playMaps = state.projectRuntimes?.playMaps || state.projectRuntimes?.play || [];
    const maps = Array.from(
        new Map(
            playMaps
                .filter((project) => project.permanentMapId || project.projectId)
                .map((project) => [project.permanentMapId || project.projectId, project]),
        ).values(),
    );
    const options = maps
        .map(
            (project) =>
                `<option value="${escapeHtml(project.permanentMapId || project.projectId)}">${escapeHtml(project.name || project.projectId)} · ${escapeHtml(project.permanentMapId || project.projectId)}</option>`,
        )
        .join('');
    return `<div class="dialog-backdrop" data-map-runtime-profile-dismiss><section class="start-dialog map-runtime-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="map-runtime-profile-title"><header><div><h2 id="map-runtime-profile-title">新增游玩地图配置</h2></div><button class="dialog-close" id="cancel-map-runtime-profile" aria-label="关闭">×</button></header>${maps.length ? `<form id="map-runtime-profile-form"><input name="mode" type="hidden" value="play"/><div class="form-grid compact"> <label class="field"><span>游玩地图</span><select name="permanentMapId" required>${options}</select><small>来自当前游玩端地图</small></label>${input('playerLimit', '人数上限', '70', 'number', '', true, { min: 1, max: 10000 })}${input('roomLimit', '房间上限', '64', 'number', '', true, { min: 1, max: 10000 })}${input('idleTimeoutMs', '无用户时存活时间（ms）', '900000', 'number', '900000 = 15 分钟', true, { min: 1000, max: 604800000 })}</div><label class="runtime-isolation-switch"><input type="checkbox" data-runtime-isolation-toggle/><span aria-hidden="true"></span><div><strong>使用独立容器</strong><small>仅在需要固定 CPU 或内存限制时开启</small></div></label><div class="form-grid compact runtime-isolation-fields">${input('cpuMilli', 'CPU 上限（m）', '', 'number', '1000 m = 1 个 CPU 核心', false, { min: 1, max: 128000, disabled: true })}${input('memoryMb', '内存上限（MB）', '', 'number', '例如 512 MB', false, { min: 64, max: 1048576, disabled: true })}</div><div class="dialog-actions"><button class="button" type="button" id="cancel-map-runtime-profile-secondary">取消</button><button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>保存配置</button></div></form>` : '<div class="runtime-empty">当前没有可配置的游玩地图。</div>'}</section></div>`;
}

export function legalDocumentDialog() {
    const legal = state.legal || {};
    const title = '发行许可证';
    const meta = legal.licenseName || 'MIT License';
    const document = legal.licenseText || '正在读取许可证全文…';
    return `<div class="dialog-backdrop legal-dialog-backdrop" data-legal-dialog-dismiss><section class="legal-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-dialog-title"><header><div><h2 id="legal-dialog-title">${title}</h2><p>${escapeHtml(meta)}</p></div><button class="dialog-close" id="close-legal-dialog" aria-label="关闭">×</button></header><pre class="legal-document-content">${escapeHtml(document)}</pre></section></div>`;
}
