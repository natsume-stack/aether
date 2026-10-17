import { invoke } from '../infrastructure/transport.js';
import { render } from '../core/render-request.js';
import { state } from '../core/state.js';

export async function loadLegalNotices() {
    if (state.legalLoading || state.legal) {
        return;
    }
    state.legalLoading = true;
    render();
    try {
        state.legal = await invoke('get_legal_notices');
    } catch (error) {
        state.legal = {
            licenseText: '无法读取许可证信息。',
            thirdPartyNotices: String(error),
            thirdPartyGeneratedAt: '读取失败',
        };
    } finally {
        state.legalLoading = false;
        if (state.page === 'about') {
            render();
        }
    }
}

export function closeLegalDialog() {
    state.legalDialog = '';
    render();
}

export function openLegalDocument() {
    state.legalDialog = 'license';
    render();
    loadLegalNotices();
}
