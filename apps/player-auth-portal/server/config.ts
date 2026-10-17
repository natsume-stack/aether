import { isIP } from 'node:net';

import type { IncomingMessage } from 'node:http';

export interface PortalOptions {
    apiKey:string;
    playerServiceURL:URL;
    host?:string;
    port?:number;
    publicURL?:URL | null;
    creatorURL?:URL | null;
    playURL?:URL | null;
    requestTimeoutMs?:number;
    trustProxy?:boolean;
    registrationEnabled?:boolean;
    publicDirectory?:string;
}

/** 配置只在服务器创建一次。私有密钥不会被 JSON.stringify 意外序列化。 */
export class PortalConfig {
    public readonly host:string;
    public readonly port:number;
    public readonly playerServiceURL:URL;
    public readonly publicURL:URL | null;
    public readonly creatorURL:URL | null;
    public readonly playURL:URL | null;
    public readonly requestTimeoutMs:number;
    public readonly trustProxy:boolean;
    public readonly registrationEnabled:boolean;
    public readonly publicDirectory?:string;
    readonly #key:string;

    public constructor(options:PortalOptions) {
        this.#key = options.apiKey.trim();
        if (this.#key.length < 16) {
            throw new Error('BOX_PLAYER_AUTH_API_KEY must contain at least 16 characters');
        }
        this.host = options.host ?? '127.0.0.1';
        // 直接复用类时允许 0 选择空闲端口；环境变量入口仍严格限制为 1–65535。
        this.port = PortalConfig.integer(options.port, 3214, 0, 65535, 'PORT');
        this.playerServiceURL = PortalConfig.url(
            options.playerServiceURL.href,
            'Player Service URL',
        );
        this.publicURL = options.publicURL
            ? PortalConfig.url(options.publicURL.href, 'publicURL')
            : null;
        this.creatorURL = options.creatorURL
            ? PortalConfig.url(options.creatorURL.href, 'creatorURL')
            : null;
        this.playURL = options.playURL ? PortalConfig.url(options.playURL.href, 'playURL') : null;
        this.requestTimeoutMs = PortalConfig.integer(
            options.requestTimeoutMs,
            10000,
            1000,
            60000,
            'requestTimeoutMs',
        );
        this.trustProxy = options.trustProxy === true;
        this.registrationEnabled = options.registrationEnabled !== false;
        this.publicDirectory = options.publicDirectory;
    }

    public get apiKey():string {
        return this.#key;
    }

    public static fromEnvironment(env:NodeJS.ProcessEnv = process.env):PortalConfig {
        // 标准变量优先，旧名称仅用于兼容，不提供演示密钥作为生产默认值。
        const value = (name:string, legacy:string) => env[name] ?? env[legacy];
        const apiKey = value('BOX_PLAYER_AUTH_API_KEY', 'AUTH_DEMO_API_KEY') || '';
        if (apiKey.trim().length < 16) {
            throw new Error('BOX_PLAYER_AUTH_API_KEY must contain at least 16 characters');
        }
        const optional = (name:string, legacy:string) => {
            const raw = value(name, legacy)?.trim();
            return raw ? this.url(raw, name) : null;
        };
        return new PortalConfig({
            apiKey,
            playerServiceURL: this.url(
                value('BOX_PLAYER_SERVICE_INTERNAL_URL', 'AUTH_DEMO_PLAYER_SERVICE_URL') || '',
                'Player Service URL',
            ),
            host: value('HOST', 'AUTH_DEMO_HOST') || '127.0.0.1',
            port: this.integer(value('PORT', 'AUTH_DEMO_PORT'), 3214, 1, 65535, 'PORT'),
            publicURL: optional('BOX_AUTH_PORTAL_PUBLIC_URL', 'AUTH_DEMO_PUBLIC_URL'),
            creatorURL: optional('BOX_CREATOR_PUBLIC_URL', 'AUTH_DEMO_CREATOR_URL'),
            playURL: optional('BOX_PLAY_PUBLIC_URL', 'AUTH_DEMO_PLAY_URL'),
            requestTimeoutMs: this.integer(
                value('BOX_AUTH_PORTAL_REQUEST_TIMEOUT_MS', 'AUTH_DEMO_REQUEST_TIMEOUT_MS'),
                10000,
                1000,
                60000,
                'requestTimeoutMs',
            ),
            trustProxy: value('BOX_TRUST_PROXY', 'AUTH_DEMO_TRUST_PROXY') === 'true',
            registrationEnabled:
                value('BOX_PLAYER_REGISTRATION_ENABLED', 'AUTH_DEMO_REGISTRATION_ENABLED')
                    ?.trim()
                    .toLowerCase() !== 'false',
        });
    }

    private static integer(
        value:unknown,
        fallback:number,
        min:number,
        max:number,
        name:string,
    ):number {
        const result = value == null || value === '' ? fallback : Number(value);
        if (!Number.isInteger(result) || result < min || result > max) {
            throw new Error(`${name} must be an integer between ${min} and ${max}`);
        }
        return result;
    }

    private static url(value:string, name:string):URL {
        let result:URL;
        try {
            result = new URL(value);
        } catch {
            throw new Error(`${name} must be a valid HTTP/HTTPS URL`);
        }
        if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) {
            throw new Error(`${name} must be an HTTP/HTTPS URL without credentials`);
        }
        return result;
    }

    public protocol(request:IncomingMessage):string {
        // 对外协议由服主配置决定，容器内的 HTTP 传输不能把 HTTPS 会话降级。
        if (this.publicURL) {
            return this.publicURL.protocol.slice(0, -1);
        }
        return this.incomingProtocol(request);
    }

    private incomingProtocol(request:IncomingMessage):string {
        const forwarded = String(request.headers['x-forwarded-proto'] || '')
            .split(',')[0]
            .trim();
        if (this.trustProxy && ['http', 'https'].includes(forwarded)) {
            return forwarded;
        }
        return 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
    }

    public sameOrigin(request:IncomingMessage):boolean {
        const origin = request.headers.origin;
        if (!origin) {
            return true;
        } // 非浏览器工具请求仍须通过后端固定路由与 JSON 约束。
        const forwarded = this.trustProxy
            ? String(request.headers['x-forwarded-host'] || '')
                  .split(',')[0]
                  .trim()
            : '';
        const host = forwarded || request.headers.host;
        try {
            const requestedOrigin = new URL(origin).origin;
            return (
                requestedOrigin === this.publicURL?.origin ||
                (Boolean(host) && requestedOrigin === `${this.incomingProtocol(request)}://${host}`)
            );
        } catch {
            return false;
        }
    }

    public clientAddress(request:IncomingMessage):string {
        // 不可信浏览器提供的 IP 不能用于限流/封禁，否则可随意更换身份。
        const valid = (value:string) => {
            const ip = value.trim().replace(/^::ffff:/, '');
            return isIP(ip) ? ip : '';
        };
        if (this.trustProxy) {
            const forwarded = String(request.headers['x-forwarded-for'] || '')
                .split(',')
                .map(valid)
                .find(Boolean);
            if (forwarded) {
                return forwarded;
            }
            const real = valid(String(request.headers['x-real-ip'] || ''));
            if (real) {
                return real;
            }
        }
        return valid(request.socket.remoteAddress || '');
    }

    public returnURL(source:string, requested:string):string | null {
        const base =
            source === 'play' ? this.playURL : source === 'creator' ? this.creatorURL : null;
        if (!base) {
            return null;
        }
        try {
            const candidate = new URL(requested || '', base);
            return candidate.origin === base.origin ? candidate.href : base.href;
        } catch {
            return base.href;
        }
    }
}
