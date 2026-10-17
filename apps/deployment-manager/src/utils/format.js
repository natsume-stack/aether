export function formatMetric(value, suffix = '%') {
    return `${Number(value || 0).toFixed(1)}${suffix}`;
}

export function formatDuration(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 1000) {
        return `${milliseconds} ms`;
    }
    if (value % 60000 === 0) {
        return `${value / 60000} 分钟`;
    }
    if (value % 1000 === 0) {
        return `${value / 1000} 秒`;
    }
    return `${value} ms`;
}

export function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatBackupTime(value) {
    if (!value) {
        return '未知时间';
    }
    return new Date(Number(value) * 1000).toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function formatBeijingBuildTime(value) {
    if (!value || value === '未知' || value === 'unknown') {
        return '未知';
    }
    const buildTime = new Date(value);
    if (Number.isNaN(buildTime.getTime())) {
        return value;
    }
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        })
            .formatToParts(buildTime)
            .filter(({ type }) => type !== 'literal')
            .map(({ type, value: part }) => [type, part]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatBuildSource(value) {
    if (value === 'local-dirty') {
        return '本地测试构建（含未提交修改）';
    }
    if (value === 'local') {
        return '本地构建';
    }
    if (value === 'github-actions') {
        return 'GitHub Actions 构建';
    }
    return value || '未知';
}
