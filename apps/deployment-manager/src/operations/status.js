import { captureSetupForm } from '../configuration/form.js';
import { invoke } from '../infrastructure/transport.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

export async function refreshManagedServiceInfo() {
    try {
        const [managedDatabaseInfo, managedRedisInfo] = await Promise.all([
            invoke('get_managed_service_info', { service: 'postgresql' }),
            invoke('get_managed_service_info', { service: 'redis' }),
        ]);
        if (state.page === 'setup') {
            captureSetupForm();
        }
        state.managedDatabaseInfo = managedDatabaseInfo;
        state.managedRedisInfo = managedRedisInfo;
    } catch (error) {
        state.error = String(error);
    } finally {
        if (state.page === 'setup') {
            render();
        }
    }
}

export function applySystemStatus(status, error) {
    if (error) {
        state.statusErrors.system = String(error.message || error);
        return;
    }
    delete state.statusErrors.system;
    state.status = status;
    state.dockerCheck = {
        cliAvailable: status.dockerCliAvailable,
        cliVersion: status.dockerCliVersion,
        engineReady: status.dockerReady,
        message: status.dockerMessage,
    };
}

export async function refreshStatus() {
    const requests = [
        ['system', 'get_system_status'],
        ['config', 'get_install_config'],
        ['about', 'get_about_info'],
        ['database', 'get_managed_service_info', { service: 'postgresql' }],
        ['redis', 'get_managed_service_info', { service: 'redis' }],
        ['storage', 'get_data_storage_info'],
        ['environment', 'get_raw_environment'],
    ];
    const results = await Promise.allSettled(
        requests.map(([, command, payload]) => invoke(command, payload)),
    );
    results.forEach((result, index) => {
        const key = requests[index][0];
        if (key === 'system') {
            applySystemStatus(result.value, result.status === 'rejected' ? result.reason : null);
            return;
        }
        if (result.status === 'rejected') {
            state.statusErrors[key] = String(result.reason?.message || result.reason);
            return;
        }
        delete state.statusErrors[key];
        const value = result.value;
        if (key === 'config') {
            state.config = value;
            state.savedAuthPortalImage = value.authPortalImage || '';
            state.accessMode = '';
        } else if (key === 'about') {
            state.about = value;
        } else if (key === 'database') {
            state.managedDatabaseInfo = value;
        } else if (key === 'redis') {
            state.managedRedisInfo = value;
        } else if (key === 'storage') {
            state.dataStorage = value;
        } else if (key === 'environment') {
            state.environmentFile = value;
            state.environmentFileLoaded = true;
        }
    });
    if (state.page === 'setup' && !state.sslStatus) {
        try {
            state.sslStatus = await invoke('get_ssl_status');
        } catch {
            // The access settings panel surfaces SSL errors when opened.
        }
    }
    render();
}
