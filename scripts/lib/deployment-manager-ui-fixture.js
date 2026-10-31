'use strict';

const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'apps/deployment-manager');
const src = path.join(app, 'src');
const appRequire = createRequire(path.join(app, 'package.json'));
const entrySource = `
import ${JSON.stringify(path.join(src, 'main.js'))}
import { state } from ${JSON.stringify(path.join(src, 'core/state.js'))}
import { render } from ${JSON.stringify(path.join(src, 'app/render.js'))}
import { setup } from ${JSON.stringify(path.join(src, 'views/setup/index.js'))}
import { revealInvalidSetupField } from ${JSON.stringify(path.join(src, 'configuration/form.js'))}
import { getServiceUrl } from ${JSON.stringify(path.join(src, 'configuration/addresses.js'))}
import { copyOwnerSecret } from ${JSON.stringify(path.join(src, 'operations/owner-secrets.js'))}
import { saveRawEnvironment, saveConfiguration, loadRawNginxConfig, saveRawNginxConfig, reloadRawNginxConfig } from ${JSON.stringify(path.join(src, 'operations/configuration.js'))}
import { openExternalNginxDialog, closeExternalNginxDialog } from ${JSON.stringify(path.join(src, 'operations/external-nginx.js'))}
import { externalNginxConfiguration } from ${JSON.stringify(path.join(src, 'configuration/external-nginx.js'))}
import { sslRoutes } from ${JSON.stringify(path.join(src, 'configuration/ssl.js'))}
import { chooseCertificateInput, setCertificatePath, selectSslFile, reloadNginx, enableNginx, downloadNginx, chooseNginx, deleteSslCertificate } from ${JSON.stringify(path.join(src, 'operations/ssl.js'))}
import { confirmBackupAction, openBackupDialog } from ${JSON.stringify(path.join(src, 'operations/backups.js'))}
import { checkForUpdates, closeUpdateDialog, downloadUpdate, restartAndUpdate } from ${JSON.stringify(path.join(src, 'operations/updates.js'))}
import { isNewerVersion, validateRelease } from ${JSON.stringify(path.join(src, 'utils/releases.js'))}
import { submitWebManagerToken } from ${JSON.stringify(path.join(src, 'operations/auth.js'))}
globalThis.manager = { submitWebManagerToken, revealInvalidSetupField, openExternalNginxDialog, closeExternalNginxDialog, externalNginxConfiguration, state, render, setup, getServiceUrl, copyOwnerSecret, saveRawEnvironment, saveConfiguration, loadRawNginxConfig, saveRawNginxConfig, reloadRawNginxConfig, confirmBackupAction, openBackupDialog, sslRoutes, chooseCertificateInput, setCertificatePath, selectSslFile, reloadNginx, enableNginx, downloadNginx, chooseNginx, deleteSslCertificate, checkForUpdates, closeUpdateDialog, downloadUpdate, restartAndUpdate, isNewerVersion, validateRelease }
`;
const adapterSource = `
export const invoke = (...args) => globalThis.adapterInvoke(...args)
export const isWebManager = () => globalThis.webManager
export const hasWebManagerToken = () => Boolean(globalThis.managerToken)
export const setWebManagerToken = value => { globalThis.managerToken = value }
export const dockerPlatform = () => ({ name: 'Docker', hint: 'fixture', action: '连接', busy: '连接中', canStart: false })
export const subscribeManager = () => () => {}
export const listen = (name, callback) => { globalThis.progressListeners.set(name, callback); return Promise.resolve(() => {}) }
export const openExternal = (url, command = 'open_service') => globalThis.adapterInvoke(command, { url })
export const selectBackup = () => Promise.resolve(null)
export const exportBackupFile = () => Promise.resolve(null)
export const exportDiagnosticsFile = () => Promise.resolve(null)
export const exportSslConfiguration = () => Promise.resolve(null)
`;

