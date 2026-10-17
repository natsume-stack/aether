import { ApiClient } from '@box/apis';

import { PortalConfig } from './config';
import { Http, HttpError, JsonBody } from './http';

import type { IncomingMessage, ServerResponse } from 'node:http';

type OperationName =
    | 'login'
    | 'register'
    | 'session'
    | 'logout'
    | 'profile'
    | 'password'
    | 'transfer';
type Body = Record<string, unknown>;
type Headers = Record<string, string | string[]>;
interface Reply {
    status:number;
    data:Body;
    headers:Headers;
}

/** 操作对象持有自己的方法、字段与语义，不把这些规则散落到分支流程中。 */
export class AuthOperation {
    public readonly name:OperationName;
    public readonly method:string;
    public readonly fields:readonly string[];
    public static readonly routes = new Map<string, AuthOperation>([
        ['/api/auth/login', new AuthOperation('login', 'POST', ['username', 'password'])],
        [
            '/api/auth/register',
            new AuthOperation('register', 'POST', ['username', 'displayName', 'password']),
        ],
        ['/api/auth/session', new AuthOperation('session', 'GET')],
        ['/api/auth/logout', new AuthOperation('logout', 'POST')],
        ['/api/auth/profile', new AuthOperation('profile', 'PATCH', ['displayName'])],
        [
            '/api/auth/password',
            new AuthOperation('password', 'POST', ['currentPassword', 'newPassword']),
        ],
    ]);
    public constructor(name:OperationName, method:string, fields:readonly string[] = []) {
        this.name = name;
        this.method = method;
        this.fields = fields;
    }
    public get selfService():boolean {
        return this.name === 'profile' || this.name === 'password';
    }
    public get hasBody():boolean {
        return this.method !== 'GET';
    }
    public payload(body:Body):Body | undefined {
        if (this.selfService && Object.keys(body).some((key) => !this.fields.includes(key))) {
            throw new HttpError(400, 'INVALID_INPUT', '请求包含不支持的账号字段');
        }
        return this.fields.length
            ? Object.fromEntries(this.fields.map((key) => [key, body[key]]))
            : undefined;
    }
}

/** 门户自己的授权策略：上游 Key 不能替代浏览器来源与注册开关检查。 */
export class AuthPolicy {
    private readonly config:PortalConfig;
    public constructor(config:PortalConfig) {
        this.config = config;
    }
    public validate(request:IncomingMessage, operation:AuthOperation):void {
        this.requireMethod(request, operation);
        this.requireRegistration(operation);
        this.requireOrigin(request, operation);
    }
    private requireMethod(request:IncomingMessage, operation:AuthOperation):void {
        if (request.method !== operation.method) {
            throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持', {
                Allow: operation.method,
            });
        }
    }
    private requireRegistration(operation:AuthOperation):void {
        if (operation.name === 'register' && !this.config.registrationEnabled) {
            throw new HttpError(403, 'REGISTRATION_DISABLED', '服主已关闭玩家注册');
        }
    }
    private requireOrigin(request:IncomingMessage, operation:AuthOperation):void {
        if (operation.hasBody && !this.config.sameOrigin(request)) {
            throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不受允许');
        }
    }
    public decorate(reply:Reply, operation:AuthOperation, body:Body, query:URLSearchParams):Reply {
        if (operation.name === 'session') {
            reply.data.registrationEnabled =
                this.config.registrationEnabled && reply.data.registrationEnabled !== false;
        }
        if (!operation.selfService) {
            const target = this.config.returnURL(
                String(body.source || query.get('source') || ''),
                String(body.returnUrl || query.get('returnUrl') || ''),
            );
            if (target) {
                reply.data.returnUrl = target;
            }
        }
        return reply;
    }
}

