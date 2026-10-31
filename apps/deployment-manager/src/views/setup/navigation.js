import { state } from '../../core/state.js';
import { icon } from '../../ui/icons.js';

const groups = [
    [
        '基础设置',
        [
            ['data', '数据服务', 'settings'],
            ['network', '访问设置', 'external'],
            ['capacity', '运行容量', 'performance'],
        ],
    ],
    [
        '数据管理',
        [
            ['storage', '数据目录', 'archive'],
            ['backup', '自动备份', 'refresh'],
        ],
    ],
    [
        '高级设置',
        [
            ['security', '服主与安全', 'eye-off'],
            ['environment', '原始 .env', 'edit'],
            ['nginx', 'Nginx 配置', 'settings'],
        ],
    ],
];

export function setupSectionLabel() {
    return (
        groups.flatMap(([, items]) => items).find(([id]) => id === state.setupSection)?.[1] ||
        '数据服务'
    );
}

export function setupNavigation(nginxAvailable) {
    return `<div class="setup-tabs" role="navigation" aria-label="配置分类">${groups
        .map(
            ([title, items]) =>
                `<div class="setup-nav-group"><span class="setup-nav-label">${title}</span>${items
                    .filter(([id]) => id !== 'nginx' || nginxAvailable)
                    .map(
                        ([id, label, glyph]) =>
                            `<button type="button" class="setup-tab ${state.setupSection === id ? 'active' : ''}" data-setup-section="${id}" ${state.setupSection === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></button>`,
                    )
                    .join('')}</div>`,
        )
        .join('')}</div>`;
}