async function buildFixtureBundle(source = entrySource) {
    const { build } = await import(pathToFileURL(appRequire.resolve('vite')).href);
    const result = await build({
        configFile: false,
        root: app,
        logLevel: 'silent',
        plugins: [
            {
                name: 'manager-fixture',
                enforce: 'pre',
                resolveId(id) {
                    if (id === 'virtual:manager-fixture') {
                        return '\0manager-fixture.js';
                    }
                    if (id.endsWith('/transport.js') || id === './transport.js') {
                        return '\0manager-adapter.js';
                    }
                    if (id.endsWith('.css')) {
                        return '\0manager-styles.js';
                    }
                },
                load(id) {
                    if (id === '\0manager-fixture.js') {
                        return source;
                    }
                    if (id === '\0manager-adapter.js') {
                        return adapterSource;
                    }
                    if (id === '\0manager-styles.js') {
                        return '';
                    }
                },
            },
        ],
        build: {
            write: false,
            minify: false,
            rollupOptions: { input: 'virtual:manager-fixture', output: { format: 'iife' } },
        },
    });
    return result.output.find((item) => item.type === 'chunk').code;
}

let bundlePromise;
class FixtureElement {
    constructor(dataset = {}) {
        this.dataset = dataset;
        this.listeners = new Map();
        this.scrollTop = 0;
    }
    addEventListener(name, handler) {
        this.listeners.set(name, handler);
    }
    async click() {
        return this.listeners.get('click')?.({
            currentTarget: this,
            target: this,
            preventDefault() {},
        });
    }
}
class FixtureInput extends FixtureElement {
    constructor(name, value, checked = false) {
        super();
        this.name = name;
        this.value = value;
        this.checked = checked;
    }
}
const decode = (value) =>
    value
        .replaceAll('&quot;', '"')
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&');
class FixtureForm extends FixtureElement {
    constructor(markup) {
        super();
        this.values = new Map();
        this.inputs = new Map();
        for (const [tag] of markup.matchAll(/<input\b[^>]*>/g)) {
            const attributes = Object.fromEntries(
                [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
                    name,
                    decode(value),
                ]),
            );
            if (!attributes.name) {
                continue;
            }
            const checked = /\bchecked\b/.test(tag);
            const input = new FixtureInput(attributes.name, attributes.value || '', checked);
            this.inputs.set(attributes.name, input);
            if (attributes.disabled || /\bdisabled\b/.test(tag)) {
                continue;
            }
            if (attributes.type === 'checkbox' && !checked) {
                continue;
            }
            this.values.set(
                attributes.name,
                attributes.value || (attributes.type === 'checkbox' ? 'on' : ''),
            );
        }
        this.elements = { namedItem: (name) => this.inputs.get(name) || null };
    }
    checkValidity() {
        return true;
    }
    setValue(name, value) {
        this.values.set(name, value);
        if (this.inputs.has(name)) {
            this.inputs.get(name).value = value;
        }
    }
}
class FixtureFormData {
    constructor(form) {
        this.values = new Map(form.values);
    }
    entries() {
        return this.values.entries();
    }
    has(key) {
        return this.values.has(key);
    }
    get(key) {
        return this.values.get(key) ?? null;
    }
    [Symbol.iterator]() {
        return this.entries();
    }
}

