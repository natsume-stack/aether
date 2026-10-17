// Docker reports container lifecycle, not application readiness.
export function serviceStatus(service) {
    if (service.enabled === false) {
        return { label: '未启用', tone: 'muted' };
    }
    const lifecycle = String(service.state || '').toLowerCase();
    if (lifecycle === 'unknown') {
        return { label: '状态未知', tone: 'muted' };
    }
    if (lifecycle === 'restarting') {
        return { label: '正在重启', tone: 'warning' };
    }
    if (lifecycle === 'dead' || lifecycle === 'removing') {
        return { label: lifecycle === 'dead' ? '容器异常' : '正在移除', tone: 'warning' };
    }
    if (lifecycle === 'paused') {
        return { label: '已暂停', tone: 'muted' };
    }
    if (lifecycle === 'created') {
        return { label: '待启动', tone: 'muted' };
    }
    return service.running
        ? { label: '运行中', tone: 'running' }
        : { label: '已停止', tone: 'muted' };
}
