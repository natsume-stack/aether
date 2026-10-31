'use strict';
/**
 * BOX3 同域名路径薄网关（零依赖，仅 node:http / node:url）
 *
 * 职责：在**同一个公网域名**下按 URL 前缀把请求分流给不同后端服务：
 *   /edit*  -> creator        （创作端）
 *   /admin* -> player-service （管理端）
 *   其余    -> play           （玩家端，含 / 与 /p/<map>）
 *
 * 它**不做**的事（刻意留白，越界就会破坏各服务自己的门）：
 *   - 不做鉴权、不签发/校验 Cookie、不读权限（creator 的 Host/Origin 门、
 *     player-service 的会话门都在服务内部）。
 *   - 不改 header、不改响应体：它只在 `path` 上做手脚（见 stripPrefix）——
 *     `@box/deployment-routing` 只往 nextConfig 挂 assetPrefix、**不设 Next 的 basePath**，
 *     Next 服务端路由器永远看到无前缀 path（实测：容器内 GET /edit/projects -> 404，
 *     GET /projects -> 307）。所以「入站剥前缀 + 出站由服务自己加回前缀」是这套机制的
 *     两半，缺这一层就没有跨服务分流：standalone.cjs 的 peers 只用于**跳过**兄弟前缀，
 *     它不负责分流（包 README：「不负责证书、Nginx、服务登录或授权」）。
 *   - 不伪造安全响应头：COOP/COEP/CSP/X-Content-Type-Options 由各服务 headers() 发出，
 *     网关只透传；剥掉会破坏 SharedArrayBuffer（COEP）与 iframe 策略。
 *
 * 必须原样透传的东西（少一个就 403/断连，见 apps/game/server/creator-api-security.ts:48-83）：
 *   Host            creator 门要求 Host ∈ 回环 ∪ BOX_CREATOR_ALLOWED_HOSTS；
 *                   网关若换成上游内部名（creator:3000）则恒 403。
 *   Origin          门要求 `new URL(Origin).host === req.headers.host`；
 *                   改写 Host 或丢 Origin 都 403。
 *   Cookie          会话由 player-service 域下发，丢了等于全部未登录。
 *   Sec-WebSocket-* + Upgrade/Connection  WS 子协议是 `box3-game, box3-proof.<sid>`，
 *                   凭证在子协议里；剥掉则握手 400、进图即断。
 *   X-Forwarded-*   只做追加，不覆盖（BOX_TRUST_PROXY=false 时服务不读它）。
 *
 * 流式：HTTP body 与 WS 帧都走 socket 直管（pipe），不缓冲整个请求/响应；
 * 体素资产（几十 MB 的 /block、/engine、/runtime/*）与 43 KB 的 mudb 握手 JSON
 * 都靠这个不被"攒齐再发"打乱顺序。
 */
const http = require('node:http');

const LISTEN_PORT = Number(process.env.BOX_GATEWAY_PORT || process.env.PORT || 8080);
const LISTEN_HOST = process.env.BOX_GATEWAY_BIND || '0.0.0.0';

let config;
try {
    config = JSON.parse(process.env.BOX_GATEWAY_ROUTES || '{}');
} catch (error) {
    console.error('gateway: BOX_GATEWAY_ROUTES is not valid JSON:', error.message);
    process.exit(1);
}
const UPSTREAMS = config.upstreams || {};
const PREFIXES = config.prefixes || {};
const DEFAULT_UPSTREAM = config.default || 'play';
/** 需要「无尾斜杠 -> 308 补斜杠」的前缀根（Umi 这类相对资源入口），如 ["/admin"]。 */
const SLASH_ROOTS = Array.isArray(config.slashRoots) ? config.slashRoots : [];
/**
 * 闸（a）· 前缀拒绝闸：剥完前缀后上游**实际会收到**的路径命中这些前缀一律 404 不透出。
 * 依据（B 泳道实测，box3-re/tmp/b2-gw-internal-probe.txt）：`/edit/api/internal/*` 剥前缀后
 * 在路由层照样命中 creator 的 internal 面，`/edit/%2e%2e/api/internal/*` 会被 Next 归一化成
 * `/api/internal/*`；当前挡住它们的只有 creator/play 自己的 loopback 门对**真实 socket 对端**
 * 的判定 —— 那是部署不变量，不是网关保证。所以网关必须自带显式拒绝闸（本段），双保险。
 */
