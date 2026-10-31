import {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    nativeImage,
    nativeTheme,
    session,
    safeStorage,
} from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createPlayerSessionStore } from './storage/player-session-store';
import { createApiTransport } from './network/api-transport';
import { createRequestDiagnostics } from './network/request-diagnostics';
import { createPublicImageTransport } from './network/public-image-transport';
import { createWindowStateStore } from './storage/window-state';
import { createMapLabels } from './storage/map-labels';
import { createGameWindowManager } from './runtime/game-window-manager';
import { hideApplicationMenu, installEditingShortcuts } from './runtime/application-menu';
import { createPlayerCommands } from './application/commands';
import { createServerStore } from './storage/server-store';

import type { ElectronCommandPayload } from './types';
import type { ServerStore } from './storage/server-store';
import type {
    GameWindow,
    GameWindowManager,
    GameWindowOptions,
} from './runtime/game-window-manager';
import type { ViteDevServer } from 'vite';

let mainWindow:Electron.BrowserWindow | undefined;
let devServer:ViteDevServer | undefined;
const publicImageTransport = createPublicImageTransport();

const channel = /(?:-|\.)(dev|staging)$/.exec(app.getVersion())?.[1];
app.setName(
    `BOX3 Player Launcher${channel === 'dev' ? ' Dev' : channel === 'staging' ? ' Staging' : ''}`,
);
nativeTheme.themeSource = 'dark';
const dataRoot =
    process.platform === 'linux'
        ? process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
        : app.getPath('appData');
app.setPath(
    'userData',
    path.join(dataRoot, `com.box.player.launcher${channel ? `.${channel}` : ''}`),
);
const apiTransport = createApiTransport({
    sessionStore: createPlayerSessionStore(
        path.join(app.getPath('userData'), 'player-sessions'),
        safeStorage,
    ),
    onTiming: createRequestDiagnostics(
        path.join(app.getPath('userData'), 'network-diagnostics.json'),
    ),
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function getServerStore():ServerStore {
    return createServerStore(path.join(app.getPath('userData'), 'servers.json'));
}

const serverStore:ServerStore = getServerStore();
const windowStates = createWindowStateStore(
    path.join(app.getPath('userData'), 'window-state.json'),
);
const mapLabels = createMapLabels(path.join(app.getPath('userData'), 'map-labels.json'));
function createRememberedWindow(
    key:string,
    options:Electron.BrowserWindowConstructorOptions,
):Electron.BrowserWindow {
    const size = windowStates.read(key, {
        width: options.width || 1180,
        height: options.height || 760,
    });
    const created = new BrowserWindow({
        ...options,
        autoHideMenuBar: true,
        width: size.width,
        height: size.height,
    });
    installEditingShortcuts(created.webContents);
    if (process.platform !== 'darwin') {
        created.setMenu(null);
        created.setMenuBarVisibility(false);
    }
    if (size.maximized) {
        created.maximize();
    }
    created.on('close', () => {
        const bounds = created.getNormalBounds();
        windowStates.save(key, {
            width: bounds.width,
            height: bounds.height,
            maximized: created.isMaximized(),
        });
    });
    return created;
}
let gameWindowManager:GameWindowManager;
gameWindowManager = createGameWindowManager({
    createBrowserWindow: (options:GameWindowOptions) =>
        createRememberedWindow('game', options) as unknown as GameWindow,
    sessions: session,
    syncCookies: syncPlayerCookies,
    onStateChange: (game) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('launcher:event:game-state', game);
        }
    },
});

async function syncPlayerCookies(endpoint:string, targetSession:Electron.Session):Promise<void> {
    const secure = new URL(endpoint).protocol === 'https:';
    const expires = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
    for (const [name, value] of apiTransport.cookies(endpoint)) {
        await targetSession.cookies.set({
            url: endpoint,
            name,
            value,
            path: '/',
            httpOnly: true,
            secure,
            sameSite: 'lax',
            expirationDate: expires,
        });
    }
}

async function clearWebSessionCookies(endpoint:string):Promise<void> {
    const cookieSessions = new Set([session.defaultSession, ...gameWindowManager.playerSessions()]);
    for (const targetSession of cookieSessions) {
        const cookies = await targetSession.cookies.get({ url: endpoint });
        for (const cookie of cookies) {
            if (['box_local_player_session', 'box_local_player_device'].includes(cookie.name)) {
                const protocolName = cookie.secure ? 'https:' : 'http:';
                const host = cookie.domain.replace(/^\./, '');
                const url = `${protocolName}//${host}${cookie.path || '/'}`;
                await targetSession.cookies.remove(url, cookie.name);
            }
        }
    }
}

const dispatch = createPlayerCommands({
    serverStore,
    gameWindowManager,
    apiTransport,
    publicImageTransport,
    mapLabels,
    clearWebSessionCookies,
});

function isLauncherWindow(event:Electron.IpcMainInvokeEvent):boolean {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        return false;
    }
    const frameUrl = event.senderFrame?.url || '';
    if (process.argv.includes('--dev')) {
        return frameUrl.startsWith('http://127.0.0.1:1421/');
    }
    try {
        const sender = new URL(frameUrl);
        const expected = new URL(`file://${path.resolve(__dirname, '../dist/index.html')}`);
        return sender.protocol === 'file:' && sender.pathname === expected.pathname;
    } catch {
        return false;
    }
}

ipcMain.handle(
    'launcher:invoke',
    (event:Electron.IpcMainInvokeEvent, command:string, payload:ElectronCommandPayload) => {
        if (!isLauncherWindow(event)) {
            throw new Error('启动器 IPC 来源无效');
        }
        return dispatch(command, payload);
    },
);

async function startVite():Promise<string> {
    if (devServer) {
        return 'http://127.0.0.1:1421';
    }
    const { createServer } = await import('vite');
    devServer = await createServer({
        root: path.resolve(__dirname, '..'),
        server: {
            host: '127.0.0.1',
            port: 1421,
            strictPort: true,
            watch: { ignored: ['**/release-electron*/**'] },
        },
    });
    await devServer.listen();
    return 'http://127.0.0.1:1421';
}

async function createMainWindow():Promise<void> {
    mainWindow = createRememberedWindow('launcher', {
        width: 1180,
        height: 760,
        minWidth: 900,
        minHeight: 620,
        title: `BOX3 Player Launcher v${app.getVersion()}`,
        backgroundColor: '#0d0d0d',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('context-menu', (event) => event.preventDefault());
    if (process.argv.includes('--dev')) {
        await mainWindow.loadURL(await startVite());
        if (process.argv.includes('--devtools')) {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    } else {
        await mainWindow.loadFile(path.resolve(__dirname, '../dist/index.html'));
    }
    mainWindow.setTitle(`BOX3 Player Launcher v${app.getVersion()}`);
}

app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        void createMainWindow();
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
});

app.whenReady()
    .then(async () => {
        if (!hasSingleInstanceLock) {
            app.quit();
            return;
        }
        hideApplicationMenu(Menu);
        if (process.platform === 'darwin' && app.dock) {
            const iconPath = path.join(app.getAppPath(), 'resources/icons/icon.png');
            app.dock.setIcon(nativeImage.createFromBuffer(fs.readFileSync(iconPath)));
        }
        await createMainWindow();
    })
    .catch((error) => {
        console.error(error);
        app.quit();
    });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (devServer) {
        void devServer.close();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
    }
});
