import {
    closeBackupDialog,
    confirmBackupAction,
    createBackup,
    exportBackup,
    importBackup,
    loadBackups,
    openBackupDialog,
} from '../../operations/backups.js';
import { render } from '../../core/render-request.js';
import { state } from '../../core/state.js';

export function bindBackupsEvents() {
    document.querySelector('#refresh-backups')?.addEventListener('click', loadBackups);

    document.querySelector('#create-backup')?.addEventListener('click', createBackup);

    document.querySelector('#import-backup')?.addEventListener('click', importBackup);

    document
        .querySelectorAll('[data-backup-action]')
        .forEach((node) =>
            node.addEventListener('click', () =>
                openBackupDialog(
                    node.dataset.backupAction,
                    node.dataset.backupPath,
                    node.dataset.backupName,
                ),
            ),
        );

    document
        .querySelectorAll('[data-export-backup]')
        .forEach((node) =>
            node.addEventListener('click', () => exportBackup(node.dataset.exportBackup)),
        );

    document
        .querySelector('#cancel-backup-action-secondary')
        ?.addEventListener('click', closeBackupDialog);

    document.querySelector('[data-backup-dialog-dismiss]')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
            closeBackupDialog();
        }
    });

    document
        .querySelector('#confirm-backup-action')
        ?.addEventListener('click', confirmBackupAction);

    document.querySelector('#restore-backup-env')?.addEventListener('change', (event) => {
        if (state.backupDialog) {
            state.backupDialog.includeEnv = event.target.checked;
        }
    });
}