const DENY_ONWARD = Array.isArray(config.denyOnward) ? config.denyOnward : ['/api/internal', '/api/creator/v1', '/player-admin'];
/**
 * 拒绝闸的唯一豁免表：某段危险路径**经由指定公开前缀**时是合法资源 ——
 * 管理端静态入口 `/admin/player-admin/umi.<hash>.js`（O21 §5-C1d 实测 200/550698B），
 * 入站剥掉 /admin 后正是 `/player-admin/*`。不经 /admin 前缀的裸 `/player-admin/*` 仍一律拒绝。
 * `/api/creator/v1`（creator-api-security.ts:22 的 CLI Bearer 面）与 `/api/internal` 无豁免：
 * b2-gw-internal-probe.txt 实测这两个面同被上游 loopback 门罩着，浏览器侧从不直调它们。
 */
const DENY_ALLOW_VIA = config.denyAllowViaPrefix || { '/player-admin': ['/admin'] };
/** 逐跳头：RFC 7230 规定不得转发；其余一律透传。 */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

/** 前缀 -> 上游名。最长前缀优先，且只接受段边界（/edit 命中 /edit 与 /edit/x，不命中 /editable）。 */
function selectUpstream(rawUrl) {
    let pathname = String(rawUrl || '/');
    const cut = pathname.search(/[?#]/);
    if (cut >= 0) pathname = pathname.slice(0, cut);
    let best = null;
    for (const prefix of Object.keys(PREFIXES)) {
        if (!prefix || prefix === '/') continue;
        const hit = pathname === prefix || pathname.startsWith(`${prefix}/`);
        if (hit && (!best || prefix.length > best.length)) best = prefix;
    }
    return best ? { name: PREFIXES[best], prefix: best } : { name: DEFAULT_UPSTREAM, prefix: '' };
}

/**
 * 剥掉这一段前缀再送进上游。
 *
 * 为什么必须剥（实测，见 box3-re/scan/O21 的 C 项）：`@box/deployment-routing` 的
 * basePath 是**只加不减**的出站改写器 —— next-webpack.cjs 把 __NEXT_ROUTER_BASEPATH
 * 编译成 `(process.env.BOX_APP_BASE_PATH || "")` / `(window.__BOX_APP_BASE_PATH__ || "")`，
 * standalone.cjs 只往 nextConfig 上挂 `assetPrefix`，**没有设 nextConfig.basePath**，
 * 所以 Next 服务端路由器的 basePath 恒为空：带前缀打进去必然 404。
 *   容器内直连 `GET /edit/projects` -> 404；`GET /projects` -> 307（真路由）。
 *   容器内直连 `GET /admin` -> 404；`GET /` -> 200（管理站页面）。
 * 出站方向由 server.cjs 的 html()/writeHead 改写把前缀**加回来**，
 * 浏览器看到的始终是 /edit/…、/admin/…；这一层的职责就是「入站剥、出站加」的另一半。
 * 查询串与尾斜杠必须一起搬走：`/edit?x=1` -> `/?x=1`，`/edit/` -> `/`。
 */
function stripPrefix(rawUrl, prefix) {
    if (!prefix) return rawUrl;
    const rest = rawUrl.slice(prefix.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
}

function targetOf(name) {
    const raw = UPSTREAMS[name];
    if (!raw) return null;
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

/** 点段归一化：把 `%2e%2e`/`..` 折叠掉，防止「剥前缀后用 ../ 逃回危险路径」。 */
function normalizeSegments(pathname) {
    const out = [];
    for (const seg of String(pathname || '').split('/')) {
        if (seg === '..') out.pop();
        else if (seg !== '.') out.push(seg);
    }
    return `/${out.join('/').replace(/^\/+/, '')}`;
}

/** 一个 URL 的可疑变体：原样、解码一次、解码+归一化（三者任一命中即拒）。 */
function denyVariants(rawUrl) {
    const pathOnly = String(rawUrl || '').split('?')[0].split('#')[0];
    const set = new Set([pathOnly]);
    let decoded = pathOnly;
    try {
        decoded = decodeURIComponent(pathOnly);
    } catch {}
    set.add(decoded);
    try {
        set.add(normalizeSegments(decoded));
    } catch {}
    return [...set];
}

/**
 * 闸（a）判定：对「浏览器原样 URL」和「剥完前缀送进上游的 URL」两层同时检查。
 * 段边界命中（/api/internal、/api/internal/x）或子串命中（/editable/api/internal/x、
 * /edit/%2e%2e/api/internal/x —— 上游 Next 会归一化成 internal 面）都拒。
 * 命中返回危险前缀，否则返回 null。
 */
function denyHit(rawUrl, prefix) {
    const inbound = stripPrefix(rawUrl, prefix);
    for (const bad of DENY_ONWARD) {
        const allow = DENY_ALLOW_VIA[bad];
        if (prefix && Array.isArray(allow) && allow.includes(prefix)) continue;
        for (const v of [...denyVariants(rawUrl), ...denyVariants(inbound)]) {
            if (v === bad || v.startsWith(`${bad}/`) || v.includes(bad)) return bad;
        }
    }
    return null;
}

function rejectDenied(request, response, hit) {
    // 与 Next 自己的 404 同形（纯文本 404），不给探测者「网关存在」的指纹。
    log(`gateway: DENY ${request.method} ${request.url} (onward-prefix "${hit}" never exposed)`);
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('404 Not Found\n');
}

/** 透传请求头 + 追加 X-Forwarded-*。`host`/`origin`/`cookie`/`sec-websocket-*` 一律原样保留。 */
function forwardHeaders(request, { websocket, prefix }) {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (!websocket && HOP_BY_HOP.has(lower)) continue;
        if (websocket && lower !== 'connection' && lower !== 'upgrade' && HOP_BY_HOP.has(lower)) {
            continue;
        }
        if (websocket && (lower === 'content-length' || lower === 'transfer-encoding')) continue;
        headers[lower] = value;
    }
    // 保留原始大小写没有意义：Node 会规范化；关键是 host/origin/cookie 不被改。
    if (headers.host === undefined && request.headers.host) headers.host = request.headers.host;

    // 闸（b）· Host/Origin 保真：creator 的门（apps/game/server/creator-api-security.ts:33-61）
    // 要求 Host ∈ 回环 ∪ BOX_CREATOR_ALLOWED_HOSTS，且 Origin(host) === Host。
    // 网关的契约是「原样搬运」——这里做**强制自愈式断言**：无论上游逻辑怎么变，
    // 送出去的 host/origin 永远等于收到的 host/origin（Node 的 setHost 陷阱、
    // 未来有人改这个函数时的回归，都由这两行兜住）。反例证据：若把 host 换成
    // 上游内部名或伪造 Host，creator 恒 403（见 O21 续章 G1b-2 的 curl 矩阵）。
    headers.host = request.headers.host;
    if (request.headers.origin !== undefined) headers.origin = request.headers.origin;

    const chain = (name, value) => {
        const existing = request.headers[name];
        headers[name] = existing ? `${existing}, ${value}` : String(value);
    };
    const socket = request.socket;
    chain('x-forwarded-for', (socket && socket.remoteAddress) || 'unknown');
    chain('x-forwarded-proto', 'http');
    if (request.headers.host) chain('x-forwarded-host', request.headers.host);
    chain('x-forwarded-port', String(LISTEN_PORT));
    // 只作诊断用：上游不读它（BOX_TRUST_PROXY=false），但运维排错时一眼能看见
    // 「浏览器要的整段前缀」和「送进去的实际 path」的差值。
    if (prefix) headers['x-forwarded-prefix'] = prefix;
    return headers;
}

function responseHeaders(upstream) {
    const out = {};
    for (const [key, value] of Object.entries(upstream.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        out[key] = value;
    }
    return out;
}

function sendBadGateway(response, cause, label) {
    log(`gateway: 502 ${label}`, cause && cause.message ? cause.message : String(cause));
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad Gateway\n');
}

const server = http.createServer((request, response) => {
    // 唯一由网关自己回答的路径：容器的 HEALTHCHECK 打它，不占用任何应用前缀。
    if (request.url === '/__gateway-health') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('ok\n');
        return;
    }
    const route = selectUpstream(request.url);
    // 闸（a）：internal/管理类前缀绝不透出（先于一切路由/改写，见 denyHit 注释）。
    const denied = denyHit(request.url, route.prefix);
    if (denied) {
        rejectDenied(request, response, denied);
        return;
    }
    // `./player-admin/*.js` 这种**相对**引用，deployment-routing 只改写绝对路径，
    // 相对引用交给浏览器按当前 URL 解析。`/admin`（无斜杠）会被浏览器解析成
    // `/player-admin/umi.js` -> 落到玩家端上游 -> 404 白屏。`/admin/` 才落在自己前缀内。
    // 只对 SLASH_ROOTS 显式声明的前缀根生效；`/edit` 由 Next 自己 307 到 /edit/projects。
    if (route.prefix && SLASH_ROOTS.includes(route.prefix) && request.url === route.prefix) {
        response.writeHead(308, { location: `${route.prefix}/`, 'content-type': 'text/plain; charset=utf-8' });
        response.end();
        return;
    }
    const inbound = stripPrefix(request.url, route.prefix);
    const target = targetOf(route.name);
    if (!target) {
        log(`gateway: 500 no upstream configured for "${route.name}"`);
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Gateway Misconfiguration\n');
        return;
    }
    const started = Date.now();
    const upstream = http.request(
        {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: inbound, // 入站剥前缀（见 stripPrefix 注释）；查询串随 path 一起搬走
            method: request.method,
            setHost: false, // 只用下面显式透传的 host，绝不让 Node 换成上游内部名
            headers: forwardHeaders(request, { websocket: false, prefix: route.prefix }),
            agent: undefined,
        },
        (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse));
            upstreamResponse.pipe(response);
        },
    );
    upstream.on('error', (error) => sendBadGateway(response, error, `${request.method} ${request.url} -> ${route.name}`));
    request.pipe(upstream);
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
    });
    response.on('finish', () => {
        log(
            `gateway: ${request.method} ${request.url} -> ${route.name} ${response.statusCode} ${Date.now() - started}ms`,
        );
    });
});

