import { showExternalNginxConfiguration } from './external-nginx.js';
import {
    captureSetupForm,
    normalizeInactiveServicePorts,
    normalizedConfig,
    revealInvalidSetupField,
} from '../configuration/form.js';
import { clearFeedback } from './feedback.js';
import { invoke, isWebManager } from '../infrastructure/transport.js';
import { numericConfigFields, ownerSecretKeys } from '../core/constants.js';
import { refreshStatus } from './status.js';
import { render } from '../core/render-request.js';
import { resetOwnerSecretState, state } from '../core/state.js';
import {
    shouldApplySsl,
    applyCertificateConfiguration,
    persistNginxSelection,
    refreshSsl,
    validateSslRoutes,
} from './ssl.js';
import { nginxMode, sslRoutes } from '../configuration/ssl.js';
import {
    publicEndpoints,
    isPublicMode,
    publicServices,
    publicCertificateFlags,
} from '../configuration/public-access.js';
import { hostFromAddress } from '../configuration/addresses.js';
import { normalizeAuthPortalImage } from '../configuration/auth-portal-image.js';

export async function testConnection(kind) {
    captureSetupForm();
    clearFeedback();
    const config = state.config || {};
    const isPostgresql = kind === 'postgresql';
    const host = isPostgresql ? config.databaseHost : config.redisHost;
    const port = isPostgresql ? config.databasePort : config.redisPort;
    if (!host) {
        state.error = `请先填写 ${kind === 'postgresql' ? 'PostgreSQL' : 'Redis'} 地址。`;
        render();
        return;
    }
    state.notice = `正在验证 ${kind === 'postgresql' ? 'PostgreSQL' : 'Redis'} 服务连接…`;
    render();
    try {
        state.connectionTests[kind] = await invoke('test_remote_connection', {
            kind,
            host,
            port,
            database: isPostgresql ? config.databaseName : '',
            user: isPostgresql ? config.databaseUser : '',
            password: isPostgresql ? config.databasePassword || '' : config.redisPassword || '',
            redisDb: isPostgresql ? 0 : Number(config.redisDb || 0),
        });
        if (state.connectionTests[kind].ok) {
            state.notice = `${kind === 'postgresql' ? 'PostgreSQL' : 'Redis'} 服务连接并认证成功。`;
        } else {
            state.error = state.connectionTests[kind].message;
        }
    } catch (error) {
        state.connectionTests[kind] = { ok: false, message: String(error) };
        state.error = String(error);
    }
    render();
}

export async function relocateDataStorage() {
    if (state.busy) {
        return;
    }
    clearFeedback();
    try {
        const directory = isWebManager()
            ? document.querySelector('#linux-data-directory')?.value.trim()
            : await invoke('choose_data_storage_directory');
        if (!directory) {
            return;
        }
        state.busy = true;
        state.progress = {
            stage: 'data-preflight',
            message: '正在检查数据目录和服务状态…',
            percent: 5,
        };
        render();
        state.dataStorage = await invoke('relocate_data_storage', { directory });
        state.notice = '数据目录已迁移，请从服务总览重新启动服务。';
        state.progress = { stage: 'complete', message: '数据目录已迁移', percent: 100 };
    } catch (error) {
        state.progress = { stage: 'error', message: String(error), percent: 100 };
        state.error = String(error);
    } finally {
        state.busy = false;
        render();
    }
}

