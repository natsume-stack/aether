import { applyTheme } from '../../ui/theme.js';
import { closeLegalDialog, openLegalDocument } from '../../operations/legal.js';
import { exportDiagnostics } from '../../operations/backups.js';
import { openExternal } from '../../infrastructure/transport.js';
import { render } from '../../core/render-request.js';
import { state } from '../../core/state.js';
import {
    checkForUpdates,
    closeUpdateDialog,
    downloadUpdate,
    openUpdateDialog,
    restartAndUpdate,
} from '../../operations/updates.js';

export function bindAboutEvents() {
    const checkUpdates = () => {
        if (state.updateRelease) {
            return openUpdateDialog();
        } else {
            return checkForUpdates(true);
        }
    };
    document.querySelector('#check-version-updates')?.addEventListener('click', checkUpdates);
    document.querySelector('[data-check-version-updates]')?.addEventListener('click', checkUpdates);
    document
        .querySelector('[data-open-project-repository]')
        ?.addEventListener('click', () =>
            openExternal('https://github.com/box3lab/box3-local-engine', 'open_project_repository'),
        );
    document.querySelector('#close-update-dialog')?.addEventListener('click', closeUpdateDialog);
    document.querySelector('[data-update-dismiss]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
            closeUpdateDialog();
        }
    });
    document.querySelector('#open-update-download')?.addEventListener('click', downloadUpdate);
    document.querySelector('#restart-update')?.addEventListener('click', restartAndUpdate);
    document.querySelector('#update-cleanup-old-images')?.addEventListener('change', (event) => {
        state.updateCleanupOldImages = event.target.checked;
    });
    const updatePanel = document.querySelector('.update-dialog');
    updatePanel?.focus();
    updatePanel?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeUpdateDialog();
        }
        if (event.key === 'Tab') {
            const controls = [
                ...updatePanel.querySelectorAll(
                    'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
                ),
            ];
            const first = controls[0],
                last = controls.at(-1);
            if (
                event.shiftKey &&
                (document.activeElement === first || document.activeElement === updatePanel)
            ) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    document.querySelector('#close-legal-dialog')?.addEventListener('click', closeLegalDialog);

    document.querySelector('[data-legal-dialog-dismiss]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
            closeLegalDialog();
        }
    });

    document
        .querySelectorAll('[data-open-legal-document]')
        .forEach((node) =>
            node.addEventListener('click', () => openLegalDocument(node.dataset.openLegalDocument)),
        );

    document.querySelector('#theme-trigger')?.addEventListener('click', () => {
        state.themeMenuOpen = !state.themeMenuOpen;
        render();
    });

    document
        .querySelector('#export-about-diagnostics')
        ?.addEventListener('click', exportDiagnostics);

    document
        .querySelectorAll('#open-community-group, [data-open-community-group]')
        .forEach((node) =>
            node.addEventListener('click', () => {
                openExternal('https://qm.qq.com/q/oMdzAAN49a', 'open_community_group');
            }),
        );

    document.querySelectorAll('[data-theme-choice]').forEach((node) =>
        node.addEventListener('click', () => {
            applyTheme(node.dataset.themeChoice);
            state.themeMenuOpen = false;
            render();
        }),
    );
}
