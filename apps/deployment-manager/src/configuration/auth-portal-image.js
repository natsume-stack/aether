import { version } from '../../package.json';
import { state } from '../core/state.js';

export function defaultAuthPortalImage() {
    return `box-local-engine-player-auth-portal:${state.about?.imageTag || version}`;
}

// Display the concrete default without pinning it in the owner's configuration.
// An empty override follows the official image when the engine is upgraded.
export function normalizeAuthPortalImage(value) {
    const image = String(value || '').trim();
    const tag = state.about?.imageTag || version;
    const release = tag.replace(/^v/, '').replace(/-linux-(?:amd64|arm64)$/, '');
    // Older forms displayed the application version before image metadata loaded.
    const defaults = [tag, release, `v${release}`, version].map(
        (value) => `box-local-engine-player-auth-portal:${value}`,
    );
    return defaults.includes(image) ? '' : image;
}
