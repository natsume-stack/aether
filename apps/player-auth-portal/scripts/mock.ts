import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

import { Http, JsonBody } from '../server/http';

interface Account {
    username:string;
    displayName:string;
    password:string;
    subjectId:string;
    userId:string;
}
type Body = Record<string, unknown>;

/** 仅预览；内存账号不是引擎身份数据库，不模拟真实设备/封禁/限流。 */
export class MockPlayerService {
    private readonly body = new JsonBody();
    public readonly key:string;
    public readonly server = createServer((request, response) => {
        void this.handle(request, response);
    });
    private readonly accounts = new Map<string, Account>([
        [
            'demo',
            {
                username: 'demo',
                displayName: '演示玩家',
                password: 'demo-password-123',
                subjectId: randomUUID().replaceAll('-', ''),
                userId: '1',
            },
        ],
    ]);
    private readonly sessions = new Map<string, string>();
    public constructor(key = randomBytes(32).toString('hex')) {
        this.key = key;
    }
    private view(account:Account):object {
        return {
            subjectId: account.subjectId,
            userId: account.userId,
            username: account.username,
            displayName: account.displayName,
            status: 'active',
            role: 'player',
        };
    }
    private token(request:IncomingMessage):string {
        return (
            String(request.headers.cookie || '').match(
                /(?:^|;\s*)box_portal_preview_session=([^;]+)/,
            )?.[1] || ''
        );
    }
    private account(request:IncomingMessage):Account | undefined {
        return this.accounts.get(this.sessions.get(this.token(request)) || '');
    }
    private cookie(token:string):string {
        // Cookie 不按端口隔离，演示名称不能覆盖同主机上真实引擎的会话。
        return `box_portal_preview_session=${token}; Path=/; HttpOnly; SameSite=Lax${token ? '' : '; Max-Age=0'}`;
    }
    private revoke(username:string):void {
        for (const [key, owner] of this.sessions) {
            if (owner === username) {
                this.sessions.delete(key);
            }
        }
    }
    private register(body:Body):Account | null {
        const username = String(body.username || '')
            .trim()
            .toLowerCase();
        const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        if (
            !/^[a-z][a-z0-9_]{2,31}$/.test(username) ||
            !/^.{1,32}$/.test(name) ||
            typeof body.password !== 'string' ||
            body.password.length < 10 ||
            body.password.length > 128 ||
            this.accounts.has(username)
        ) {
            return null;
        }
        const account = {
            username,
            displayName: name,
            password: body.password,
            subjectId: randomUUID().replaceAll('-', ''),
            userId: String(this.accounts.size + 1),
        };
        this.accounts.set(username, account);
        return account;
    }
    private login(body:Body, response:ServerResponse, register:boolean):void {
        const account = register
            ? this.register(body)
            : this.accounts.get(
                  String(body.username || '')
                      .trim()
                      .toLowerCase(),
              );
        if (!account || account.password !== body.password) {
            return Http.error(
                response,
                register ? 400 : 401,
                'INVALID_CREDENTIALS',
                register ? '注册信息无效或用户名已存在' : '用户名或密码错误',
            );
        }
        this.revoke(account.username);
        const token = randomUUID();
        this.sessions.set(token, account.username);
        Http.json(
            response,
            register ? 201 : 200,
            { player: this.view(account) },
            {
                'Set-Cookie': [
                    this.cookie(token),
                    'box_portal_preview_device=development-fixture; Path=/; HttpOnly; SameSite=Lax',
                ],
            },
        );
    }
    private profile(account:Account, body:Body, response:ServerResponse):void {
        if (typeof body.displayName !== 'string' || !/^.{1,32}$/.test(body.displayName.trim())) {
            return Http.error(response, 400, 'INVALID_INPUT', '昵称长度为 1–32');
        }
        account.displayName = body.displayName.trim();
        Http.json(response, 200, { player: this.view(account) });
    }
    private password(account:Account, body:Body, response:ServerResponse):void {
        if (account.password !== body.currentPassword) {
            return Http.error(response, 400, 'CURRENT_PASSWORD_INVALID', '原密码不正确');
        }
        if (
            typeof body.newPassword !== 'string' ||
            body.newPassword.length < 10 ||
            body.newPassword.length > 128 ||
            body.newPassword === body.currentPassword
        ) {
            return Http.error(response, 400, 'INVALID_INPUT', '新密码无效');
        }
        account.password = body.newPassword;
        this.revoke(account.username);
        Http.json(
            response,
            200,
            { changed: true, reloginRequired: true },
            { 'Set-Cookie': this.cookie('') },
        );
    }
    private async handle(request:IncomingMessage, response:ServerResponse):Promise<void> {
        if (request.headers['x-box-player-auth-key'] !== this.key) {
            return Http.error(response, 401, 'AUTH_API_KEY_INVALID', '模拟服务凭据无效');
        }
        try {
            const operation = new URL(request.url || '/', 'http://mock').pathname.replace(
                '/api/player-auth/',
                '',
            );
            const body = request.method === 'GET' ? {} : await this.body.read(request);
            const account = this.account(request);
            if (operation === 'session') {
                return Http.json(response, 200, {
                    player: account ? this.view(account) : null,
                    databaseEnabled: true,
                    registrationEnabled: true,
                });
            }
            if (operation === 'logout') {
                this.sessions.delete(this.token(request));
                return Http.json(
                    response,
                    200,
                    { loggedOut: true },
                    { 'Set-Cookie': this.cookie('') },
                );
            }
            if (operation === 'login' || operation === 'register') {
                return this.login(body, response, operation === 'register');
            }
            if (!account) {
                return Http.error(response, 401, 'AUTH_REQUIRED', '请重新登录');
            }
            if (operation === 'profile') {
                return this.profile(account, body, response);
            }
            if (operation === 'password') {
                return this.password(account, body, response);
            }
            Http.error(response, 404, 'NOT_FOUND', '模拟接口不存在');
        } catch {
            Http.error(response, 400, 'INVALID_INPUT', '模拟请求无效');
        }
    }
}
