// Run with the workspace's Electron development runtime; never uses real accounts.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 仅声明测试所需的最小 Electron 接口，普通开发无需安装 Electron 或它的类型包。
interface SmokeWindow {
    setSize(width:number, height:number):void;
    loadURL(url:string):Promise<void>;
    destroy():void;
    webContents:{
        executeJavaScript(script:string):Promise<unknown>;
        capturePage():Promise<{ toPNG():Buffer }>;
    };
}
const { app, BrowserWindow } = require('electron') as {
    app:{
        setPath(name:string, value:string):void;
        whenReady():Promise<void>;
        exit(code:number):void;
    };
    BrowserWindow:new (options:object) => SmokeWindow;
};
import type { PortalOptions } from '../server/config';
import { PortalServer, PortalConfig } from '../server/index';
const createAuthPortalServer = (options:Partial<PortalOptions>) =>
    new PortalServer(
        new PortalConfig({
            apiKey: 'fixture-server-only-key',
            playerServiceURL: new URL('http://127.0.0.1:9'),
            ...options,
        }),
    ).server;

const temporaryProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'box-auth-ui-'));
app.setPath('userData', temporaryProfile);
const passwordRequests:{ method?:string; body:Record<string, unknown> }[] = [];
let nextStatus = 400;
let registrationEnabled = true;
let authenticated = true;
class ResponseGate {
    private resume?:() => void;
    public get waiting():boolean {
        return Boolean(this.resume);
    }
    public hold():Promise<void> {
        return new Promise((resolve) => {
            this.resume = resolve;
        });
    }
    public release():void {
        const resume = this.resume;
        this.resume = undefined;
        resume?.();
    }
}
const passwordGate = new ResponseGate();
let win:SmokeWindow;
let upstream:http.Server | undefined;
let portal:http.Server | undefined;
const listen = (server:http.Server):Promise<string> =>
    new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            resolve(`http://127.0.0.1:${address.port}`);
        }),
    );
const close = (server?:http.Server):Promise<void> =>
    new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
