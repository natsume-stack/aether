import { apiOperations } from '@box/apis';

// Routes come from the generated OpenAPI registry; the desktop bridge exposes
// only the operations used by players.
const playerOperations = [
    apiOperations.getApiHealthCheck,
    apiOperations.getApiPlayerLauncherBootstrap,
    apiOperations.getApiPlayerLauncherMaps,
    apiOperations.getApiPlayerLauncherMapsMapIdDescriptor,
    apiOperations.getApiPlayerLauncherMapsMapIdDownloadPlan,
    apiOperations.patchApiPlayProfile,
    apiOperations.getApiPlayLibrary,
    apiOperations.patchApiPlayLibrary,
];
const authOperations = [
    apiOperations.postApiAuthLogin,
    apiOperations.postApiAuthLogout,
    apiOperations.getApiAuthSession,
];

function matches(
    path:string,
    method:string | undefined,
    operation:{ path:string; method:string },
):boolean {
    const pattern = operation.path
        .split('/')
        .map((part) => (part.startsWith('{') ? '[^/]+' : part))
        .join('/');
    return (
        new RegExp(`^${pattern}$`).test(path) &&
        (!method || method.toUpperCase() === operation.method)
    );
}

export function isAllowedPlayerApi(
    endpoint:URL,
    target:URL,
    authOrigin?:string,
    method?:string,
):boolean {
    if (target.username || target.password || target.hash) {
        return false;
    }
    const basePath = endpoint.pathname.replace(/\/$/, '');
    const localPath = target.pathname.slice(basePath.length);
    const serverApi =
        target.origin === endpoint.origin &&
        target.pathname.startsWith(`${basePath}/`) &&
        [...playerOperations, ...authOperations].some((operation) =>
            matches(localPath, method, operation),
        );
    const portal = authOrigin ? new URL(authOrigin) : null;
    const authBase = portal?.pathname.replace(/\/$/, '') || '';
    const authApi =
        portal &&
        target.origin === portal.origin &&
        target.pathname.startsWith(`${authBase}/`) &&
        authOperations.some((operation) =>
            matches(target.pathname.slice(authBase.length), method, operation),
        );
    return Boolean(serverApi || authApi);
}

export const playerLoginPath = apiOperations.postApiAuthLogin.path;
export const playerBootstrapPath = apiOperations.getApiPlayerLauncherBootstrap.path;

/** Extract only the validated portal prefix from the advertised login route. */
export function playerAuthBaseUrl(value:string):string {
    const url = new URL(value);
    const prefix = url.pathname.slice(0, -playerLoginPath.length);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.endsWith(playerLoginPath) ||
        (prefix && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(prefix))
    ) {
        throw new Error('服务器提供的玩家登录地址无效');
    }
    return url.origin + prefix;
}

export function isPlayerLoginUrl(url:URL):boolean {
    try {
        playerAuthBaseUrl(url.origin + url.pathname);
        return true;
    } catch {
        return false;
    }
}
