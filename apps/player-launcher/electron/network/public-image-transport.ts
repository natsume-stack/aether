import { normalizeEndpoint } from './api-transport';

const MAX_PUBLIC_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validatePublicImageUrl(endpointUrl:URL, rawUrl:string):URL {
    let url:URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('地图封面地址无效');
    }
    const basePath = endpointUrl.pathname.replace(/\/$/, '');
    const path = url.pathname.slice(basePath.length);
    const isTemplateCover = /^\/map-templates\/[A-Za-z0-9._~-]{1,160}$/.test(path);
    const isMapBlockCover =
        /^\/runtime\/play\/[a-z0-9][a-z0-9-]{0,62}\/block\/[A-Za-z0-9._~-]{1,160}$/.test(path);
    if (
        url.origin !== endpointUrl.origin ||
        !url.pathname.startsWith(`${basePath}/`) ||
        (!isTemplateCover && !isMapBlockCover) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new Error('地图封面请求地址不在允许范围内');
    }
    return url;
}

export function createPublicImageTransport({
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
}:{ fetchImpl?:typeof fetch; timeoutMs?:number } = {}) {
    return Object.freeze({
        async fetch(endpoint:string, rawUrl:string):Promise<string> {
            const endpointUrl = normalizeEndpoint(endpoint);
            const url = validatePublicImageUrl(endpointUrl, rawUrl);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let response:Response;
            try {
                response = await fetchImpl(url, {
                    method: 'GET',
                    redirect: 'manual',
                    signal: controller.signal,
                });
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error('地图封面加载超时');
                }
                throw new Error('无法从游玩服务器读取地图封面');
            } finally {
                clearTimeout(timer);
            }
            if (!response.ok || response.status !== 200) {
                await response.body?.cancel();
                throw new Error(`地图封面加载失败（HTTP ${response.status}）`);
            }
            const contentType = String(response.headers.get('content-type') || '')
                .split(';', 1)[0]
                .trim()
                .toLowerCase();
            if (!IMAGE_CONTENT_TYPES.has(contentType)) {
                await response.body?.cancel();
                throw new Error('游玩服务器返回的地图封面格式不受支持');
            }
            if (Number(response.headers.get('content-length')) > MAX_PUBLIC_IMAGE_BYTES) {
                await response.body?.cancel();
                throw new Error('地图封面超过启动器安全大小限制');
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > MAX_PUBLIC_IMAGE_BYTES) {
                throw new Error('地图封面超过启动器安全大小限制');
            }
            return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
        },
    });
}

export { validatePublicImageUrl };
