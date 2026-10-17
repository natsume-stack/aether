import { escapeHtml } from '../ui/html.js';
import { formatMetric } from '../utils/format.js';
import { services } from '../core/constants.js';
import { state } from '../core/state.js';

export function performance() {
    const samples = state.performance?.services || [];
    const running = samples.filter((service) => service.running);
    const totalCpu = running.reduce((sum, service) => sum + service.cpuPercent, 0);
    const sampledAt = state.performance?.sampledAt
        ? new Date(Number(state.performance.sampledAt)).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
          })
        : '尚未采样';
    return `<header><div><h1>性能监控</h1></div><div class="header-actions"><button class="button" data-page="overview">返回总览</button></div></header>
    <section class="metric-grid"><article><span>运行服务</span><strong>${running.length} / ${samples.filter((service) => service.enabled).length || 0}</strong><small>已启用服务</small></article><article><span>总 CPU</span><strong>${formatMetric(totalCpu)}</strong><small>当前容器合计</small></article><article><span>内存状态</span><strong>${running.length ? '正常采样' : '—'}</strong><small>${sampledAt}</small></article></section>
    <section class="performance-panel"><div class="performance-head"><span>服务</span><span>CPU</span><span>内存</span><span>占用率</span><span>进程</span><span>状态</span></div>${services
        .map(([id, name]) => {
            const item = samples.find((sample) => sample.name === id);
            const enabled = item?.enabled !== false;
            const memoryPercent = Math.min(100, Math.max(0, item?.memoryPercent || 0));
            return `<article class="performance-row ${enabled ? '' : 'disabled'}"><div class="performance-name"><strong>${name}</strong></div><b>${formatMetric(item?.cpuPercent)}</b><div><b>${escapeHtml(item?.memoryUsage || '0 B')}</b><small>/ ${escapeHtml(item?.memoryLimit || '—')}</small></div><div class="memory-meter"><progress class="memory-meter-bar" aria-label="${name} 内存占用率" max="100" value="${memoryPercent}"></progress><b>${formatMetric(memoryPercent)}</b></div><b>${item?.pids || 0}</b><span class="service-state ${item?.running ? 'running' : ''}"><i></i>${!enabled ? '未启用' : item?.running ? '运行中' : '已停止'}</span></article>`;
        })
        .join('')}</section>`;
}
