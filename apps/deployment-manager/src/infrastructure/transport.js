/**
 * The deployment console deliberately knows nothing about its host runtime.
 *
 * Desktop uses Tauri commands while the headless package uses the same command
 * names over an authenticated HTTP endpoint.  Keeping this boundary here
 * prevents UI code from gradually growing `if (tauri)` branches.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { ApiClient } from '@box/apis';

const WEB_TOKEN_KEY = 'box-server-manager-token';

function isTauri() {
    return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function webToken() {
    return sessionStorage.getItem(WEB_TOKEN_KEY) || '';
}

export function isWebManager() {
    return !isTauri();
}

export function setWebManagerToken(token) {
    if (token) {
        sessionStorage.setItem(WEB_TOKEN_KEY, token);
    } else {
        sessionStorage.removeItem(WEB_TOKEN_KEY);
    }
    closeEvents();
    if (token) {
        ensureEvents();
    }
}

export function hasWebManagerToken() {
    return Boolean(webToken());
}

function managerApi(authenticated = true) {
    const token = authenticated ? webToken() : '';
    if (authenticated && !token) {
        throw new Error('请先输入 Linux Web 管理令牌');
    }
    return {
        token,
        api: new ApiClient({
            credentials: 'same-origin',
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
            defaultErrorMessage: '服务器管理请求失败',
        }),
    };
}

function unwrapManagerResult(result, token = '') {
    const body = result.data || result.error || {};
    if (!result.response.ok) {
        if (result.response.status === 401 && token && webToken() === token) {
            setWebManagerToken('');
        }
        throw new Error(body.message || `请求失败：${result.response.status}`);
    }
    return { body, response: result.response };
}

// Explicit opt-in: background reads must never publish into the active task's progress.
const PROGRESS_COMMANDS = new Set([
    'start_services',
    'stop_services',
    'control_service',
    'prepare_managed_database',
    'prepare_managed_redis',
    'start_managed_service',
    'save_configuration_command',
    'apply_ssl_config',
    'reload_ssl_proxy',
    'install_nginx_image',
    'set_nginx_provider',
    'stop_ssl_proxy',
    'verify_ssl_endpoint',
    'save_raw_environment',
    'save_raw_nginx_config',
    'create_backup',
    'restore_backup',
    'export_diagnostics',
    'destroy_project_runtime',
    'relocate_data_storage',
    'start_server_update',
]);

const progressHandlers = new Set();
const operations = new Set();

// getRandomValues also works on HTTP LAN origins where randomUUID is unavailable.
function operationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const topicHandlers = new Map();
const operationKeys = new Set();
let eventSocket;
let reconnectTimer;
let failures = 0;
let eventDeadline;

function hasSubscriptions() {
    return topicHandlers.size || operationKeys.size;
}
function updateSubscriptions() {
    if (eventSocket && eventSocket.readyState === WebSocket.OPEN) {
        eventSocket.send(
            JSON.stringify({ topics: [...topicHandlers.keys()], operations: [...operationKeys] }),
        );
    }
}
function closeEvents() {
    clearTimeout(reconnectTimer);
    clearTimeout(eventDeadline);
    const previous = eventSocket;
    eventSocket = undefined;
    previous?.close();
}
function ensureEvents() {
    if (
        isTauri() ||
        eventSocket ||
        !hasWebManagerToken() ||
        !hasSubscriptions() ||
        typeof WebSocket === 'undefined'
    ) {
        return;
    }
    const url = new URL('/api/events', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.href);
    eventSocket = ws;
    eventDeadline = setTimeout(() => ws.close(), 10_000);
    ws.onopen = () => {
        if (eventSocket === ws) {
            ws.send(JSON.stringify({ type: 'authenticate', token: webToken() }));
        }
    };
    ws.onmessage = ({ data }) => {
        if (eventSocket !== ws) {
            return;
        }
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            ws.close();
            return;
        }
        if (event.type === 'ready') {
            clearTimeout(eventDeadline);
            failures = 0;
            updateSubscriptions();
            return;
        }
        if (event.type === 'progress' && operationKeys.has(event.id)) {
            for (const handler of [...progressHandlers]) {
                try {
                    handler({ payload: event.payload });
                } catch {
                    /* Observers cannot fail commands. */
                }
            }
        }
        if (event.type === 'snapshot' || event.type === 'error') {
            for (const handler of [...(topicHandlers.get(event.topic) || [])]) {
                try {
                    handler(event.payload, event.type === 'error' ? event.message : undefined);
                } catch {
                    /* Isolate observers. */
                }
            }
        }
    };
    ws.onerror = () => ws.close();
    ws.onclose = (event) => {
        if (eventSocket !== ws) {
            return;
        }
        eventSocket = undefined;
        clearTimeout(eventDeadline);
        for (const handlers of topicHandlers.values()) {
            for (const handler of [...handlers]) {
                try {
                    handler(
                        undefined,
                        event.code === 1008
                            ? '管理令牌无效，请重新登录'
                            : '实时连接断开，正在重连…',
                    );
                } catch {
                    /* Isolate observers. */
                }
            }
        }
        if (event.code === 1008) {
            setWebManagerToken('');
            return;
        }
        if (hasSubscriptions() && hasWebManagerToken()) {
            reconnectTimer = setTimeout(
                ensureEvents,
                Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
            );
        }
    };
}
export function subscribeManager(topic, handler) {
    if (isTauri()) {
        return () => {};
    }
    if (!['overview', 'runtimes', 'performance'].includes(topic)) {
        throw new Error('未知状态订阅');
    }
    const listeners = topicHandlers.get(topic) || new Set();
    // Each subscription has its own lifetime even when callbacks are reused.
    const listener = (...args) => handler(...args);
    listeners.add(listener);
    topicHandlers.set(topic, listeners);
    ensureEvents();
    updateSubscriptions();
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            topicHandlers.delete(topic);
        }
        if (hasSubscriptions()) {
            updateSubscriptions();
        } else {
            closeEvents();
        }
    };
}
function trackProgress(id) {
    operationKeys.add(id);
    ensureEvents();
    updateSubscriptions();
    const stop = () => {
        operationKeys.delete(id);
        operations.delete(stop);
        if (hasSubscriptions()) {
            updateSubscriptions();
        } else {
            closeEvents();
        }
    };
    operations.add(stop);
    return stop;
}

