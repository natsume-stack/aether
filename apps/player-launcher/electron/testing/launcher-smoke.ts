import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readResourceCache, clearResourceCache } from '../runtime/resource-cache';

// Exercise the built file:// application without using a real account or the
// user's launcher profile. This also works against a packaged app.asar.
const root = process.env.BOX_LAUNCHER_SMOKE_ROOT || path.resolve(__dirname, '..');
if (root.endsWith('.asar')) {
    for (const excluded of [
        'node_modules',
        'electron',
        'tests',
        'dist-electron/launcher-smoke.cjs',
        'dist-electron/cache-smoke.cjs',
        'dist-electron/menu-smoke.cjs',
        'dist-electron/build',
    ]) {
        if (fs.existsSync(path.join(root, excluded))) {
            throw new Error(`Unexpected packaged development files: ${excluded}`);
        }
    }
}
const temp =
    process.env.BOX_LAUNCHER_TEST_USER_DATA ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'box-launcher-smoke-'));
app.setPath('userData', temp);
nativeTheme.themeSource = 'light';
const server = { id: 'smoke-server', name: '测试服务器', endpoint: 'http://127.0.0.1:3121' };
let player = { username: 'test-player', displayName: '测试玩家', avatarSkinId: 'explorer' };
const cover = `data:image/png;base64,${fs.readFileSync(path.resolve(__dirname, '../../game/public/map-templates/blank-template.png')).toString('base64')}`;
let cleared = false;
let mapCleared = false;
let authenticated = false;
let loginAttempts = 0;
let browserCleared = false;
let cacheReads = 0;
let expireNextLibraryPatch = false;
let completeProfileSave:() => void;
const favoriteMapIds = new Set<string>();
const emptyServer = { id: 'empty-server', name: '空缓存服务器', endpoint: 'http://127.0.0.1:9999' };

