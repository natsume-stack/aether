import { publicEndpoints, publicServices } from './public-access.js';

/** Generate only external Nginx text; applying it remains operator-owned. */
export function externalNginxConfiguration(config) {
    try {
        const routes = publicEndpoints(config, { activeOnly: true }).filter((route) => {
            const mode =
                config[
                    ['creator', 'voxa'].includes(route.service)
                        ? 'creatorNetworkMode'
                        : 'playNetworkMode'
                ];
            return !mode || mode === 'public';
        });
        if (!routes.length) {
            return { content: '', error: '填写公网地址后生成配置。' };
        }
        const groups = new Map(),
            endpoints = new Set(),
            protocols = new Map();
        for (const route of routes) {
            const endpoint = `${route.domain}:${route.port}${route.path || '/'}`;
            if (endpoints.has(endpoint)) {
                throw new Error('服务入口重复，请使用不同地址、端口或路径。');
            }
            if (protocols.has(route.port) && protocols.get(route.port) !== route.secure) {
                throw new Error('同一个公网端口不能同时使用 HTTP 和 HTTPS。');
            }
            endpoints.add(endpoint);
            protocols.set(route.port, route.secure);
            const key = `${route.domain}:${route.port}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(route);
        }
        const blocks = [...groups.values()]
            .map((group) => {
                const { domain, port, secure } = group[0];
                const host = domain.includes(':') ? `[${domain}]` : domain;
                const locations = group
                    .map((route) => {
                        const [, label, , key, fallback] = publicServices.find(
                            ([service]) => service === route.service,
                        );
                        const upstream = Number(config[key] || fallback);
                        if (!Number.isInteger(upstream) || upstream < 1 || upstream > 65535) {
                            throw new Error(`${label} 服务端口必须在 1–65535 之间。`);
                        }
                        const path = route.path;
                        return `    # ${label}：${route.url}
${
    path
        ? `    location = ${path} { return 308 ${path}/$is_args$args; }
    location ^~ ${path}/ {
        rewrite ^${path}(/.*)$ $1 break;`
        : '    location / {'
}
        # 同机上游使用 127.0.0.1；远程或容器 Nginx 请改为可达的引擎地址
        proxy_pass http://127.0.0.1:${upstream};
        proxy_http_version 1.1;
        # 保持外部协议与请求来源；WebSocket 转发不能省略
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $box_connection;
        proxy_read_timeout 3600s;
    }`;
                    })
                    .join('\n');
                return `server {
    listen ${port}${secure ? ' ssl' : ''};
    server_name ${host};
${
    secure
        ? `    # 替换为外部 Nginx 可读取的完整证书链与私钥路径
    # 共用证书需覆盖实际域名或 IP；这里不会自动签发或上传证书
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`
        : ''
}
${locations}
}`;
            })
            .join('\n\n');
        return {
            content: `# 放入 Nginx 的 http 配置区，例如 conf.d/box-engine.conf
# map 只定义一次；保存此文件后执行 nginx -t，成功后重载
map $http_upgrade $box_connection { default upgrade; '' close; }

${blocks}`,
            error: '',
        };
    } catch (error) {
        return { content: '', error: String(error).replace(/^Error: /, '') };
    }
}