export async function invoke(command, payload = {}) {
    if (isTauri()) {
        return tauriInvoke(command, payload);
    }
    const id = PROGRESS_COMMANDS.has(command) ? operationId() : null;
    const stop = id && progressHandlers.size && hasWebManagerToken() ? trackProgress(id) : () => {};
    try {
        const { api, token } = managerApi(command !== 'get_legal_notices');
        const result = await api.postApiCommandsNameRaw({
            params: { path: { name: command } },
            headers: id ? { 'X-Operation-Id': id } : undefined,
            body: payload,
        });
        const { body } = unwrapManagerResult(result, token);
        return body.result;
    } finally {
        stop();
    }
}

export async function listen(event, handler) {
    if (isTauri()) {
        return tauriListen(event, handler);
    }
    if (event !== 'install-progress') {
        return () => {};
    }
    // Each subscription has an independent lifetime, even for the same callback.
    const subscription = (value) => handler(value);
    progressHandlers.add(subscription);
    return () => {
        progressHandlers.delete(subscription);
        if (!progressHandlers.size) {
            for (const stop of operations) {
                stop();
            }
        }
    };
}

export function dockerPlatform() {
    return isWebManager()
        ? {
              name: '服务器 Docker',
              hint: 'Docker 服务未连接。此管理页运行在 Docker 内；请通过 SSH 执行 `sudo systemctl start docker`，然后重新检测。',
              action: '重新检测 Docker',
              busy: '正在检测…',
              canStart: false,
          }
        : {
              name: 'Docker Desktop',
              hint: '请先启动 Docker Desktop，连接成功后才能配置和启动服务。',
              action: '启动 Docker 服务',
              busy: '正在启动…',
              canStart: true,
          };
}

export async function openExternal(url, nativeCommand = 'open_service') {
    if (isTauri()) {
        return invoke(
            nativeCommand,
            ['open_service', 'open_release_download'].includes(nativeCommand) ? { url } : {},
        );
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

export async function selectBackup() {
    if (isTauri()) {
        return invoke('import_backup');
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.tar,.tar.gz,application/zip,application/gzip';
    input.hidden = true;
    document.body.append(input);
    const file = await new Promise((resolve) => {
        const finish = (file) => {
            input.removeEventListener('change', change);
            input.removeEventListener('cancel', cancel);
            input.remove();
            resolve(file);
        };
        const change = () => finish(input.files?.[0] || null);
        const cancel = () => finish(null);
        input.addEventListener('change', change);
        input.addEventListener('cancel', cancel);
        input.click();
    });
    return file ? uploadBackup(file) : null;
}

export async function exportBackupFile(archive) {
    if (isTauri()) {
        const path = await invoke('export_backup', { archive });
        return path ? `备份已导出：${path}` : '';
    }
    await downloadBackup(archive);
    return '备份下载已开始。';
}

export async function exportSslConfiguration(content) {
    if (isTauri()) {
        return invoke('export_ssl_configuration');
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'box-engine-https.conf';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}

export async function exportDiagnosticsFile() {
    const destination = await invoke('export_diagnostics');
    if (!destination || isTauri()) {
        return destination;
    }
    await downloadDiagnostics(destination);
    return '诊断文件下载已开始。';
}

export async function uploadBackup(file) {
    if (!isWebManager()) {
        throw new Error('此操作仅用于 Linux Web 管理端');
    }
    const { api, token } = managerApi();
    const result = await api.postApiBackupsUploadRaw({
        headers: {
            'X-Backup-Name': encodeURIComponent(file.name),
        },
        body: file,
        bodySerializer: (body) => body,
    });
    const { body } = unwrapManagerResult(result, token);
    return body.path;
}

async function downloadAuthenticated(request, filename) {
    const { api, token } = managerApi();
    const { body } = unwrapManagerResult(await request(api), token);
    const blob = body instanceof Blob ? body : new Blob([body]);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export async function downloadDiagnostics(archive) {
    if (!isWebManager()) {
        throw new Error('此操作仅用于 Linux Web 管理端');
    }
    await downloadAuthenticated(
        (api) =>
            api.getApiDiagnosticsArchiveDownloadRaw({
                params: { path: { archive } },
                parseAs: 'blob',
            }),
        archive,
    );
}

export async function downloadBackup(archive) {
    if (!isWebManager()) {
        throw new Error('此操作仅用于 Linux Web 管理端');
    }
    await downloadAuthenticated(
        (api) =>
            api.getApiBackupsArchiveDownloadRaw({
                params: { path: { archive } },
                parseAs: 'blob',
            }),
        archive,
    );
}