/**
 * WebSocket / 任何 upgrade 请求：socket 级双向直管。
 * 不缓冲、不解析帧、不改写 Sec-WebSocket-Accept —— 乱序风险已经由 @box/mudb 的
 * 握手闸门兜住，网关这里只做一件事：把字节原样、按序、成流地搬过去。
 */
server.on('upgrade', (request, clientSocket, head) => {
    const route = selectUpstream(request.url);
    // 闸（a）同样罩住 WS 升级：/edit/…/api/internal、裸 /player-admin 的 upgrade 也一律 404。
    const denied = denyHit(request.url, route.prefix);
    if (denied) {
        log(`gateway: DENY WS ${request.url} (onward-prefix "${denied}" never exposed)`);
        clientSocket.end('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\nConnection: close\r\n\r\n');
        return;
    }
    const inbound = stripPrefix(request.url, route.prefix);
    const target = targetOf(route.name);
    if (!target) {
        clientSocket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        return;
    }
    clientSocket.on('error', (error) => log('gateway: client socket error', error.message));

    const upstream = http.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: inbound,
        method: request.method,
        setHost: false,
        headers: forwardHeaders(request, { websocket: true, prefix: route.prefix }),
    });
    let settled = false;
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
        settled = true;
        const lines = [`HTTP/1.1 101 ${upstreamResponse.statusMessage || 'Switching Protocols'}`];
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key.toLowerCase() === 'transfer-encoding') continue;
            for (const single of Array.isArray(value) ? value : [value]) {
                lines.push(`${key}: ${single}`);
            }
        }
        clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
        // 客户端在 upgrade 事件之前可能已经跟着发了帧（head）——必须先进上游。
        if (head && head.length > 0) upstreamSocket.write(head);
        upstreamSocket.setTimeout(0);
        clientSocket.setTimeout(0);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        const cleanup = () => {
            if (!upstreamSocket.destroyed) upstreamSocket.destroy();
            if (!clientSocket.destroyed) clientSocket.destroy();
        };
        upstreamSocket.on('error', cleanup);
        upstreamSocket.on('close', cleanup);
        clientSocket.on('close', cleanup);
        log(`gateway: WS ${request.url} -> ${route.name} upgraded`);
    });
    // 上游拒绝升级（400/401/403/502）：当成普通 HTTP 响应搬回去。
    upstream.on('response', (upstreamResponse) => {
        settled = true;
        clientSocket.write(
            `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage || ''}\r\n` +
                Object.entries(responseHeaders(upstreamResponse))
                    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                    .join('\r\n') +
                '\r\nConnection: close\r\n\r\n',
        );
        upstreamResponse.pipe(clientSocket);
        upstreamResponse.on('end', () => clientSocket.end());
    });
    upstream.on('error', (error) => {
        log(`gateway: WS 502 ${request.url} -> ${route.name}`, error.message);
        if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    clientSocket.on('close', () => {
        if (!settled) upstream.destroy();
        else if (!upstream.destroyed) upstream.destroy();
    });
    upstream.end();
});

// WS 与体素大响应都不能被 Node 18+ 默认的 300s requestTimeout 掐掉。
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 75_000;
// mudb 握手是单个大文本帧，但 HTTP 头里可能带长 Cookie + 双 Sec-WebSocket-Protocol。
server.maxHeadersCount = 0;
server.maxRequestsPerSocket = 0;

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log(
        `gateway: listening ${LISTEN_HOST}:${LISTEN_PORT}`,
        JSON.stringify({ prefixes: PREFIXES, default: DEFAULT_UPSTREAM, upstreams: UPSTREAMS }),
    );
});
process.on('SIGTERM', () => {
    log('gateway: SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
});
