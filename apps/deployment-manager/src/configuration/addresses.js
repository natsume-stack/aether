import { services } from '../core/constants.js';
import { state } from '../core/state.js';
import { publicEndpoints } from './public-access.js';

export function getServiceUrl(serviceId) {
    const service = services.find(([id]) => id === serviceId);
    if (!service) {
        return '';
    }
    const [, , , portKey, defaultPort, path] = service;
    const mode =
        state.config?.[
            serviceId === 'creator' || serviceId === 'voxa'
                ? 'creatorNetworkMode'
                : 'playNetworkMode'
        ] || 'local';
    const host =
        mode === 'lan'
            ? state.config?.lanIp || '127.0.0.1'
            : mode === 'local'
              ? '127.0.0.1'
              : sharedNetworkHost();
    const port = Number(state.config?.[portKey]) || defaultPort;
    if (mode === 'public') {
        try {
            const endpoint = publicEndpoints().find((endpoint) => endpoint.service === serviceId);
            return endpoint ? `${endpoint.url}${path}` : '';
        } catch {
            return '';
        }
    }
    const authority = host.includes(':') ? `[${host.replace(/^\[|\]$/g, '')}]` : host;
    const scheme = 'http';
    return `${scheme}://${authority}:${port}${path}`;
}

export function sharedNetworkHost() {
    const mode = state.config?.playNetworkMode || 'local';
    if (mode === 'lan') {
        return state.config?.lanIp || '127.0.0.1';
    }
    if (mode === 'public') {
        return state.config?.publicHost || '127.0.0.1';
    }
    return '127.0.0.1';
}

export function publicEndpointUrl(address, port) {
    const normalized = String(address).trim();
    if (/^https?:\/\//i.test(normalized)) {
        return normalized;
    }
    const host = normalized.replace(/^\[|\]$/g, '');
    const isIpAddress = host.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
    if (!isIpAddress) {
        return `http://${host}:${port}`;
    }
    const authority = host.includes(':') ? `[${host}]` : host;
    return `http://${authority}:${port}`;
}

export function hostFromAddress(address) {
    const value = String(address || '').trim();
    if (/^https?:\/\//i.test(value)) {
        try {
            return new URL(value).hostname.replace(/^\[|\]$/g, '');
        } catch {
            return '';
        }
    }
    if (value.startsWith('[')) {
        return value.slice(1, value.indexOf(']'));
    }
    return value.includes(':') ? value : value.split(':')[0];
}