/** 管理与 Player Service 的通信细节；调用者只提供操作、当前请求与允许的正文。 */
export class PlayerServiceClient {
    private readonly config:PortalConfig;
    public constructor(config:PortalConfig) {
        this.config = config;
    }
    private headers(request:IncomingMessage, payload?:Body):Record<string, string> {
        const headers:Record<string, string> = {
            'Accept': 'application/json',
            'X-Box-Player-Auth-Key': this.config.apiKey,
            'User-Agent': String(request.headers['user-agent'] || '').slice(0, 512),
            'X-Forwarded-Proto': this.config.protocol(request),
        };
        if (request.headers.cookie) {
            headers.Cookie = request.headers.cookie;
        }
        const address = this.config.clientAddress(request);
        if (address) {
            headers['X-Forwarded-For'] = address;
            headers['X-Real-IP'] = address;
        }
        if (payload) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }
    private responseHeaders(response:Response):Headers {
        const headers:Headers = {};
        // Expires 自带逗号，Cookie 必须逐条原样转发，不得拼接/拆分。
        const cookies = response.headers.getSetCookie();
        if (cookies.length) {
            headers['Set-Cookie'] = cookies;
        }
        const retry = response.headers.get('retry-after');
        if (retry) {
            headers['Retry-After'] = retry;
        }
        return headers;
    }
    private response(result:{ response:Response; data?:unknown; error?:unknown }):Reply {
        const { response } = result;
        let parsed:unknown = result.data ?? result.error;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch {
                parsed = null;
            }
        }
        const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        return {
            status: valid ? response.status : 502,
            data: valid
                ? (parsed as Body)
                : { code: 'INVALID_UPSTREAM_RESPONSE', message: '玩家服务返回了无法解析的响应' },
            headers: this.responseHeaders(response),
        };
    }
    private sendOperation(
        api:ApiClient,
        operation:AuthOperation,
        payload:Body | undefined,
        signal:AbortSignal,
    ) {
        const options = { signal, redirect: 'manual' as const, parseAs: 'text' as const };
        const text = (field:string):string => {
            const value = payload?.[field];
            if (typeof value !== 'string') {
                throw new HttpError(400, 'INVALID_INPUT', '请求字段格式无效');
            }
            return value;
        };
        switch (operation.name) {
            case 'login':
                return api.postApiPlayerAuthLoginRaw({
                    ...options,
                    body: { username: text('username'), password: text('password') },
                });
            case 'register':
                return api.postApiPlayerAuthRegisterRaw({
                    ...options,
                    body: {
                        username: text('username'),
                        displayName: text('displayName'),
                        password: text('password'),
                    },
                });
            case 'session':
                return api.getApiPlayerAuthSessionRaw(options);
            case 'logout':
                return api.postApiPlayerAuthLogoutRaw({ ...options, body: {} });
            case 'profile':
                return api.patchApiPlayerAuthProfileRaw({
                    ...options,
                    body: { displayName: text('displayName') },
                });
            case 'password':
                return api.postApiPlayerAuthPasswordRaw({
                    ...options,
                    body: {
                        currentPassword: text('currentPassword'),
                        newPassword: text('newPassword'),
                    },
                });
            case 'transfer': {
                const source = text('source');
                if (source !== 'play' && source !== 'creator') {
                    throw new HttpError(400, 'INVALID_INPUT', '登录目标无效');
                }
                return api.postApiPlayerAuthTransferRaw({
                    ...options,
                    body: { source, challenge: text('challenge') },
                });
            }
        }
    }
    private failure(error:unknown):Reply {
        const timeout = error instanceof Error && error.name === 'AbortError';
        return {
            status: 502,
            headers: {},
            data: {
                code: timeout ? 'PLAYER_SERVICE_TIMEOUT' : 'PLAYER_SERVICE_UNAVAILABLE',
                message: timeout ? '玩家服务响应超时' : '暂时无法连接玩家服务',
            },
        };
    }
    public async send(
        operation:AuthOperation,
        request:IncomingMessage,
        payload?:Body,
    ):Promise<Reply> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        try {
            const api = new ApiClient({
                baseUrl: this.config.playerServiceURL.origin,
                headers: this.headers(request, payload),
            });
            return this.response(
                await this.sendOperation(api, operation, payload, controller.signal),
            );
        } catch (error) {
            return this.failure(error);
        } finally {
            clearTimeout(timeout);
        }
    }
}

