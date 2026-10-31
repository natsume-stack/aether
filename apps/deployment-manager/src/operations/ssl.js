import { invoke, exportSslConfiguration, isWebManager } from '../infrastructure/transport.js';
import { state } from '../core/state.js';
import { render } from '../core/render-request.js';
import { captureSetupForm } from '../configuration/form.js';
import { isPublicMode } from '../configuration/public-access.js';
import { nginxMode, sslRoutes } from '../configuration/ssl.js';
import { clearFeedback } from './feedback.js';

export function captureSslDraft() {
    state.sslDraft ||= { mode: nginxMode(), httpsPort: 443 };
    const mode = document.querySelector('#ssl-mode');
    if (mode) {
        state.sslDraft.mode = mode.value;
    }
}
export function chooseCertificateInput(service, inputMode) {
    if (!['upload', 'path'].includes(inputMode)) {
        return;
    }
    captureSetupForm();
    state.sslFiles ||= {};
    state.sslFiles[service] = { ...state.sslFiles[service], inputMode };
    state.sslDisclosureOpen ||= {};
    state.sslDisclosureOpen[service] = true;
    render();
}

export function setCertificatePath(service, kind, value) {
    state.sslFiles ||= {};
    state.sslFiles[service] ||= { inputMode: 'path' };
    state.sslFiles[service][kind] = value.trim();
}

