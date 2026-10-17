import releaseNotes from '../../../../distribution/release-notes.json';
import { escapeHtml } from '../ui/html.js';
import { formatBeijingBuildTime, formatBuildSource } from '../utils/format.js';
import { hasWebManagerToken, isWebManager } from '../infrastructure/transport.js';
import { icon } from '../ui/icons.js';
import { state } from '../core/state.js';

export function about() {
    const info = state.about || {};
    const legal = state.legal || {};
    const managementAvailable = !isWebManager() || hasWebManagerToken();
    const version = info.applicationVersion || (managementAvailable ? '读取中' : '登录后查看');
    const versionLabel = /^\d/.test(version) ? `v${version}` : version;
    const serviceImages = Array.isArray(info.serviceImages) ? info.serviceImages : [];
    const imageRows = serviceImages.length
        ? serviceImages
              .map(
                  (
                      service,
                  ) => `<details class="about-image-row" data-disclosure="about-image-${escapeHtml(service.name)}">
            <summary><span class="about-image-summary"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.platform)}</small></span><code class="about-component-version">${escapeHtml(service.tag)}</code><span class="about-disclosure-icon">${icon('chevron')}</span></summary>
            <dl class="about-image-meta">
                <div><dt>镜像名称</dt><dd>${escapeHtml(service.image)}</dd></div>
                <div><dt>镜像标识</dt><dd>${escapeHtml(service.imageId)}</dd></div>
                <div><dt>构建提交</dt><dd>${escapeHtml(service.sourceRevision || '未知')}</dd></div>
                <div><dt>构建来源</dt><dd>${escapeHtml(formatBuildSource(service.buildSource))}</dd></div>
                <div><dt>构建时间</dt><dd>${escapeHtml(formatBeijingBuildTime(service.createdAt))}</dd></div>
            </dl>
        </details>`,
              )
              .join('')
        : `<div class="about-image-empty">${managementAvailable ? '正在读取组件镜像信息…' : '登录后查看组件镜像信息'}</div>`;
    const changelogRows = releaseNotes
        .map(
            (
                release,
            ) => `<details class="about-changelog-row" data-disclosure="about-release-${escapeHtml(release.version)}">
        <summary><span class="about-changelog-summary"><strong>v${escapeHtml(release.version)}</strong><small>${escapeHtml(release.summary)}</small></span><time>${escapeHtml(release.date)}</time><span class="about-disclosure-icon">${icon('chevron')}</span></summary>
        <div class="about-changelog-sections">${release.sections.map((section) => `<section class="about-changelog-section"><h3>${escapeHtml(section.title)}</h3><ol>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>`).join('')}</div>
    </details>`,
        )
        .join('');
    const updateLabel = state.updateChecking
        ? '检查中…'
        : state.updateRelease
          ? '查看更新'
          : '检查更新';
    const protectedDocuments = managementAvailable
        ? `<button type="button" class="about-document-row" id="open-community-group"><span class="about-link-icon">${icon('external')}</span><span><strong>服主交流群</strong><small>QQ群 1107448537</small></span>${icon('chevron')}</button><button type="button" class="about-document-row" id="export-about-diagnostics" ${state.busy ? 'disabled' : ''}><span class="about-link-icon">${icon('archive')}</span><span><strong>导出诊断包</strong><small>脱敏服务状态与日志</small></span>${icon('chevron')}</button>`
        : '';
    const licenseDocument = `<button type="button" class="about-document-row" data-open-legal-document="license"><span class="about-link-icon">${icon('info')}</span><span><strong>开源许可</strong><small>${escapeHtml(legal.licenseName || 'MIT License')}</small></span>${icon('chevron')}</button>`;
    const repositoryDocument = `<button type="button" class="about-document-row" data-open-project-repository><span class="about-link-icon">${icon('external')}</span><span><strong>GitHub 仓库</strong><small>源码与版本发布</small></span>${icon('chevron')}</button>`;
    return `<header><div><h1>关于</h1></div></header><section class="about-page">
        <article class="about-release-card">
            <div class="about-product"><img src="/logo512.png" alt="BOX3 Engine"/><div><div class="about-product-title"><h2>BOX3 Engine</h2><span class="about-version">${escapeHtml(versionLabel)}</span></div><p>${isWebManager() ? '服务器管理端' : '桌面启动器'}</p></div></div>
            ${managementAvailable ? `<button type="button" class="button about-update-button" data-check-version-updates ${state.updateChecking ? 'disabled' : ''}>${icon('refresh')}<span>${updateLabel}</span></button>` : ''}
            <dl class="about-release-facts"><div><dt>引擎开发</dt><dd>深圳奇梦岛科技有限公司</dd></div><div><dt>构建时间</dt><dd>${escapeHtml(formatBeijingBuildTime(info.buildCreatedAt))}</dd></div></dl>
        </article>
        <article class="about-card about-links-card"><div class="about-document-list">${protectedDocuments}${repositoryDocument}${licenseDocument}</div></article>
        ${managementAvailable ? `<div class="about-content-layout"><article class="about-card"><div class="about-card-heading"><h2>更新日志</h2></div><div class="about-changelog-list">${changelogRows}</div></article><article class="about-card"><div class="about-card-heading"><h2>服务组件</h2><span>${serviceImages.length ? `${serviceImages.length} 个组件` : ''}</span></div><div class="about-image-list">${imageRows}</div></article></div>` : ''}
    </section>`;
}
