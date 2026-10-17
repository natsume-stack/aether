import { state } from '../core/state.js';

export function nginxMode() {
    return (state.sslDraft?.mode || state.sslStatus?.provider) === 'external'
        ? 'external'
        : 'managed';
}

export { publicServices as sslServices } from './public-access.js';
import { publicEndpoints } from './public-access.js';

export function sslRoutes(config = state.config || {}) {
    return publicEndpoints(config, { activeOnly: true })
        .filter(({ service }) => {
            const mode =
                config[
                    service === 'creator' || service === 'voxa'
                        ? 'creatorNetworkMode'
                        : 'playNetworkMode'
                ];
            return !mode || mode === 'public';
        })
        .map(({ service, domain, port, secure, path }) => ({
            service,
            domain,
            port,
            secure,
            path,
        }));
}
