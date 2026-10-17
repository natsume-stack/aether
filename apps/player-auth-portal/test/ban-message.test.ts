import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PortalClient, PortalError } from '../src/client';

for (const title of ['该玩家已被封禁', '当前 IP 地址已被封禁', '当前设备已被封禁']) {
    test(`${title}: includes reason and finite expiry`, () => {
        const expires = '2026-10-04T08:00:00.000Z';
        const error = new PortalError(title, new Response(null, { status: 403 }), {
            banReason: '违规测试',
            bannedUntil: expires,
        });
        assert.equal(
            PortalClient.message(error),
            `${title}\n封禁原因：违规测试\n封禁期限：${new Date(expires).toLocaleString('zh-CN')}`,
        );
    });
    test(`${title}: permanent ban with missing reason`, () => {
        const error = new PortalError(title, new Response(null, { status: 403 }), {
            banReason: '',
            bannedUntil: null,
        });
        assert.equal(PortalClient.message(error), `${title}\n封禁原因：未说明\n封禁期限：永久`);
    });
}
