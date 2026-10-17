import { applyTheme } from './ui/theme.js';
import { checkForUpdates } from './operations/updates.js';
import { isWebManager, listen } from './infrastructure/transport.js';
import { refreshOverviewStatus, syncOverviewPolling } from './operations/overview.js';
import { refreshPerformance, syncPerformancePolling } from './operations/performance.js';
import { refreshStatus } from './operations/status.js';
import { scheduleProgressRender } from './operations/progress.js';
import { scheduleProjectRuntimeRefresh, syncProjectRuntimePolling } from './operations/runtimes.js';
import { startWebManager } from './operations/auth.js';
import { state } from './core/state.js';
import { render as renderApplication } from './app/render.js';
import { setRenderer } from './core/render-request.js';
import './styles.css';

setRenderer(renderApplication);

document.addEventListener('visibilitychange', () => {
    syncOverviewPolling();
    syncPerformancePolling();
    syncProjectRuntimePolling();
    if (!document.hidden) {
        if (state.page === 'overview') {
            refreshOverviewStatus();
        }
        if (state.page === 'performance') {
            refreshPerformance();
        }
        scheduleProjectRuntimeRefresh();
    }
});

listen('install-progress', ({ payload }) => {
    state.progress = payload;
    scheduleProgressRender();
});

document.addEventListener('contextmenu', (event) => event.preventDefault());

applyTheme(state.theme);

if (isWebManager()) {
    startWebManager();
} else {
    renderApplication();
    refreshStatus();
    checkForUpdates();
}
