import { normalizeServerAddress } from '../../shared/server-address';
import {
    isAllowedPlayerApi,
    playerBootstrapPath,
    playerAuthBaseUrl,
    isPlayerLoginUrl,
} from '../../shared/api-policy';

import type { PlayerSessionStore } from '../storage/player-session-store';
import type { ApiRequest, ApiResponse, ApiTransport } from '../types';
import type { ApiRequestTiming } from './request-diagnostics';

const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const PLAYER_COOKIE_NAMES = new Set(['box_local_player_session', 'box_local_player_device']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const BLOCKED_REQUEST_HEADERS = new Set(['host', 'origin', 'referer', 'content-length', 'cookie']);

function normalizeEndpoint(value:string):URL {
    return new URL(normalizeServerAddress(value));
}

function cookieChanges(setCookieHeaders:string[]):Map<string, string | null> {
    const changes = new Map<string, string | null>();
    for (const header of setCookieHeaders) {
        const [pair = '', ...attributes] = String(header).split(';');
        const separator = pair.indexOf('=');
        if (separator < 1) {
            continue;
        }
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (!PLAYER_COOKIE_NAMES.has(name)) {
            continue;
        }
        const expires = attributes.some(
            (attribute) =>
                /^\s*max-age\s*=\s*-?\d+\s*$/i.test(attribute) &&
                Number(attribute.split('=')[1]) <= 0,
        );
        changes.set(name, expires || !value ? null : `${name}=${value}`);
    }
    return changes;
}

function mergeCookies(existing:string, setCookieHeaders:string[]):string {
    const cookies = new Map<string, string>();
    for (const pair of String(existing || '').split(';')) {
        const separator = pair.indexOf('=');
        if (separator > 0) {
            cookies.set(pair.slice(0, separator).trim(), pair.trim());
        }
    }
    for (const [name, value] of cookieChanges(setCookieHeaders)) {
        if (value) {
            cookies.set(name, value);
        } else {
            cookies.delete(name);
        }
    }
    return [...cookies]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, pair]) => pair)
        .join('; ');
}

function validateRequestUrl(
    endpointUrl:URL,
    rawUrl:string,
    authPortalOrigin?:string,
    method?:string,
):URL {
    let url:URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('API 请求地址无效');
    }
    if (!isAllowedPlayerApi(endpointUrl, url, authPortalOrigin, method)) {
        throw new Error('API 请求必须指向当前游玩服务器的 /api/ 接口');
    }
    return url;
}

function rememberAuthPortal(endpoint:string, body:string, origins:Map<string, string>):void {
    origins.delete(endpoint);
    try {
        const bootstrap = JSON.parse(body);
        origins.set(endpoint, playerAuthBaseUrl(bootstrap.loginApiUrl));
    } catch {
        /* A malformed bootstrap cannot authorize an external login origin. */
    }
}

