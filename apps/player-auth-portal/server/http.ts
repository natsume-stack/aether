import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import bootstrap from '@box/deployment-routing/browser';

import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
    public readonly status:number;
    public readonly code:string;
    public readonly headers:Record<string, string>;
    public constructor(
        status:number,
        code:string,
        message:string,
        headers:Record<string, string> = {},
    ) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }
}

/** 统一响应格式，不保存会话或密码。账号响应永远不缓存。 */
export class Http {
    public static json(
        response:ServerResponse,
        status:number,
        value:unknown,
        headers:Record<string, string | string[]> = {},
    ):void {
        const body = Buffer.from(JSON.stringify(value));
        response.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length,
            'Cache-Control': 'no-store',
            ...headers,
        });
        response.end(body);
    }
    public static error(response:ServerResponse, status:number, code:string, message:string):void {
        this.json(response, status, { code, message });
    }
}

/** 请求正文对象持有大小上限，读取与解析分开，不能拿它做文件上传。 */
export class JsonBody {
    public readonly maximumBytes:number;
    public constructor(maximumBytes = 32768) {
        this.maximumBytes = maximumBytes;
    }
    private requireJson(request:IncomingMessage):void {
        if (
            !String(request.headers['content-type'] || '')
                .toLowerCase()
                .startsWith('application/json')
        ) {
            throw new HttpError(
                415,
                'UNSUPPORTED_MEDIA_TYPE',
                'Content-Type must be application/json',
            );
        }
    }
    private async bytes(request:IncomingMessage):Promise<Buffer> {
        const chunks:Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > this.maximumBytes) {
                throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large');
            }
            chunks.push(bytes);
        }
        return Buffer.concat(chunks);
    }
    private parse(bytes:Buffer):Record<string, unknown> {
        try {
            const value:unknown = JSON.parse(bytes.toString('utf8') || '{}');
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error();
            }
            return value as Record<string, unknown>;
        } catch {
            throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
        }
    }
    public async read(request:IncomingMessage):Promise<Record<string, unknown>> {
        this.requireJson(request);
        return this.parse(await this.bytes(request));
    }
}

interface Asset {
    relative:string;
    type:string;
    html:boolean;
}
/** 仅服务 public，不开放隐藏文件、目录穿越或越界符号链接。 */
export class StaticFiles {
    private readonly directory:string;
    private readonly types = new Map([
        ['.js', 'text/javascript; charset=utf-8'],
        ['.css', 'text/css; charset=utf-8'],
        ['.png', 'image/png'],
        ['.jpg', 'image/jpeg'],
        ['.jpeg', 'image/jpeg'],
        ['.webp', 'image/webp'],
        ['.gif', 'image/gif'],
        ['.svg', 'image/svg+xml'],
        ['.ico', 'image/x-icon'],
        ['.woff', 'font/woff'],
        ['.woff2', 'font/woff2'],
    ]);
    public constructor(directory = path.resolve(process.cwd(), 'public')) {
        this.directory = directory;
    }
    private asset(pathname:string):Asset | null {
        let relative:string;
        try {
            relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
        } catch {
            return null;
        }
        if (
            !relative.startsWith('/') ||
            relative.includes('\\') ||
            relative.includes('\0') ||
            relative.split('/').some((part) => part.startsWith('.'))
        ) {
            return null;
        }
        const html = relative === '/index.html';
        const type = html
            ? 'text/html; charset=utf-8'
            : this.types.get(path.extname(relative).toLowerCase());
        return type ? { relative, type, html } : null;
    }
    private async file(asset:Asset):Promise<string | null> {
        try {
            const root = await realpath(this.directory);
            const file = await realpath(path.resolve(root, '.' + asset.relative));
            return file.startsWith(root + path.sep) && (await stat(file)).isFile() ? file : null;
        } catch (error) {
            if (
                ['ENOENT', 'ENOTDIR', 'EACCES'].includes(
                    (error as NodeJS.ErrnoException).code || '',
                )
            ) {
                return null;
            }
            throw error;
        }
    }
    private headers(asset:Asset, length:number):Record<string, string | number> {
        return {
            'Content-Type': asset.type,
            'Content-Length': length,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': asset.html ? 'no-store' : 'public, max-age=300, must-revalidate',
            'Content-Security-Policy':
                "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        };
    }
    public async serve(response:ServerResponse, pathname:string):Promise<boolean> {
        const asset = this.asset(pathname);
        if (!asset) {
            return false;
        }
        const file = await this.file(asset);
        if (!file) {
            return false;
        }
        const body = await readFile(file);
        const headers = this.headers(asset, body.length);
        const config = (
            response as ServerResponse & {
                __boxPrefixConfig?:{ basePath:string; peerPaths:string[] };
            }
        ).__boxPrefixConfig;
        if (asset.html && config?.basePath) {
            const hash = createHash('sha256').update(bootstrap(config)).digest('base64');
            headers['Content-Security-Policy'] = String(headers['Content-Security-Policy']).replace(
                "script-src 'self'",
                `script-src 'self' 'sha256-${hash}'`,
            );
        }
        response.writeHead(200, headers);
        response.end(body);
        return true;
    }
}
