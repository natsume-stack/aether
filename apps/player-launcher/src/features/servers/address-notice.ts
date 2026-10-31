import { isIPv4, isLoopback, normalizeServerAddress } from '../../../shared/server-address';

export interface ServerAddressNotice {
    title:string;
    message:string;
}

export const SERVER_ADDRESS_HELP_TEXT =
    '支持域名、IP 和端口。本机地址默认 HTTP。公网地址建议使用 HTTPS。';

/** Returns a confirmation notice for endpoints that may not support safe local caching. */
export function getServerAddressNotice(value:string):ServerAddressNotice | null {
    let url:URL;
    try {
        url = new URL(normalizeServerAddress(value));
    } catch {
        return null;
    }

    const loopback = isLoopback(url.hostname);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const nonLoopbackIp = (host.includes(':') || isIPv4(host)) && !loopback;
    const insecureHttp = url.protocol === 'http:' && !loopback;
    if (!nonLoopbackIp && !insecureHttp) {
        return null;
    }

    if (nonLoopbackIp && insecureHttp) {
        return {
            title: '这个 IP 地址的连接不安全',
            message:
                '仍然可以添加，但账号和连接信息可能被网络中的其他人看到，地图素材也可能无法保存在本机。建议向服主要一个安全连接（HTTPS）地址。',
        };
    }
    if (insecureHttp) {
        return {
            title: '这个服务器连接不安全',
            message:
                '仍然可以添加，但账号和连接信息可能被网络中的其他人看到，地图素材也可能无法保存在本机。建议向服主要一个安全连接（HTTPS）地址。',
        };
    }
    return {
        title: '正在添加 IP 地址',
        message:
            'IP 地址可以使用。如果之后无法连接，建议向服主要一个安全连接（HTTPS）地址；这样地图素材也能保存在本机，下次进入更快。',
    };
}
