/** Runs inside the cache inspector's renderer; only counters cross Electron IPC. */
export async function measureCachedResources(
    cacheName:string,
):Promise<{ bytes:number; resources:number }> {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    let cursor = 0;
    let bytes = 0;
    let resources = 0;
    await Promise.all(
        Array.from({ length: Math.min(8, keys.length) }, async () => {
            while (cursor < keys.length) {
                const key = keys[cursor++];
                const response = await cache.match(key);
                if (!response) {
                    continue;
                }
                const length = response.headers.get('content-length');
                const size = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
                // Network Content-Length can describe compressed bytes. Older cache
                // entries without reliable metadata are measured locally as Blobs.
                const byteLength =
                    Number.isSafeInteger(size) && !response.headers.has('content-encoding')
                        ? size
                        : (await response.blob()).size;
                bytes += byteLength;
                resources += 1;
            }
        }),
    );
    return { bytes, resources };
}
