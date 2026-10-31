import { bindServicesEvents } from './bindings/services.js';
import { bindNavigationEvents } from './bindings/navigation.js';
import { bindAboutEvents } from './bindings/about.js';
import { bindRuntimesEvents } from './bindings/runtimes.js';
import { bindBackupsEvents } from './bindings/backups.js';
import { bindConfigurationEvents } from './bindings/configuration.js';

export function bindEvents() {
    bindServicesEvents();
    bindNavigationEvents();
    bindAboutEvents();
    bindRuntimesEvents();
    bindBackupsEvents();
    bindConfigurationEvents();
}