export async function saveConfiguration(event) {
    event.preventDefault();
    // The panel that holds an out-of-range field is often hidden, and the browser
    // then refuses to submit with "invalid form control is not focusable". Detect
    // it ourselves so the offending section is revealed with a real message.
    if (!event.currentTarget.checkValidity() && revealInvalidSetupField(event.currentTarget)) {
        return;
    }
    const form = new FormData(event.currentTarget);
    const submitted = Object.fromEntries(form.entries());
    // Password fields deliberately render empty after every UI refresh. Keep a
    // password entered during this setup session (for example before clicking
    // “测试连接”) so the subsequent install does not accidentally submit it as
    // an empty value. Existing saved secrets remain server-side when no new
    // password has been entered.
    const config = { ...(state.config || {}), ...submitted };
    if (!submitted.databasePassword && state.config?.databasePassword) {
        config.databasePassword = state.config.databasePassword;
    }
    if (!submitted.redisPassword && state.config?.redisPassword) {
        config.redisPassword = state.config.redisPassword;
    }
    for (const key of ownerSecretKeys) {
        if (!submitted[key] && state.config?.[key]) {
            config[key] = state.config[key];
        }
    }
    normalizeInactiveServicePorts(config);
    // Retain the transport's legacy base-host fields only for bind derivation.
    // Each service's public URL and certificate comes from its own fields.
    config.publicServicePaths = Object.fromEntries(
        publicServices.map(([service]) => [
            service,
            submitted[`publicPath-${service}`] ?? config.publicServicePaths?.[service] ?? '',
        ]),
    );
    config.publicSslConfigured = publicCertificateFlags(config);
    for (const key of Object.keys(config)) {
        if (
            key.startsWith('publicPath-') ||
            key.startsWith('ssl-cert-path-') ||
            key.startsWith('ssl-key-path-')
        ) {
            delete config[key];
        }
    }
    let primaryAddress = '127.0.0.1';
    try {
        if (
            isPublicMode(config.playNetworkMode) &&
            !(nginxMode() === 'external' && state.setupSection !== 'network')
        ) {
            primaryAddress =
                publicEndpoints(config, { activeOnly: true })[0]?.url || primaryAddress;
        }
    } catch (error) {
        state.error = String(error);
        render();
        return;
    }
    config.publicAddress = primaryAddress;
    config.publicHost = hostFromAddress(primaryAddress);
    config.creatorHost = config.publicHost;
    config.authPortalImage = normalizeAuthPortalImage(config.authPortalImage);
    config.databaseSsl = form.has('databaseSsl');
    config.autoBackupEnabled = form.has('autoBackupEnabled');
    config.registrationEnabled = form.has('registrationEnabled');
    for (const key of numericConfigFields) {
        config[key] = Number(config[key]);
    }
    state.config = {
        ...state.config,
        ...config,
        hasDatabasePassword: Boolean(config.databasePassword) || state.config?.hasDatabasePassword,
        hasRedisPassword: Boolean(config.redisPassword) || state.config?.hasRedisPassword,
        hasPermissionTokenSecret:
            Boolean(config.permissionTokenSecret) || state.config?.hasPermissionTokenSecret,
        hasPlayerAuthApiKey: Boolean(config.playerAuthApiKey) || state.config?.hasPlayerAuthApiKey,
        hasPlayAdminToken: Boolean(config.playAdminToken) || state.config?.hasPlayAdminToken,
    };
    config.externalNginxManual = nginxMode() === 'external' && state.setupSection !== 'network';
    if (config.externalNginxManual) {
        removeNetworkFields(config);
    }
    await persistConfiguration(config);
}

export async function installManagedService(service) {
    if (state.busy || !['postgresql', 'redis'].includes(service)) {
        return;
    }
    captureSetupForm();
    const config = normalizedConfig();
    config.externalNginxManual = nginxMode() === 'external';
    if (config.externalNginxManual) {
        removeNetworkFields(config);
    }
    if (service === 'postgresql') {
        config.databaseMode = 'managed';
    } else {
        config.redisMode = 'managed';
    }
    state.config = { ...state.config, ...config };
    state.busy = true;
    clearFeedback();
    state.progress = {
        stage: 'managed-preflight',
        message: `正在检查 Docker 和 ${service === 'postgresql' ? 'PostgreSQL' : 'Redis'} 镜像…`,
        percent: 5,
    };
    render();
    try {
        await invoke(
            service === 'postgresql' ? 'prepare_managed_database' : 'prepare_managed_redis',
        );
        await invoke('save_configuration_command', { config });
        await invoke('start_managed_service', { service });
        state.notice = `${service === 'postgresql' ? 'PostgreSQL' : 'Redis'} 已安装并可供本机程序连接。`;
    } catch (error) {
        state.progress = { stage: 'error', message: String(error), percent: 100 };
        state.error = String(error);
    } finally {
        state.busy = false;
        await refreshStatus();
    }
}