ipcMain.handle('launcher:invoke', async (_event, command, payload) => {
    if (command === 'launcher_state') {
        return { servers: [server, emptyServer], selectedServerId: server.id };
    }
    if (command === 'remember_maps') {
        return;
    }
    if (command === 'game_status') {
        return null;
    }
    if (command === 'fetch_public_image') {
        return cover;
    }
    if (command === 'clear_resource_cache') {
        cleared = true;
    }
    if (command === 'clear_map_cache') {
        mapCleared = true;
    }
    if (command === 'clear_server_map_cache') {
        mapCleared = true;
    }
    if (command === 'clear_browser_cache') {
        browserCleared = true;
        return;
    }
    if (command === 'cache_status') {
        cacheReads += 1;
    }
    if (['cache_status', 'clear_resource_cache', 'clear_map_cache'].includes(command)) {
        const empty = cleared || payload.serverId === emptyServer.id;
        return {
            staticBytes: empty || mapCleared ? 0 : 1024 * 1024,
            httpBytes: empty || browserCleared ? 0 : 256,
            inUse: false,
            maps:
                empty || mapCleared
                    ? []
                    : [
                          {
                              mapId: 'permanent-town',
                              name: '星梦小镇',
                              versions: ['v1.0.0'],
                              bytes: 1024 * 1024,
                              resources: 10,
                          },
                      ],
        };
    }
    if (command === 'api_request') {
        const url = new URL(payload.request.url);
        if (url.pathname.endsWith('/play-profile')) {
            const changes = JSON.parse(payload.request.body);
            await new Promise<void>((resolve) => {
                completeProfileSave = resolve;
            });
            player = {
                ...player,
                displayName: changes.displayName,
                avatarSkinId: changes.avatarSkinId,
            };
            return {
                status: 200,
                headers: [['content-type', 'application/json']],
                body: JSON.stringify({ player }),
            };
        }
        if (url.pathname.endsWith('/play-library')) {
            if (!authenticated) {
                return { status: 401, body: '{"message":"AUTH_REQUIRED"}', headers: [] };
            }
            if (payload.request.method === 'PATCH') {
                if (expireNextLibraryPatch) {
                    expireNextLibraryPatch = false;
                    authenticated = false;
                    return { status: 401, body: '{"message":"AUTH_REQUIRED"}', headers: [] };
                }
                const changes = JSON.parse(payload.request.body);
                if (!['town', 'arena'].includes(changes.mapId)) {
                    throw new Error('Library must use the webpage public map ID');
                }
                if (changes.favorite === true) {
                    favoriteMapIds.add(changes.mapId);
                }
                if (changes.favorite === false) {
                    favoriteMapIds.delete(changes.mapId);
                }
                return { status: 204, body: '', headers: [] };
            }
            return {
                status: 200,
                headers: [['content-type', 'application/json']],
                body: JSON.stringify({
                    player,
                    libraryEnabled: true,
                    entries: ['town', 'arena'].map((mapId) => ({
                        mapId,
                        favorite: favoriteMapIds.has(mapId),
                        lastPlayedAt: mapId === 'town' ? '2026-10-01T00:00:00.000Z' : null,
                    })),
                }),
            };
        }
        if (url.pathname.endsWith('/auth/login')) {
            const credentials = JSON.parse(payload.request.body);
            if (
                credentials.username !== 'test-player' ||
                credentials.password !== 'fixture<&"password'
            ) {
                throw new Error('Fixture credentials were changed');
            }
            loginAttempts += 1;
            await new Promise((resolve) => setTimeout(resolve, 700));
            authenticated = loginAttempts > 1;
            return {
                status: authenticated ? 200 : 401,
                headers: [['content-type', 'application/json']],
                body: JSON.stringify(authenticated ? { player } : { message: '用户名或密码错误' }),
            };
        }
        let data:unknown;
        if (url.pathname.endsWith('/bootstrap')) {
            data = {
                protocolVersion: 1,
                serverName: server.name,
                loginRequired: true,
                loginApiUrl: `${server.endpoint}/api/auth/login`,
                signingKey: null,
            };
        } else if (url.pathname.endsWith('/session')) {
            data = { player: authenticated ? player : null };
        } else if (url.pathname.endsWith('/maps')) {
            data = {
                worlds: [
                    {
                        id: 'town',
                        permanentMapId: 'permanent-town',
                        publicId: 'town',
                        name: '星梦小镇',
                        author: '作者甲',
                        version: 'v1.0.0',
                        onlineCount: 3,
                        cover: '',
                    },
                    {
                        id: 'arena',
                        permanentMapId: 'permanent-arena',
                        publicId: 'arena',
                        name: '竞技场',
                        author: '作者乙',
                        version: 'v1.1.0',
                        onlineCount: 7,
                        cover: '',
                    },
                ],
            };
        } else {
            throw new Error(`Unexpected smoke API: ${url.pathname}`);
        }
        return {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: JSON.stringify(data),
        };
    }
    throw new Error(`Unexpected smoke command: ${command}`);
});

