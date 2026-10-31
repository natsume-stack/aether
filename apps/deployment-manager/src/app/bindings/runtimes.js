import {
    deleteMapRuntimeProfile,
    destroyProjectRuntime,
    refreshProjectRuntimes,
    saveMapRuntimeProfile,
} from '../../operations/runtimes.js';
import { render } from '../../core/render-request.js';
import { state } from '../../core/state.js';

export function bindRuntimesEvents() {
    document.querySelectorAll('[data-runtime-submaps]').forEach((node) =>
        node.addEventListener('toggle', () => {
            const projectId = node.dataset.runtimeSubmaps;
            if (!projectId) {
                return;
            }
            if (node.open) {
                state.runtimeExpandedProjects.add(projectId);
            } else {
                state.runtimeExpandedProjects.delete(projectId);
            }
        }),
    );

    document.querySelectorAll('[data-runtime-destroy]').forEach((node) =>
        node.addEventListener('click', () => {
            const projectId = node.dataset.runtimeDestroy;
            const mode = node.dataset.runtimeMode;
            const roomId = node.dataset.runtimeRoom || undefined;
            if (!projectId || !mode) {
                return;
            }
            state.runtimeDestroyDialog = { projectId, mode, roomId };
            render();
        }),
    );

    document
        .querySelector('[data-runtime-destroy-dialog-dismiss]')
        ?.addEventListener('click', (event) => {
            if (event.target !== event.currentTarget) {
                return;
            }
            state.runtimeDestroyDialog = null;
            render();
        });

    document.querySelector('#cancel-runtime-destroy-secondary')?.addEventListener('click', () => {
        state.runtimeDestroyDialog = null;
        render();
    });

    document.querySelector('#confirm-runtime-destroy')?.addEventListener('click', () => {
        const dialog = state.runtimeDestroyDialog;
        state.runtimeDestroyDialog = null;
        if (dialog) {
            void destroyProjectRuntime(dialog.projectId, dialog.mode, dialog.roomId);
        }
    });

    document.querySelectorAll('[data-runtime-catalog]').forEach((node) =>
        node.addEventListener('click', () => {
            state.runtimeCatalogTab = ['play', 'config'].includes(node.dataset.runtimeCatalog)
                ? node.dataset.runtimeCatalog
                : 'creator';
            render();
        }),
    );

    document.querySelector('#refresh-project-runtimes')?.addEventListener('click', () => {
        void refreshProjectRuntimes();
    });

    document.querySelector('#add-map-runtime-profile')?.addEventListener('click', () => {
        state.mapRuntimeProfileDialog = true;
        render();
    });

    const closeMapRuntimeProfileDialog = () => {
        state.mapRuntimeProfileDialog = false;
        render();
    };

    document
        .querySelector('#cancel-map-runtime-profile')
        ?.addEventListener('click', closeMapRuntimeProfileDialog);

    document
        .querySelector('#cancel-map-runtime-profile-secondary')
        ?.addEventListener('click', closeMapRuntimeProfileDialog);

    document
        .querySelector('[data-map-runtime-profile-dismiss]')
        ?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) {
                closeMapRuntimeProfileDialog();
            }
        });

    document.querySelector('#map-runtime-profile-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        void saveMapRuntimeProfile({
            ...values,
            playerLimit: Number(values.playerLimit),
            roomLimit: Number(values.roomLimit),
            idleTimeoutMs: Number(values.idleTimeoutMs),
            cpuMilli: values.cpuMilli ? Number(values.cpuMilli) : null,
            memoryMb: values.memoryMb ? Number(values.memoryMb) : null,
        });
    });

    document
        .querySelector('[data-runtime-isolation-toggle]')
        ?.addEventListener('change', (event) => {
            const enabled = event.currentTarget.checked;
            const form = event.currentTarget.closest('form');
            form?.classList.toggle('isolation-enabled', enabled);
            form?.querySelectorAll('.runtime-isolation-fields input').forEach((inputNode) => {
                inputNode.disabled = !enabled;
                inputNode.toggleAttribute('disabled', !enabled);
            });
        });

    document
        .querySelectorAll('[data-runtime-profile-delete]')
        .forEach((node) =>
            node.addEventListener(
                'click',
                () =>
                    void deleteMapRuntimeProfile(
                        node.dataset.runtimeProfileDelete,
                        node.dataset.runtimeProfileMode,
                    ),
            ),
        );
}
