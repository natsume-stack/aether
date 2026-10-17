import { about } from '../views/about.js';
import { backups } from '../views/backups.js';
import { bindEvents } from './bind-events.js';
import { normalizeAccessiblePage } from '../ui/access.js';
import { overview } from '../views/overview.js';
import { performance } from '../views/performance.js';
import { runtimes } from '../views/runtimes.js';
import { setup } from '../views/setup/index.js';
import { shell, refreshProgressPanel } from '../ui/shell.js';
import { state } from '../core/state.js';
import { syncOverviewPolling } from '../operations/overview.js';
import { syncPerformancePolling } from '../operations/performance.js';
import { syncProjectRuntimePolling } from '../operations/runtimes.js';
import { webLogin } from '../views/login.js';

function captureScrollPositions() {
    const shell = document.querySelector('.shell');
    if (!shell || shell.dataset.renderedPage !== state.page) {
        return null;
    }
    const setupPanel = shell.querySelector('.setup-panel.active');
    const sameSetupSection = setupPanel?.dataset.setupPanel === state.setupSection;
    return {
        main: shell.querySelector('main')?.scrollTop || 0,
        setupPanels: sameSetupSection ? shell.querySelector('.setup-panels')?.scrollTop || 0 : null,
    };
}

function restoreScrollPositions(positions) {
    if (!positions) {
        return;
    }
    const main = document.querySelector('main');
    const setupPanels = document.querySelector('.setup-panels');
    if (main) {
        main.scrollTop = positions.main;
    }
    if (setupPanels && positions.setupPanels !== null) {
        setupPanels.scrollTop = positions.setupPanels;
    }
}

export function render() {
    // Keep the blocking overlay and its CSS spinner connected throughout the task.
    // Status polling and progress ticks may update state; repaint the page on completion.
    if (state.busy && refreshProgressPanel()) {
        return;
    }
    normalizeAccessiblePage();
    const scrollPositions = captureScrollPositions();
    const disclosures = new Map(
        [...document.querySelectorAll('details[data-disclosure]')].map((node) => [
            node.dataset.disclosure,
            node.open,
        ]),
    );
    const content =
        state.page === 'web-login'
            ? webLogin()
            : state.page === 'setup'
              ? setup()
              : state.page === 'runtimes'
                ? runtimes()
                : state.page === 'performance'
                  ? performance()
                  : state.page === 'backups'
                    ? backups()
                    : state.page === 'about'
                      ? about()
                      : overview();
    document.querySelector('#app').innerHTML = shell(content);
    document.querySelectorAll('details[data-disclosure]').forEach((node) => {
        if (disclosures.has(node.dataset.disclosure)) {
            node.open = disclosures.get(node.dataset.disclosure);
        }
    });
    restoreScrollPositions(scrollPositions);
    bindEvents();
    syncOverviewPolling();
    syncPerformancePolling();
    syncProjectRuntimePolling();
}