export function createApiTransport({
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    loginTimeoutMs = 30_000,
    onTiming,
    sessionStore,
}:{
    fetchImpl?:typeof fetch;
    sessionStore?:PlayerSessionStore;
    timeoutMs?:number;
    loginTimeoutMs?:number;
    onTiming?:(record:ApiRequestTiming) => void;
} = {}):ApiTransport {
    const playerCookies = new Map<string, string>();
    const authOrigins = new Map<string, string>();
    const versions = new Map<string, number>();
    function readCookies(endpoint:string):string {
        if (!playerCookies.has(endpoint)) {
            let saved = '';
            try {
                saved = sessionStore?.read(endpoint) || '';
            } catch {
                /* Keep login usable if storage fails. */
            }
            const safe = saved
                .split(';')
                .map((pair) => pair.trim())
                .filter((pair) =>
                    /^(box_local_player_session|box_local_player_device)=[^;\s\r\n]*$/.test(pair),
                )
                .join('; ');
            playerCookies.set(endpoint, safe);
        }
        return playerCookies.get(endpoint) || '';
    }
    function saveCookies(endpoint:string, value:string):void {
        playerCookies.set(endpoint, value);
        try {
            if (value) {
                sessionStore?.write(endpoint, value);
            } else {
                sessionStore?.delete(endpoint);
            }
        } catch {
            /* OS storage failure must not disclose credentials or block in-memory login. */
        }
    }
    function clearCookies(endpoint:string):void {
        versions.set(endpoint, (versions.get(endpoint) || 0) + 1);
        saveCookies(endpoint, '');
    }

    return Object.freeze({
        async request({
            endpoint: rawEndpoint,
            url: requestUrl,
            method: rawMethod,
            headers = [],
            body = null,
        }:ApiRequest):Promise<ApiResponse> {
            const endpointUrl = normalizeEndpoint(rawEndpoint);
            const endpoint = endpointUrl.toString().replace(/\/$/, '');
            const method = String(rawMethod || '').toUpperCase();
            const startedAt = Date.now();
            let budget = timeoutMs;
            let targetUrl:URL | undefined;
            let status:number | undefined;
            let contentType:string | undefined;
            let outcome:ApiRequestTiming['outcome'] = 'blocked';
            let controller:AbortController | undefined;
            let timer:ReturnType<typeof setTimeout> | undefined;
            let version = versions.get(endpoint) || 0;
            try {
                targetUrl = validateRequestUrl(
                    endpointUrl,
                    requestUrl,
                    authOrigins.get(endpoint),
                    method,
                );
                if (!ALLOWED_METHODS.has(method)) {
                    throw new Error('不支持的 API 请求方法');
                }
                if (method === 'POST' && isPlayerLoginUrl(targetUrl)) {
                    budget = loginTimeoutMs;
                    version += 1;
                    versions.set(endpoint, version);
                }
                const requestHeaders = new Headers();
                for (const [name, value] of headers) {
                    if (!BLOCKED_REQUEST_HEADERS.has(String(name).toLowerCase())) {
                        requestHeaders.set(name, value);
                    }
                }
                const existingCookies = readCookies(endpoint);
                if (existingCookies) {
                    requestHeaders.set('cookie', existingCookies);
                }
                controller = new AbortController();
                timer = setTimeout(() => controller.abort(), budget);
                outcome = 'connection-error';
                const response = await fetchImpl(targetUrl, {
                    method,
                    headers: requestHeaders,
                    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
                    redirect: 'manual',
                    signal: controller.signal,
                });
                status = response.status;
                contentType = response.headers.get('content-type')?.slice(0, 80);
                outcome = 'response-error';
                if (Number(response.headers.get('content-length')) > MAX_API_RESPONSE_BYTES) {
                    await response.body?.cancel();
                    throw new Error('服务器 API 响应超过启动器安全上限');
                }
                const chunks:Uint8Array[] = [];
                let responseBytes = 0;
                if (response.body) {
                    const reader = response.body.getReader();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            break;
                        }
                        responseBytes += value.byteLength;
                        if (responseBytes > MAX_API_RESPONSE_BYTES) {
                            await reader.cancel();
                            throw new Error('服务器 API 响应超过启动器安全上限');
                        }
                        chunks.push(value);
                    }
                }
                const bytes = new Uint8Array(responseBytes);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                let text:string;
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                } catch {
                    throw new Error('服务器 API 响应不是有效文本');
                }
                const setCookieHeaders = response.headers.getSetCookie?.() || [];
                if (version === (versions.get(endpoint) || 0)) {
                    if (response.status === 401 && !isPlayerLoginUrl(targetUrl)) {
                        clearCookies(endpoint);
                    } else if (setCookieHeaders.length) {
                        saveCookies(
                            endpoint,
                            mergeCookies(readCookies(endpoint), setCookieHeaders),
                        );
                    }
                }
                if (targetUrl.pathname.endsWith(playerBootstrapPath)) {
                    rememberAuthPortal(endpoint, text, authOrigins);
                }
                const responseHeaders = [...response.headers.entries()].filter(
                    ([name]) => name !== 'set-cookie',
                );
                outcome = response.ok ? 'ok' : 'http-error';
                return { status: response.status, headers: responseHeaders, body: text };
            } catch (error) {
                if (controller?.signal.aborted || error.name === 'AbortError') {
                    outcome = 'timeout';
                    throw new Error('API 请求超时，请稍后重试');
                }
                if (
                    outcome === 'blocked' ||
                    (outcome === 'response-error' && String(error.message).startsWith('服务器 API'))
                ) {
                    throw error;
                }
                outcome = 'connection-error';
                const code = error.cause?.code || error.code;
                if (code === 'ECONNREFUSED') {
                    throw new Error('服务器服务未启动或连接端口不可用');
                }
                if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                    throw new Error('无法解析服务器地址，请检查地址后重试');
                }
                if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
                    throw new Error('服务器连接被中断，请重新尝试');
                }
                throw new Error('无法连接到游玩端服务器，请检查地址和网络');
            } finally {
                clearTimeout(timer);
                try {
                    onTiming?.({
                        at: new Date(startedAt).toISOString(),
                        origin: targetUrl?.origin || endpointUrl.origin,
                        path: targetUrl?.pathname || '(blocked)',
                        method: ALLOWED_METHODS.has(method) ? method : 'INVALID',
                        elapsedMs: Date.now() - startedAt,
                        timeoutMs: budget,
                        status,
                        contentType,
                        outcome,
                    });
                } catch {
                    /* Diagnostic recording cannot fail a player request. */
                }
            }
        },
        clear(endpoint) {
            const normalized = normalizeEndpoint(endpoint).toString().replace(/\/$/, '');
            clearCookies(normalized);
        },
        forget(endpoint) {
            const normalized = normalizeEndpoint(endpoint).toString().replace(/\/$/, '');
            clearCookies(normalized);
            authOrigins.delete(normalized);
        },
        cookies(endpoint) {
            const normalized = normalizeEndpoint(endpoint).toString().replace(/\/$/, '');
            return readCookies(normalized)
                .split(';')
                .map((part) => part.trim().split('='))
                .filter(([name]) => PLAYER_COOKIE_NAMES.has(name))
                .map(([name, value]) => [name, value || ''] as [string, string]);
        },
    });
}

export { mergeCookies, normalizeEndpoint, validateRequestUrl };
