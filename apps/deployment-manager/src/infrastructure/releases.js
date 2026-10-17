import { releaseBase, validateRelease } from '../utils/releases.js';

export async function fetchLatestRelease(version) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetch(`${releaseBase(version)}/latest.json`, {
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'omit',
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(
                `更新服务返回 HTTP ${response.status}${text.trim() ? `：\n${text.trim()}` : ''}`,
            );
        }
        if (text.length > 128_000) {
            throw new Error('更新清单过大');
        }
        return validateRelease(JSON.parse(text));
    } finally {
        clearTimeout(deadline);
    }
}
