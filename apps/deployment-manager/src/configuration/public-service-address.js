/** Validate one public service address without reading UI state. */
export function parsePublicEndpoint({ value, label, port, secure, shared = false }) {
    if (!value?.trim()) {
        return null;
    }
    const source = value.trim();
    const bare = !source.includes('://');
    const authority = source.split('/')[0];
    const rawIpv6 = !source.startsWith('[') && (authority.match(/:/g) || []).length > 1;
    const normalized = rawIpv6 ? `[${authority}]${source.slice(authority.length)}` : source;
    let url;
    try {
        url = new URL(bare ? `${secure ? 'https' : 'http'}://${normalized}` : source);
    } catch {
        throw new Error(`${label}格式无效`);
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error(`${label}不能包含账号、查询参数或片段`);
    }
    const ip = url.hostname.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname);
    const explicitPort = !rawIpv6 && /:\d+$/.test(authority);
    if (bare && ip && !shared && !explicitPort) {
        url.port = String(port);
    }
    return url;
}

export function pathPrefix(value) {
    if (!value?.trim() || value === '/') {
        return '';
    }
    const path = '/' + value.trim().replace(/^\/+|\/+$/g, '');
    if (
        path.length > 129 ||
        !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path) ||
        /^\/(?:api|_next|runtime|p|player-admin)(?:\/|$)/.test(path)
    ) {
        throw new Error(
            '路径前缀最多 128 个字符，请使用 /play 这样的格式，不能使用 API、资源或运行时的保留路径',
        );
    }
    return path;
}
