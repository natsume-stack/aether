import { ApiClient } from '@box/apis';

export interface Player {
    subjectId?:string;
    userId?:string;
    username:string;
    displayName:string;
    status?:string;
}
export interface Session {
    player:Player | null;
    registrationEnabled?:boolean;
    returnUrl?:string;
}
export type Tone = 'success' | 'error';

export class PortalError extends Error {
    public readonly status:number;
    public readonly code?:string;
    public readonly retryAfter?:string | null;
    public readonly registrationEnabled?:boolean;
    public readonly banReason?:string;
    public readonly bannedUntil?:string | null;
    public constructor(message:string, response:Response, data:Record<string, unknown>) {
        super(message);
        this.status = response.status;
        this.code = typeof data.code === 'string' ? data.code : undefined;
        this.retryAfter = response.headers.get('retry-after');
        this.registrationEnabled =
            typeof data.registrationEnabled === 'boolean' ? data.registrationEnabled : undefined;
        this.banReason = typeof data.banReason === 'string' ? data.banReason : undefined;
        this.bannedUntil = typeof data.bannedUntil === 'string' ? data.bannedUntil : null;
    }
}

/** 页面只复用这个客户端，不接触服务密钥或 HttpOnly Cookie。 */
export class PortalClient {
    private readonly api:ApiClient;
    public readonly navigation:{
        source:string;
        returnUrl:string;
        transferState:string;
        transferChallenge:string;
    };
    public constructor(search = location.search) {
        this.api = new ApiClient({
            baseUrl: typeof location === 'undefined' ? '' : location.origin,
        });
        const query = new URLSearchParams(search);
        this.navigation = {
            source: query.get('source') || '',
            returnUrl: query.get('returnUrl') || '',
            transferState: query.get('transferState') || '',
            transferChallenge: query.get('transferChallenge') || '',
        };
    }
    private navigationParams():Record<string, string> {
        return Object.fromEntries(Object.entries(this.navigation).filter(([, value]) => value));
    }
    private options() {
        return {
            credentials: 'same-origin' as const,
            cache: 'no-store' as const,
            signal: AbortSignal.timeout(15000),
        };
    }
    private async request<T extends object>(
        pending:Promise<{ response:Response; data?:T; error?:unknown }>,
    ):Promise<T> {
        const { response, data, error } = await pending;
        const parsed:unknown = data ?? error;
        const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        if (!response.ok || !valid || !data) {
            const details = valid ? (parsed as Record<string, unknown>) : {};
            throw new PortalError(
                typeof details.message === 'string'
                    ? details.message
                    : `请求失败（HTTP ${response.status}）`,
                response,
                details,
            );
        }
        return data;
    }
    public session():Promise<Session> {
        return this.request(
            this.api.getApiAuthSessionRaw({
                ...this.options(),
                params: { query: this.navigationParams() },
            }),
        );
    }
    public login(username:string, password:string):Promise<Session> {
        return this.request(
            this.api.postApiAuthLoginRaw({
                ...this.options(),
                body: { username, password, ...this.navigationParams() },
            }),
        );
    }
    public register(username:string, displayName:string, password:string):Promise<Session> {
        return this.request(
            this.api.postApiAuthRegisterRaw({
                ...this.options(),
                body: { username, displayName, password, ...this.navigationParams() },
            }),
        );
    }
    public logout():Promise<{ loggedOut:boolean }> {
        return this.request(this.api.postApiAuthLogoutRaw({ ...this.options(), body: {} }));
    }
    public updateNickname(displayName:string):Promise<{ player:Player }> {
        return this.request(
            this.api.patchApiAuthProfileRaw({ ...this.options(), body: { displayName } }),
        );
    }
    public changePassword(
        currentPassword:string,
        newPassword:string,
    ):Promise<{ changed:boolean; reloginRequired:boolean }> {
        return this.request(
            this.api.postApiAuthPasswordRaw({
                ...this.options(),
                body: { currentPassword, newPassword },
            }),
        );
    }
    public static message(error:unknown):string {
        if (error instanceof PortalError && error.banReason !== undefined) {
            return `${error.message}\n封禁原因：${error.banReason || '未说明'}\n封禁期限：${error.bannedUntil ? new Date(error.bannedUntil).toLocaleString('zh-CN') : '永久'}`;
        }
        if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
            return '请求超时，请稍后重试；不要连续重复提交。';
        }
        return error instanceof Error ? error.message : '请求失败，请稍后重试';
    }
}