export async function selectSslFile(kind, file, service) {
    if (!file) {
        return;
    }
    const limit = kind === 'certificate' ? 256 * 1024 : 64 * 1024;
    if (file.size > limit) {
        state.error = '证书或私钥文件过大';
        render();
        return;
    }
    try {
        const extensions = kind === 'certificate' ? /\.(pem|crt|cer)$/i : /\.(pem|key)$/i;
        if (!extensions.test(file.name)) {
            throw new Error(
                kind === 'certificate'
                    ? '请选择 .pem、.crt 或 .cer 证书文件'
                    : '请选择 .key 或 .pem 证书密钥文件',
            );
        }
        const text = (await file.text()).trim();
        const block =
            kind === 'certificate'
                ? /^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+\s+-----END CERTIFICATE-----$/
                : /^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]+\s+-----END \1-----$/;
        const blocks =
            kind === 'certificate'
                ? text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
                : [text];
        if (
            !blocks?.length ||
            blocks.some((value) => !block.test(value)) ||
            (kind === 'certificate' &&
                text
                    .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '')
                    .trim())
        ) {
            throw new Error(
                kind === 'certificate'
                    ? '证书内容无效，请导入 PEM 格式证书文件'
                    : '密钥内容无效，请导入未加密的 PEM 格式密钥文件',
            );
        }
        state.sslFiles ||= {};
        state.sslFiles[service] ||= {};
        state.sslFiles[service][kind] = text;
        state.sslFiles[service][kind === 'certificate' ? 'certificateName' : 'keyName'] = file.name;
        state.error = '';
        return true;
    } catch (error) {
        state.error = String(error);
        render();
        return false;
    }
}
async function task(action) {
    if (state.busy || state.sslBusy) {
        return;
    }
    captureSetupForm();
    captureSslDraft();
    state.sslBusy = true;
    state.error = '';
    state.notice = '';
    render();
    try {
        await action();
    } catch (error) {
        state.error = String(error);
    } finally {
        state.sslBusy = false;
        render();
    }
}
export async function refreshSsl() {
    state.sslLoaded = true;
    const request = (state.sslRequestId = (state.sslRequestId || 0) + 1);
    state.sslDetecting = true;
    state.sslDetectionError = '';
    render();
    try {
        const status = await invoke('get_ssl_status');
        if (request === state.sslRequestId) {
            state.sslStatus = status;
        }
    } catch (error) {
        if (request === state.sslRequestId) {
            state.sslDetectionError = String(error);
        }
    } finally {
        if (request === state.sslRequestId) {
            if (state.page === 'setup') {
                captureSetupForm();
            }
            state.sslDetecting = false;
            render();
        }
    }
}
export function chooseNginx(mode) {
    if (!['managed', 'external'].includes(mode)) {
        return;
    }
    if (mode === nginxMode()) {
        if (mode === 'external') {
            return refreshSsl();
        }
        return;
    }
    captureSetupForm();
    state.sslDraft = { ...state.sslDraft, mode };
    state.nginxSelectionDirty = true;
    clearFeedback();
    render();
    if (mode === 'external') {
        return refreshSsl();
    }
}
export async function persistNginxSelection() {
    if (
        !state.nginxSelectionDirty &&
        !(nginxMode() === 'external' && !state.sslStatus?.externalManual)
    ) {
        return;
    }
    const mode = nginxMode();
    if (
        mode !== state.sslStatus?.provider ||
        (mode === 'external' && !state.sslStatus?.externalManual)
    ) {
        if (state.sslStatus?.running && mode === 'external') {
            if (!window.confirm('保存外部 Nginx 配置将停止内置 HTTPS 入口，是否继续？')) {
                throw new Error('Nginx 切换未保存，内置入口继续运行');
            }
            await invoke('stop_ssl_proxy');
        }
        await invoke('set_nginx_provider', {
            mode: mode === 'external' ? 'external-manual' : mode,
        });
        await refreshSsl();
    }
    state.nginxSelectionDirty = false;
}
export function downloadNginx() {
    return task(async () => {
        await persistNginxSelection();
        await invoke('install_nginx_image');
        await refreshSsl();
        state.notice = '内置 Nginx 已下载，点击“启用并启动”配置 HTTPS 入口。';
    });
}
export function enableNginx() {
    return task(async () => {
        await persistNginxSelection();
        if (
            !state.sslStatus?.config ||
            !isPublicMode(state.accessMode || state.config?.playNetworkMode) ||
            !sslRoutes().length
        ) {
            state.setupSection = 'network';
            state.accessMode =
                state.config?.publicAddressMode === 'shared'
                    ? 'public-shared'
                    : 'public-independent';
            state.config.playNetworkMode = 'public';
            state.config.creatorNetworkMode = 'public';
            state.notice = '请填写公网地址，HTTPS 地址需要配置证书；保存后将启用 Nginx 入口。';
            return;
        }
        await applyCertificateConfiguration();
        state.notice = '内置 Nginx 已启用并启动，HTTPS 配置已应用。';
    });
}
export function reloadNginx() {
    return task(async () => {
        state.sslStatus = await invoke('reload_ssl_proxy');
        await refreshSsl();
        state.notice = '内置 Nginx 已重载，证书已重新读取并通过校验。';
    });
}
export function shouldApplySsl() {
    if (nginxMode() === 'external') {
        return false;
    }
    if (state.setupSection !== 'network' && !state.nginxSelectionDirty) {
        return false;
    }
    const active = (state.sslStatus?.config?.settings?.routes || []).length > 0;
    if (!isPublicMode(state.accessMode || state.config?.playNetworkMode)) {
        return active;
    }
    return sslRoutes().length > 0 || active;
}
export function validateSslRoutes(routes) {
    const endpoints = new Set();
    const protocols = new Map();
    for (const route of routes) {
        const key = `${route.domain}:${route.port}${route.path || '/'}`;
        if (endpoints.has(key)) {
            throw new Error(
                '同一个地址、端口和路径不能分配给多个服务，请使用不同端口或不同入口路径。',
            );
        }
        endpoints.add(key);
        if (protocols.has(route.port) && protocols.get(route.port) !== route.secure) {
            throw new Error('同一个公网端口不能同时使用 HTTP 和 HTTPS。');
        }
        protocols.set(route.port, route.secure);
    }
}
export function applySsl() {
    return task(applyCertificateConfiguration);
}
export async function applyCertificateConfiguration() {
    const mode = nginxMode();
    if (!['managed', 'external'].includes(mode)) {
        throw new Error('请先在数据服务选择 Nginx 使用方式');
    }
    const routes = isPublicMode(state.accessMode || state.config?.playNetworkMode)
        ? sslRoutes()
        : [];
    validateSslRoutes(routes);
    const certificates = {};
    const certificatePaths = {};
    for (const route of routes) {
        const local = state.sslFiles?.[route.service];
        const files = state.config?.publicAddressMode === 'shared' ? state.sslFiles?.shared : local;
        const records = state.sslStatus?.certificatePaths || {};
        const savedPair =
            state.config?.publicAddressMode === 'shared'
                ? Object.values(records).find((pair) => pair.source === 'shared')
                : records[route.service];
        if (files?.inputMode === 'path' || (!files?.inputMode && savedPair)) {
            const certificatePath = files?.certificatePath ?? savedPair?.certificatePath;
            const privateKeyPath = files?.privateKeyPath ?? savedPair?.privateKeyPath;
            if (!certificatePath || !privateKeyPath) {
                throw new Error('请同时填写证书和私钥绝对路径');
            }
            certificatePaths[route.service] = {
                certificatePath,
                privateKeyPath,
                source: state.config?.publicAddressMode === 'shared' ? 'shared' : 'independent',
            };
            continue;
        }
        if (!files?.certificate && !files?.privateKey) {
            continue;
        }
        if (!files.certificate || !files.privateKey) {
            throw new Error('请为选定证书同时选择完整证书链和私钥');
        }
        certificates[route.service] = {
            source: state.config?.publicAddressMode === 'shared' ? 'shared' : 'independent',
            certificate: files.certificate,
            privateKey: files.privateKey,
        };
    }
    state.sslStatus = await invoke('apply_ssl_config', {
        config: {
            settings: { mode, httpsPort: 443, routes },
            externalLocal: mode === 'external' && !isWebManager(),
            certificates,
            certificatePaths,
        },
    });
    state.sslFiles = {};
    state.notice =
        state.sslStatus.sslWarning ||
        (routes.length
            ? '公网配置已应用，Nginx 入口和已运行服务的访问设置已更新。'
            : '公网入口已停用，服务按当前本机或局域网设置运行。');
    await refreshSsl();
}
export function stopSsl() {
    if (!window.confirm('停用后 HTTPS/WSS 入口将断开，内部引擎服务继续运行。是否停用？')) {
        return;
    }
    return task(async () => {
        state.sslStatus = await invoke('stop_ssl_proxy');
        state.notice = '托管 HTTPS 入口已停用，证书保留。';
    });
}
export function deleteSslCertificate(service) {
    return task(async () => {
        state.sslStatus = await invoke('delete_ssl_certificate', { service });
        if (state.sslFiles) {
            delete state.sslFiles[service];
        }
        state.notice = `${service === 'shared' ? '共用' : '该服务的'} SSL 证书和私钥已删除，HTTPS 路由已停用。未指定协议的地址将在下次保存时使用 HTTP。`;
    });
}
export function exportSsl() {
    return task(async () => {
        const exported = await exportSslConfiguration(state.sslStatus.config.externalConfig);
        if (exported) {
            state.notice = '配置已导出；请复制证书、调整上游地址并执行 nginx -t 后重载。';
        }
    });
}