/** 薄协调入口；真正规则在操作、策略与客户端各自的方法中，便于单独复用。 */
export class AuthProxy {
    private readonly body = new JsonBody();
    private readonly policy:AuthPolicy;
    private readonly client:PlayerServiceClient;
    private readonly config:PortalConfig;
    public constructor(config:PortalConfig) {
        this.config = config;
        this.policy = new AuthPolicy(config);
        this.client = new PlayerServiceClient(config);
    }
    public async handle(
        request:IncomingMessage,
        response:ServerResponse,
        url:URL,
    ):Promise<boolean> {
        const operation = AuthOperation.routes.get(url.pathname);
        if (!operation) {
            return false;
        }
        this.policy.validate(request, operation);
        const body = operation.hasBody ? await this.body.read(request) : {};
        const reply = await this.client.send(operation, request, operation.payload(body));
        this.policy.decorate(reply, operation, body, url.searchParams);
        await this.transfer(reply, operation, request, body, url.searchParams);
        Http.json(response, reply.status, reply.data, reply.headers);
        return true;
    }

    private async transfer(
        reply:Reply,
        operation:AuthOperation,
        request:IncomingMessage,
        body:Body,
        query:URLSearchParams,
    ):Promise<void> {
        if (
            !['login', 'register', 'session'].includes(operation.name) ||
            reply.status >= 400 ||
            !reply.data.player
        ) {
            return;
        }
        const state = String(body.transferState || query.get('transferState') || '');
        const challenge = String(body.transferChallenge || query.get('transferChallenge') || '');
        if (!state && !challenge) {
            return;
        }
        const source = String(body.source || query.get('source') || '');
        const target =
            source === 'play'
                ? this.config.playURL
                : source === 'creator'
                  ? this.config.creatorURL
                  : null;
        if (
            !target ||
            !/^[A-Za-z0-9_-]{43}$/.test(state) ||
            !/^[A-Za-z0-9_-]{43}$/.test(challenge)
        ) {
            throw new HttpError(400, 'INVALID_LOGIN_TRANSFER', '登录请求已失效，请从应用重新登录');
        }
        // Login/register just set these cookies; the browser has not sent them
        // back yet. Merge them before asking Player Service to issue a code.
        const cookies = new Map<string, string>();
        const merge = (value:string) => {
            const pair = value.split(';')[0];
            const separator = pair.indexOf('=');
            if (separator > 0) {
                cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
            }
        };
        for (const cookie of String(request.headers.cookie || '').split(';')) {
            merge(cookie);
        }
        const setCookies = reply.headers['Set-Cookie'];
        for (const cookie of Array.isArray(setCookies)
            ? setCookies
            : setCookies
              ? [setCookies]
              : []) {
            merge(cookie);
        }
        const authenticated = Object.assign(Object.create(request), {
            headers: {
                ...request.headers,
                cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
            },
        }) as IncomingMessage;
        const transfer = await this.client.send(
            new AuthOperation('transfer', 'POST'),
            authenticated,
            { source, challenge },
        );
        if (
            transfer.status >= 400 ||
            typeof transfer.data.code !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(transfer.data.code)
        ) {
            throw new HttpError(502, 'LOGIN_TRANSFER_FAILED', '无法同步登录状态，请从应用重新登录');
        }
        const callback = new URL(target);
        callback.pathname = `${callback.pathname.replace(/\/$/, '')}/api/player-login/callback`;
        callback.search = '';
        callback.hash = '';
        callback.searchParams.set('code', transfer.data.code);
        callback.searchParams.set('state', state);
        reply.data.returnUrl = callback.href;
    }
}
