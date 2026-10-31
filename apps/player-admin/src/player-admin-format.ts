/** Display-only helpers. They deliberately have no HTTP or React dependency. */
export const formatBytes = (value = 0) => {
    if (!value) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

export const dateTime = (value?:string) =>
    value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
