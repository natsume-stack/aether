import { state } from '../core/state.js';
import { escapeHtml } from './html.js';

const labels = {
    system: '服务状态',
    config: '部署配置',
    about: '版本信息',
    database: 'PostgreSQL 信息',
    redis: 'Redis 信息',
    storage: '数据目录',
    environment: '环境配置',
};

export function statusFeedback() {
    const failures = Object.entries(state.statusErrors);
    if (!failures.length) {
        return '';
    }
    return `<section class="status-feedback" role="status"><strong>${state.statusErrors.system ? '服务状态读取失败' : '部分信息暂时无法读取'}</strong><p>已保留最近一次读取的信息。请在服务总览刷新状态后重试。</p><details><summary>查看原因（${failures.length} 项）</summary><ul>${failures.map(([key, message]) => `<li><strong>${labels[key] || escapeHtml(key)}</strong>：${escapeHtml(message)}</li>`).join('')}</ul></details></section>`;
}