app.whenReady()
    .then(async () => {
        const window = new BrowserWindow({
            show: false,
            width: 1180,
            height: 760,
            webPreferences: {
                preload: path.join(root, 'dist-electron/preload.cjs'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
            },
        });
        const errors:string[] = [];
        window.webContents.on('console-message', (event) => {
            if (event.level === 'error') {
                errors.push(event.message);
            }
        });
        const run = (code:string) => window.webContents.executeJavaScript(code);
        async function waitFor(code:string):Promise<void> {
            for (let attempt = 0; attempt < 100; attempt += 1) {
                if (await run(code)) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(`Desktop smoke timed out: ${code}`);
        }
        await window.loadFile(path.join(root, 'dist/index.html'));
        await waitFor('Boolean(document.querySelector("[data-select-server]"))');
        if (
            !(await run(
                'getComputedStyle(document.documentElement).colorScheme === "dark" && getComputedStyle(document.body).backgroundColor === "rgb(13, 13, 13)" && !document.querySelector("#theme-trigger")',
            ))
        ) {
            throw new Error('Launcher must stay dark even when the system uses light appearance');
        }
        await run('document.querySelector("[data-select-server]").click()');
        await waitFor('Boolean(document.querySelector("#player-login-form"))');
        await run(
            `const account=document.querySelector('#player-username');const password=document.querySelector('#player-password');account.value='test-player';password.value='fixture<&"password';account.dispatchEvent(new Event('input',{bubbles:true}));password.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#player-login-form').requestSubmit()`,
        );
        await waitFor('document.querySelector("#player-login-form button[type=submit]")?.disabled');
        if (
            !(await run(
                `document.querySelector('#player-username').value==='test-player' && document.querySelector('#player-password').value==='fixture<&"password' && document.querySelector('#player-password').type==='password'`,
            ))
        ) {
            throw new Error('Login submission erased the typed account or password');
        }
        await waitFor(
            'Boolean(document.querySelector(".login-card .inline-error")) && !document.querySelector("#player-login-form button[type=submit]").disabled',
        );
        if (
            !(await run(
                `document.querySelector('#player-username').value==='test-player' && document.querySelector('#player-password').value==='fixture<&"password'`,
            ))
        ) {
            throw new Error('Failed login erased the credentials needed for retry');
        }
        await run('document.querySelector("[data-toggle-password]").click()');
        await waitFor('document.querySelector("#player-password").type === "text"');
        await run('document.querySelector("[data-toggle-password]").click()');
        await waitFor('document.querySelector("#player-password").type === "password"');
        await run('document.querySelector("#player-login-form").requestSubmit()');
        await waitFor(
            'document.querySelectorAll(".world-card").length === 2 && [...document.querySelectorAll(".world-cover, .brand-icon, .player-account-avatar")].every(image => image.naturalWidth > 0)',
        );
        await waitFor(
            'document.querySelector("[data-map-filter=recent]")?.textContent === "最近游玩"',
        );
        await run('document.querySelector("[data-action=toggle-player-menu]").click()');
        await run('document.querySelector("[data-action=open-player-settings]").click()');
        await waitFor('Boolean(document.querySelector("#player-profile-form"))');
        await run(
            '{document.querySelector("[data-player-skin=cowboy]").click(); const input=document.querySelector("#player-profile-name");input.value="保存测试";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#player-profile-form").requestSubmit()}',
        );
        await waitFor(
            'document.querySelector("#player-profile-form button[type=submit]")?.disabled',
        );
        completeProfileSave();
        await waitFor(
            '!document.querySelector("#player-profile-form") && document.body.textContent.includes("账号设置已保存。")',
        );
        await run('document.querySelector("[data-action=toggle-player-menu]").click()');
        await run('document.querySelector("[data-action=open-player-settings]").click()');
        await waitFor(
            'document.querySelector("#player-profile-name")?.value === "保存测试" && document.querySelector("[data-player-skin=cowboy]")?.getAttribute("aria-pressed") === "true" && !document.querySelector("#player-profile-form button[type=submit]").disabled',
        );
        await run('document.querySelector("[data-close-player-settings]").click()');
        await run('document.querySelector("[data-map-filter=recent]").click()');
        await waitFor(
            'document.querySelectorAll(".world-card").length === 1 && document.querySelector(".world-card h3")?.textContent === "星梦小镇" && Boolean(document.querySelector(".world-favorite:not(:disabled)"))',
        );
        await run(
            'document.querySelector("[data-map-filter=all]").click(); document.querySelector(".world-favorite").click()',
        );
        await waitFor(
            'document.querySelector(".world-favorite")?.getAttribute("aria-pressed") === "true"',
        );
        await run('document.querySelector("[data-map-filter=favorites]").click()');
        await waitFor(
            'document.querySelectorAll(".world-card").length === 1 && document.querySelector(".world-card h3")?.textContent === "星梦小镇" && Boolean(document.querySelector(".world-favorite:not(:disabled)"))',
        );
        await run('document.querySelector("[data-map-filter=all]").click()');
        await run(
            'const input = document.querySelector("#map-search"); globalThis.smokeImeInput = input; input.focus(); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); input.value = "xing"; input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }))',
        );
        window.webContents.send('launcher:event:game-state', null);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (
            !(await run(
                'document.querySelector("#map-search") === globalThis.smokeImeInput && globalThis.smokeImeInput.value === "xing"',
            ))
        ) {
            throw new Error('A background update interrupted Chinese IME input');
        }
        await run(
            'globalThis.smokeImeInput.value = "星梦"; globalThis.smokeImeInput.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); globalThis.smokeImeInput.dispatchEvent(new InputEvent("input", { bubbles: true })); delete globalThis.smokeImeInput',
        );
        await waitFor(
            'document.querySelectorAll(".world-card").length === 1 && document.activeElement.id === "map-search" && document.activeElement.value === "星梦"',
        );
        await run('document.querySelector("[data-nav=packages]").click()');
        await waitFor(
            'document.querySelector(".storage-row small")?.textContent.includes("1.0 MB")',
        );
        if (
            !(await run(
                'document.querySelectorAll(".storage-server-trigger").length === 1 && !document.querySelector("[data-refresh-storage]")',
            ))
        ) {
            throw new Error('Empty servers or manual refresh are still displayed');
        }
        const reads = cacheReads;
        await run('document.querySelector("[data-nav=packages]").click()');
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (cacheReads !== reads) {
            throw new Error('Clicking the active storage page reloaded its data');
        }
        await run(
            'document.querySelector("[data-clear-browser-cache]").click(); document.querySelector("[data-confirm-browser-cache]").click()',
        );
        await waitFor(
            '!document.querySelector(".storage-browser-cache") && Boolean(document.querySelector(".storage-server-trigger"))',
        );
        await run('document.querySelector("[data-open-storage-server]").click()');
        await waitFor(
            'document.querySelector("[data-map-cache=permanent-town]")?.textContent.includes("星梦小镇")',
        );
        if (await run('Boolean(document.querySelector(".storage-browser-cache"))')) {
            throw new Error('Browser cache is still inside the map detail');
        }
        const detailReads = cacheReads;
        await run('document.querySelector("[data-nav=packages]").click()');
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (
            cacheReads !== detailReads ||
            !(await run('Boolean(document.querySelector("[data-map-cache=permanent-town]"))'))
        ) {
            throw new Error('Active storage navigation changed the detail page');
        }
        await run(
            'document.querySelector("[data-clear-map-cache]").click(); document.querySelector("[data-confirm-map-cache]").click()',
        );
        await waitFor(
            'Boolean(document.querySelector(".empty-maps")) && !document.querySelector(".storage-server-trigger")',
        );
        authenticated = false;
        await run('document.querySelector("[data-select-server]").click()');
        await waitFor(
            'document.querySelector(".login-card [role=alert]")?.textContent === "登录状态已过期，请重新登录。"',
        );
        if (
            !(await run(
                '!document.querySelector(".map-filter-tabs, .world-card, .player-account-control") && document.querySelector("#player-username").value === "test-player" && document.querySelector("#player-password").value === ""',
            ))
        ) {
            throw new Error(
                'Expired sessions must show login only and retain the account name without a password',
            );
        }
        await run(
            `document.querySelector('#player-password').value='fixture<&"password'; document.querySelector('#player-login-form').requestSubmit()`,
        );
        await waitFor(
            'document.querySelectorAll(".world-card").length === 2 && Boolean(document.querySelector(".world-favorite:not(:disabled)"))',
        );
        expireNextLibraryPatch = true;
        await run('document.querySelector(".world-favorite").click()');
        await waitFor(
            'document.querySelector(".login-card [role=alert]")?.textContent === "登录状态已过期，请重新登录。"',
        );
        const nativeSession = window.webContents.session;
        const usage = await readResourceCache(nativeSession);
        if (!Number.isFinite(usage.staticBytes) || !Number.isFinite(usage.httpBytes)) {
            throw new Error('Invalid native cache usage');
        }
        await nativeSession.cookies.set({
            url: 'https://smoke.example',
            name: 'smoke-account',
            value: 'fixture',
        });
        await clearResourceCache(nativeSession);
        if (!(await nativeSession.cookies.get({ name: 'smoke-account' })).length) {
            throw new Error('Clearing resources removed account cookies');
        }
        if (errors.length) {
            throw new Error(errors.join('\n'));
        }
        window.destroy();
        console.log(
            'Desktop smoke passed: profile saving, login expiry/relogin, Chinese IME, library sync, independent cache clearing and packaged assets',
        );
        app.exit(0);
    })
    .catch((error) => {
        console.error(error);
        app.exit(1);
    });

// Cleanup belongs to the parent runner, after Chromium has released profile files.
process.on('uncaughtException', (error) => {
    console.error(error);
    app.exit(1);
});
