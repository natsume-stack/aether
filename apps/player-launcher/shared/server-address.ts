const ADDRESS_ERROR = '请输入有效的服务器网址、IPv4 或 IPv6 地址';

function isIPv4(value:string):boolean {
    const parts = value.split('.');
    return (
        parts.length === 4 &&
        parts.every((part) => {
            if (!/^\d{1,3}$/.test(part)) {
                return false;
            }
            const number = Number(part);
            return number >= 0 && number <= 255 && String(number) === part;
        })
    );
}

function isDomain(value:string, allowSingleLabel:boolean):boolean {
    const domain = value.toLowerCase().replace(/\.$/, '');
    if (!domain || domain.length > 253 || /^\d+$/.test(domain)) {
        return false;
    }
    if (
        !allowSingleLabel &&
        !domain.includes('.') &&
        domain !== 'localhost' &&
        !domain.endsWith('.localhost')
    ) {
        return false;
    }
    return domain
        .split('.')
        .every(
            (label) =>
                label.length >= 1 &&
                label.length <= 63 &&
                /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
        );
}

function isLoopback(hostname:string):boolean {
    const host = hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(host)
    );
}

/** Accepts an HTTP(S) URL or a valid domain/IP shorthand, rejecting URL parser's numeric-host coercions. */
export function normalizeServerAddress(value:string):string {
    const raw = String(value || '').trim();
    if (!raw || /\s/.test(raw) || raw.startsWith('//')) {
        throw new Error(ADDRESS_ERROR);
    }

    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
    if (raw.includes('://') && !/^https?:\/\//i.test(raw)) {
        throw new Error(ADDRESS_ERROR);
    }

    const isBareIPv6 =
        !hasScheme &&
        !raw.startsWith('[') &&
        (raw.match(/:/g)?.length || 0) > 1 &&
        !/[/?#]/.test(raw);
    const input = isBareIPv6 ? `https://[${raw}]` : hasScheme ? raw : `https://${raw}`;
    let url:URL;
    try {
        url = new URL(input);
    } catch {
        throw new Error(ADDRESS_ERROR);
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
    ) {
        throw new Error(ADDRESS_ERROR);
    }

    const authority = input.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    const authorityHost = authority.startsWith('[')
        ? authority.slice(0, authority.indexOf(']') + 1)
        : authority.split(':', 1)[0];
    const parsedHost = url.hostname.toLowerCase();
    const bareHost = parsedHost.replace(/^\[|\]$/g, '');
    const numericHost = /^\d+(?:\.\d+)*$/.test(authorityHost);
    if (numericHost) {
        if (!isIPv4(authorityHost) || bareHost !== authorityHost) {
            throw new Error(ADDRESS_ERROR);
        }
    } else if (authorityHost.startsWith('[')) {
        if (!bareHost.includes(':')) {
            throw new Error(ADDRESS_ERROR);
        }
    } else if (!isDomain(parsedHost, hasScheme)) {
        throw new Error(ADDRESS_ERROR);
    }

    const ipv4 = isIPv4(bareHost) ? bareHost.split('.').map(Number) : null;
    const privateIPv4 =
        ipv4 &&
        (ipv4[0] === 10 ||
            (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
            (ipv4[0] === 192 && ipv4[1] === 168));
    if (!hasScheme && (isLoopback(url.hostname) || privateIPv4)) {
        url.protocol = 'http:';
    }
    return url.toString().replace(/\/$/, '');
}

/** HTTPS and loopback HTTP are potentially trustworthy Service Worker origins. */
export function canUseMapResourceCache(endpoint:string):boolean {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
}

export { ADDRESS_ERROR, isIPv4, isLoopback };
