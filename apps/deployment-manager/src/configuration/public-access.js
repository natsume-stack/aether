import { state } from '../core/state.js';
import { parsePublicEndpoint, pathPrefix } from './public-service-address.js';

export { pathPrefix } from './public-service-address.js';

export const publicServices = [
    ['play', 'Play', 'playPublicAddressOverride', 'playPort', 3121],
    ['creator', 'ARENA', 'creatorPublicAddressOverride', 'creatorPort', 3127],
    ['voxa', 'VOXA', 'voxaPublicAddressOverride', 'voxaPort', 3123],
    ['player-service', '后台管理', 'playerServicePublicAddressOverride', 'playerServicePort', 3124],
    ['player-auth-portal', '登录页面', 'authPortalPublicAddressOverride', 'authPortalPort', 3125],
];
export const isPublicMode = (mode) =>
    mode === 'public' || mode === 'public-shared' || mode === 'public-independent';
export function accessChoice(config = state.config || {}) {
    const mode = state.accessMode || config.playNetworkMode || 'local';
    return mode === 'public'
        ? config.publicAddressMode === 'shared'
            ? 'public-shared'
            : 'public-independent'
        : mode;
}
export function externalProtocol(config = state.config || {}) {
    if (state.externalGuideProtocol) {
        return state.externalGuideProtocol;
    }
    const address =
        config.publicAddressMode === 'shared'
            ? config.sharedPublicAddress
            : publicServices.map(([, , field]) => config[field]).find(Boolean);
    return /^http:\/\//i.test(address || '') ? 'http' : 'https';
}
export function publicCertificateFlags(config = state.config || {}) {
    if ((state.sslDraft?.mode || state.sslStatus?.provider) === 'external') {
        return Object.fromEntries([
            ...publicServices.map(([service]) => [service, externalProtocol(config) === 'https']),
            ['shared', externalProtocol(config) === 'https'],
        ]);
    }
    const authoritative = state.sslStatus && Object.hasOwn(state.sslStatus, 'config');
    const saved = authoritative ? state.sslStatus.config : null;
    const flags = authoritative ? {} : { ...config.publicSslConfigured };
    const legacyShared = saved?.expiresAt && !Object.keys(saved.certificateSources || {}).length;
    for (const [service] of publicServices) {
        const files = state.sslFiles?.[service];
        flags[service] = Boolean(
            (files?.certificate && files?.privateKey) ||
                (files?.inputMode === 'path' && files?.certificatePath && files?.privateKeyPath) ||
                saved?.certificateExpiries?.[service] ||
                (legacyShared &&
                    saved?.settings?.routes?.some((route) => route.service === service)) ||
                flags[service],
        );
    }
    flags.shared = Boolean(
        (state.sslFiles?.shared?.certificate && state.sslFiles?.shared?.privateKey) ||
            (state.sslFiles?.shared?.inputMode === 'path' &&
                state.sslFiles.shared.certificatePath &&
                state.sslFiles.shared.privateKeyPath) ||
            legacyShared ||
            Object.entries(saved?.certificateSources || {}).some(
                ([service, source]) => source === 'shared' && saved.certificateExpiries?.[service],
            ) ||
            flags.shared,
    );
    return flags;
}
export function publicEndpoints(config = state.config || {}, { activeOnly = false } = {}) {
    const active = (service) => {
        const mode =
            config[
                ['creator', 'voxa'].includes(service) ? 'creatorNetworkMode' : 'playNetworkMode'
            ];
        return !mode || isPublicMode(mode);
    };
    if (activeOnly && !publicServices.some(([service]) => active(service))) {
        return [];
    }
    const shared = config.publicAddressMode === 'shared';
    const certificates = publicCertificateFlags(config);
    const base = shared
        ? parsePublicEndpoint({
              value: config.sharedPublicAddress,
              label: '共用公网地址',
              port: 80,
              secure: certificates.shared,
              shared: true,
          })
        : null;
    if (base && base.pathname !== '/') {
        throw new Error('共用地址只填写协议和 IP 或域名，自定义路径请在各服务中填写');
    }
    return publicServices.flatMap(([service, label, field, key, fallback]) => {
        if (activeOnly && !active(service)) {
            return [];
        }
        const url = shared
            ? base
                ? new URL(base.href)
                : null
            : parsePublicEndpoint({
                  value: config[field],
                  label: `${label} 公网地址`,
                  port: Number(config[key] || fallback),
                  secure: certificates[service],
              });
        if (!url) {
            return [];
        }
        const explicit = shared ? config.publicServicePaths?.[service] : undefined;
        const prefix = pathPrefix(explicit?.trim() ? explicit : shared ? '' : url.pathname);
        if (shared && !prefix) {
            url.port = String(config[key] || fallback);
        }
        url.pathname = prefix || '/';
        return [
            {
                service,
                label,
                field,
                url: url.href.replace(/\/$/, ''),
                domain: url.hostname.replace(/^\[|\]$/g, ''),
                port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
                secure: url.protocol === 'https:',
                path: prefix,
            },
        ];
    });
}