const evaluate = (script:string) => win.webContents.executeJavaScript(script);
async function until(script:string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(script)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not reach expected state: ${script}`);
}
const click = (text:string) =>
    evaluate(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
    );
async function fillPasswords(
    currentPassword:string,
    newPassword:string,
    confirmPassword = newPassword,
) {
    await evaluate(`(() => {
    const values = ${JSON.stringify({ currentPassword, newPassword, confirmPassword })};
    for (const [name, value] of Object.entries(values)) document.querySelector('[name="'+name+'"]').value = value;
  })()`);
}
const submit = () => evaluate(`document.querySelector('form').requestSubmit()`);

app.whenReady()
    .then(async () => {
        upstream = http.createServer(async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url?.includes('/session')) {
                res.end(
                    JSON.stringify({
                        player: authenticated
                            ? { username: 'fixture', displayName: '测试玩家' }
                            : null,
                        registrationEnabled,
                    }),
                );
                return;
            }
            if (req.url?.endsWith('/password')) {
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                }
                passwordRequests.push({ method: req.method, body: JSON.parse(body) });
                await passwordGate.hold();
                res.statusCode = nextStatus;
                if (nextStatus === 200) {
                    authenticated = false;
                }
                res.end(
                    JSON.stringify(
                        nextStatus === 200
                            ? { changed: true, reloginRequired: true }
                            : { message: nextStatus === 401 ? '会话过期' : '原密码不正确' },
                    ),
                );
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        });
        const serviceURL = await listen(upstream);
        portal = createAuthPortalServer({
            playerServiceURL: new URL(serviceURL),
            publicURL: null,
            creatorURL: new URL('http://creator.example.test'),
            playURL: new URL('http://play.example.test'),
            apiKey: 'fixture-server-only',
            requestTimeoutMs: 5000,
            registrationEnabled: true,
            trustProxy: false,
        });
        const portalURL = await listen(portal);
        win = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        win.setSize(760, 820);
        for (const registration of [true, false]) {
            win.setSize(registration ? 760 : 390, 820);
            registrationEnabled = registration;
            authenticated = true;
            await win.loadURL(portalURL);
            await until(`document.querySelector('h1')?.textContent === '账号已登录'`);
            await click('修改密码');
            await until(`document.activeElement?.name === 'currentPassword'`);
            assert.ok(
                await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
                'Password form must fit narrow screens',
            );
            if (registration && process.env.BOX_AUTH_UI_SCREENSHOT) {
                await evaluate(`document.documentElement.dataset.theme = 'dark'`);
                await new Promise((resolve) => setTimeout(resolve, 250));
                fs.writeFileSync(
                    process.env.BOX_AUTH_UI_SCREENSHOT,
                    (await win.webContents.capturePage()).toPNG(),
                );
            }
            assert.equal(
                await evaluate(`document.querySelector('[name="newPassword"]').maxLength`),
                128,
            );
            await evaluate(
                `document.querySelector('[name="currentPassword"]').closest('.input-shell').querySelector('button').click()`,
            );
            assert.equal(
                await evaluate(`document.querySelector('[name="currentPassword"]').type`),
                'text',
            );
            await evaluate(
                `document.querySelector('[name="currentPassword"]').closest('.input-shell').querySelector('button').click()`,
            );
            assert.equal(
                await evaluate(`document.querySelector('[name="currentPassword"]').type`),
                'password',
            );
            await click('返回账号');
            await until(`document.querySelector('h1')?.textContent === '账号已登录'`);
            await click('修改密码');
            await fillPasswords('old-password', 'new-password-123', 'different-password');
            await submit();
            await until(`document.querySelector('[role="alert"]')?.textContent.includes('不一致')`);
            const before = passwordRequests.length;
            await fillPasswords('old-password', 'old-password');
            await submit();
            await until(
                `document.querySelector('[role="alert"]')?.textContent.includes('不能与原密码相同')`,
            );
            assert.equal(passwordRequests.length, before);
            await fillPasswords('old-password', 'new-password-123');
            nextStatus = 400;
            await submit();
            await until(`document.querySelector('fieldset')?.disabled === true`);
            // A second submit while the first request is pending must never duplicate it.
            await evaluate(
                `document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
            );
            for (let attempt = 0; !passwordGate.waiting && attempt < 100; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            assert.ok(passwordGate.waiting);
            assert.equal(passwordRequests.length, before + 1);
            passwordGate.release();
            await until(
                `document.querySelector('[role="alert"]')?.textContent.includes('原密码不正确')`,
            );
            await until(`document.querySelector('fieldset')?.disabled === false`);
            nextStatus = 200;
            await submit();
            for (let attempt = 0; !passwordGate.waiting && attempt < 100; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            assert.ok(passwordGate.waiting);
            passwordGate.release();
            await until(
                `document.querySelector('[role="status"]')?.textContent.includes('密码已修改')`,
            );
            assert.equal(
                await evaluate(`document.querySelector('h1').textContent`),
                '登录玩家账号',
            );
            assert.equal(await evaluate(`document.querySelector('[name="password"]').value`), '');
            assert.deepEqual(passwordRequests.at(-1), {
                method: 'POST',
                body: { currentPassword: 'old-password', newPassword: 'new-password-123' },
            });
            // An expired session immediately returns to login, not a stale account form.
            authenticated = true;
            await win.loadURL(portalURL);
            await until(`document.querySelector('h1')?.textContent === '账号已登录'`);
            await click('修改密码');
            await fillPasswords('old-password', 'new-password-123');
            nextStatus = 401;
            await submit();
            for (let attempt = 0; !passwordGate.waiting && attempt < 100; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
            assert.ok(passwordGate.waiting);
            passwordGate.release();
            await until(
                `document.querySelector('[role="alert"]')?.textContent.includes('登录状态已过期')`,
            );
            assert.equal(
                await evaluate(`document.querySelector('h1').textContent`),
                '登录玩家账号',
            );
        }
        console.log(
            'Portal UI passed: password validation, visibility, cancellation, duplicate submission, failure recovery, relogin and session expiry (registration enabled/disabled).',
        );
    })
    .then(
        () => finish(0),
        (error) => {
            console.error(error);
            finish(1);
        },
    );

const deadline = setTimeout(() => {
    console.error('Portal UI smoke exceeded 30s');
    app.exit(1);
}, 30000);
async function finish(code:number) {
    clearTimeout(deadline);
    win?.destroy();
    passwordGate.release();
    await Promise.all([close(portal), close(upstream)]);
    fs.rmSync(temporaryProfile, { recursive: true, force: true });
    app.exit(code);
}