async function persistConfiguration(config) {
    if (state.busy) {
        return;
    }
    const loginImageChanged = (config.authPortalImage || '').trim() !== state.savedAuthPortalImage;
    const loginRunning = state.status?.services?.some(
        (service) => service.name === 'player-auth-portal' && service.running,
    );
    let configurationSaved = false;
    state.busy = true;
    clearFeedback();
    render();
    try {
        if (
            shouldApplySsl() ||
            (nginxMode() === 'external' &&
                state.setupSection === 'network' &&
                isPublicMode(config.playNetworkMode))
        ) {
            validateSslRoutes(sslRoutes(config));
        }
        await invoke('save_configuration_command', { config });
        configurationSaved = true;
        state.savedAuthPortalImage = (config.authPortalImage || '').trim();
        for (const key of ownerSecretKeys) {
            delete state.config?.[key];
        }
        resetOwnerSecretState();
        if (loginImageChanged && loginRunning) {
            state.progress = { stage: 'login-image', message: '正在更新登录页面…', percent: 35 };
            render();
            await invoke('control_service', { service: 'player-auth-portal', action: 'start' });
            state.notice = '登录页面已更新。';
        } else {
            state.notice = loginImageChanged
                ? '镜像配置已保存，下次启动登录页面时自动使用。'
                : '已保存在当前页面，服务不会自动启动。';
        }
        await persistNginxSelection();
        if (shouldApplySsl()) {
            await applyCertificateConfiguration();
        } else if (nginxMode() === 'external' && state.setupSection === 'network') {
            state.notice = isPublicMode(config.playNetworkMode)
                ? '访问设置已保存。请复制生成的 Nginx 配置到外部服务器，校验并重载。'
                : '本机或局域网设置已保存，请重新启动受影响的服务。';
        }
        if (
            nginxMode() === 'external' &&
            state.setupSection === 'network' &&
            isPublicMode(config.playNetworkMode)
        ) {
            showExternalNginxConfiguration(
                config,
                '访问设置已保存，请复制配置到外部 Nginx，修改证书路径后校验并重载。',
            );
        }
        state.progress = { stage: 'saved', message: '配置已保存', percent: 100 };
    } catch (error) {
        state.progress = { stage: 'error', message: String(error), percent: 100 };
        state.error = configurationSaved
            ? `配置已保存，但后续应用失败：${String(error)}`
            : String(error);
        if (
            configurationSaved &&
            nginxMode() === 'external' &&
            state.setupSection === 'network' &&
            isPublicMode(config.playNetworkMode)
        ) {
            showExternalNginxConfiguration(config, state.error);
        }
    } finally {
        state.busy = false;
        if (configurationSaved) {
            await refreshStatus();
        } else {
            render();
        }
    }
}

export async function saveRawEnvironment() {
    const textarea = document.querySelector('#raw-environment');
    if (!textarea || state.environmentFileSaving) {
        return;
    }
    state.environmentFileSaving = true;
    clearFeedback();
    state.environmentFile = textarea.value;
    render();
    try {
        const creatorPolicyCorrected = await invoke('save_raw_environment', {
            content: state.environmentFile,
        });
        state.environmentMessage = creatorPolicyCorrected
            ? '环境变量已保存；创作端的公网配置已自动改回本机或局域网范围。'
            : '环境变量已保存，不会自动重启服务。';
        state.notice = state.environmentMessage;
        state.progress = { stage: 'saved', message: '环境变量已保存', percent: 100 };
    } catch (error) {
        state.error = String(error);
    } finally {
        state.environmentFileSaving = false;
        await refreshStatus();
    }
}

export async function reloadRawEnvironment() {
    if (state.environmentFileSaving) {
        return;
    }
    clearFeedback();
    try {
        state.environmentFile = await invoke('get_raw_environment');
        state.environmentMessage = '已重新读取磁盘中的 .env。';
        state.notice = state.environmentMessage;
    } catch (error) {
        state.error = String(error);
    }
    render();
}

export async function loadRawNginxConfig() {
    if (state.nginxConfigSaving) {
        return;
    }
    clearFeedback();
    try {
        state.nginxConfigFile = await invoke('get_raw_nginx_config');
        state.nginxConfigLoaded = true;
        state.nginxConfigMessage = '';
    } catch (error) {
        state.error = String(error);
    }
    render();
}

export async function saveRawNginxConfig() {
    const textarea = document.querySelector('#raw-nginx-config');
    if (!textarea || state.nginxConfigSaving) {
        return;
    }
    state.nginxConfigSaving = true;
    clearFeedback();
    state.nginxConfigFile = textarea.value;
    render();
    try {
        const reloaded = await invoke('save_raw_nginx_config', { content: state.nginxConfigFile });
        state.nginxConfigMessage = reloaded
            ? '内置 Nginx 配置已校验并重载。'
            : '配置已保存；内置 Nginx 未运行，下次启动时生效。';
        state.notice = state.nginxConfigMessage;
        state.progress = { stage: 'saved', message: '内置 Nginx 配置已保存', percent: 100 };
        await refreshSsl();
    } catch (error) {
        state.error = String(error);
    } finally {
        state.nginxConfigSaving = false;
        render();
    }
}

export async function reloadRawNginxConfig() {
    if (state.nginxConfigSaving) {
        return;
    }
    clearFeedback();
    try {
        state.nginxConfigFile = await invoke('get_raw_nginx_config');
        state.nginxConfigMessage = '已重新读取磁盘中的 Nginx 配置。';
        state.notice = state.nginxConfigMessage;
    } catch (error) {
        state.error = String(error);
    }
    render();
}

function removeNetworkFields(config) {
    for (const key of [
        'publicAddress',
        'publicHost',
        'creatorHost',
        'playNetworkMode',
        'creatorNetworkMode',
        'publicAddressMode',
        'sharedPublicAddress',
        'publicServicePaths',
        'independentPublicAddresses',
        'publicSslConfigured',
        'playPort',
        'creatorPort',
        'voxaPort',
        'playerServicePort',
        'authPortalPort',
        ...publicServices.map(([, , field]) => field),
    ]) {
        delete config[key];
    }
}