async function createFixture({
    webManager = false,
    token = '',
    bundle,
    responses = {},
    releaseResponse,
    releaseHttpResponse,
} = {}) {
    if (!bundle) {
        bundlePromise ||= buildFixtureBundle();
        bundle = await bundlePromise;
    }
    const calls = [],
        copied = [],
        events = new Map(),
        intervals = new Map(),
        timeouts = new Map();
    let html = '',
        renderCount = 0,
        form = null,
        modes = [],
        rawTextarea = null,
        rawNginxTextarea = null,
        resetLoginImage = null,
        aboutUpdateButton = null,
        aboutRepositoryButton = null,
        updateProgressLabel = null,
        updateProgressBar = null,
        loginError = null,
        timerId = 0;
    const mainScroll = new FixtureElement(),
        setupScroll = new FixtureElement();
    const fixtureConfig = {
        databaseMode: 'managed',
        databasePort: '5432',
        redisMode: 'disabled',
        redisPort: '6379',
        publicHost: 'engine.example.test',
        publicAddress: 'http://engine.example.test',
        playNetworkMode: 'public',
        creatorNetworkMode: 'public',
        creatorHost: 'engine.example.test',
        lanIp: '192.168.1.20',
        playPort: 3121,
        creatorPort: 3127,
        voxaPort: 3123,
        playerServicePort: 3124,
        authPortalPort: 3125,
        hasPlayAdminToken: true,
        playPublicAddressOverride: 'https://play.example.test',
        authPortalPublicAddressOverride: 'https://auth.example.test',
    };
    const results = {
        get_system_status: {
            dockerReady: true,
            configured: true,
            allHealthy: true,
            services: [
                { name: 'play', running: true },
                { name: 'creator', running: true },
                { name: 'managed-postgres', running: true },
            ],
        },
        get_install_config: fixtureConfig,
        get_about_info: { applicationVersion: '0.3.0', platform: 'macos', architecture: 'aarch64' },
        get_managed_service_info: { configured: true, ready: true, imageAvailable: true },
        get_data_storage_info: { path: '/tmp/engine-fixture' },
        get_raw_environment: 'FIXTURE=true',
        get_raw_nginx_config: 'events {}\nhttp {}\n',
        save_raw_nginx_config: true,
        inspect_backup: { directories: [], files: 0, dataBytes: 0, hasEnv: false },
        list_backups: [],
        get_project_runtime_status: { creator: [], play: [], playMaps: [] },
        get_owner_secrets: {
            playAdminToken: 'private-owner-fixture',
            playerAuthApiKey: 'auth-fixture',
            permissionTokenSecret: 'runtime-fixture',
        },
        ...responses,
    };
    const appElement = {
        get innerHTML() {
            return html;
        },
        set innerHTML(value) {
            renderCount++;
            html = value;
            aboutUpdateButton = html.includes('data-check-version-updates')
                ? new FixtureElement()
                : null;
            aboutRepositoryButton = html.includes('data-open-project-repository')
                ? new FixtureElement()
                : null;
            updateProgressLabel = html.includes('id="launcher-update-progress-label"')
                ? {
                      get textContent() {
                          return html.match(/id="launcher-update-progress-label">([^<]*)/)?.[1];
                      },
                      set textContent(text) {
                          html = html.replace(
                              /(id="launcher-update-progress-label">)[^<]*/,
                              (_, prefix) => prefix + text,
                          );
                      },
                  }
                : null;
            updateProgressBar = html.includes('id="launcher-update-progress"')
                ? {
                      value: 0,
                      removeAttribute(name) {
                          if (name === 'value') {
                              this.value = null;
                          }
                      },
                  }
                : null;
            loginError = html.includes('id="web-login-error"') ? { textContent: '' } : null;
            form = html.includes('id="setup-form"') ? new FixtureForm(html) : null;
            rawTextarea = {
                value: html.match(/id="raw-environment"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] || '',
            };
            rawNginxTextarea = html.includes('id="raw-nginx-config"')
                ? {
                      value:
                          html.match(/id="raw-nginx-config"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ||
                          '',
                  }
                : null;
            resetLoginImage = html.includes('id="restore-default-login-image"')
                ? new FixtureElement()
                : null;
            modes = [...html.matchAll(/data-network-mode="([^"]+)"/g)].map(
                ([, networkMode]) => new FixtureElement({ networkMode }),
            );
        },
    };
    const document = {
        hidden: false,
        head: { appendChild() {} },
        createElement() {
            return { relList: { supports: () => true } };
        },
        documentElement: {
            dataset: {},
            removeAttribute(name) {
                if (name === 'data-theme') {
                    delete this.dataset.theme;
                }
            },
        },
        addEventListener(name, handler) {
            if (!events.has(name)) {
                events.set(name, new Set());
            }
            events.get(name).add(handler);
        },
        removeEventListener(name, handler) {
            events.get(name)?.delete(handler);
        },
        querySelector(selector) {
            if (selector === '#web-login-error') {
                return loginError;
            }
            if (selector === '[data-check-version-updates]') {
                return aboutUpdateButton;
            }
            if (selector === '[data-open-project-repository]') {
                return aboutRepositoryButton;
            }
            if (
                selector === '.progress-dialog-content' &&
                html.includes('class="progress-dialog-content"')
            ) {
                return {
                    set innerHTML(value) {
                        html = html.replace(
                            /(<div class="progress-dialog-content">)[\s\S]*?(<\/div><\/section><\/div>)/,
                            (_, start, end) => start + value + end,
                        );
                    },
                    parentElement: {
                        set className(value) {
                            html = html.replace(
                                /<section class="progress-dialog[^"]*"/,
                                `<section class="${value}"`,
                            );
                        },
                    },
                };
            }
            if (selector === '#app') {
                return appElement;
            }
            if (selector === '#launcher-update-progress-label') {
                return updateProgressLabel;
            }
            if (selector === '#launcher-update-progress') {
                return updateProgressBar;
            }
            if (selector === '#setup-form') {
                return form;
            }
            if (selector === '#raw-environment') {
                return rawTextarea;
            }
            if (selector === '#raw-nginx-config') {
                return rawNginxTextarea;
            }
            if (selector === '#restore-default-login-image') {
                return resetLoginImage;
            }
            if (selector === 'main') {
                return mainScroll;
            }
            if (selector === '.setup-panels') {
                return setupScroll;
            }
            if (selector === '.shell' && html.includes('data-rendered-page=')) {
                return {
                    dataset: { renderedPage: html.match(/data-rendered-page="([^"]+)"/)[1] },
                    querySelector: (inner) =>
                        inner === '.setup-panel.active'
                            ? {
                                  dataset: {
                                      setupPanel: html.match(
                                          /class="setup-panel[^"\n]*active[^"\n]*" data-setup-panel="([^"]+)"/,
                                      )?.[1],
                                  },
                              }
                            : document.querySelector(inner),
                };
            }
            return null;
        },
        querySelectorAll(selector) {
            return selector === '[data-network-mode]' ? modes : [];
        },
    };
    const localValues = new Map();
    const context = vm.createContext({
        console,
        URL,
        AbortController,
        document,
        webManager,
        managerToken: token,
        fetch: async (url, options) => {
            calls.push({ command: 'fetch_release', url, options });
            if (releaseHttpResponse) {
                return releaseHttpResponse;
            }
            const release =
                typeof releaseResponse === 'function' ? await releaseResponse() : releaseResponse;
            return {
                ok: true,
                text: async () =>
                    JSON.stringify(
                        release || {
                            schemaVersion: 1,
                            version: '0.3.0',
                            date: '2026-10-09',
                            summary: 'Current',
                            sections: [],
                        },
                    ),
            };
        },
        setTimeout: (handler, delay) => {
            timeouts.set(++timerId, { handler, delay });
            return timerId;
        },
        progressListeners: new Map(),
        navigator: {
            clipboard: {
                async writeText(value) {
                    copied.push(value);
                },
            },
        },
        localStorage: {
            getItem: (key) => localValues.get(key) || null,
            setItem: (key, value) => localValues.set(key, value),
        },
        Element: FixtureElement,
        HTMLInputElement: FixtureInput,
        FormData: FixtureFormData,
        CSS: { escape: (value) => value },
        setInterval: (handler, delay) => {
            intervals.set(++timerId, { handler, delay });
            return timerId;
        },
        clearInterval: (id) => intervals.delete(id),
        clearTimeout: (id) => timeouts.delete(id),
        window: {
            location: { reload: () => calls.push({ command: 'reload_web_manager' }) },
            setTimeout: (handler, delay) => {
                timeouts.set(++timerId, { handler, delay });
                return timerId;
            },
            setInterval: (handler, delay) => {
                intervals.set(++timerId, { handler, delay });
                return timerId;
            },
        },
        async adapterInvoke(command, payload) {
            calls.push({ command, payload });
            const response = results[command];
            return typeof response === 'function' ? response(payload) : response;
        },
    });
    vm.runInContext(bundle, context);
    await new Promise((resolve) => setImmediate(resolve));
    return {
        context,
        api: context.manager,
        calls,
        copied,
        document,
        intervals,
        timeouts,
        results,
        get renderCount() {
            return renderCount;
        },
        get html() {
            return html;
        },
        get form() {
            return form;
        },
        clickMode: (mode) =>
            modes
                .find(
                    (node) =>
                        node.dataset.networkMode ===
                        (mode === 'public' ? 'public-independent' : mode),
                )
                .click(),
        emitDocument: async (name) => {
            for (const handler of events.get(name) || []) {
                await handler({});
            }
        },
    };
}

module.exports = { buildFixtureBundle, createFixture };
