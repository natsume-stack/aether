import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playerServerAddError, playerServerConnectionError } from '../src/features/servers/errors';

test('server bootstrap errors never expose IPC wrappers or internal exception details', () => {
    for (const error of [
        new Error(
            "Error invoking remote method 'launcher:invoke': Error: 服务器服务未启动或连接端口不可用",
        ),
        "Error: Error invoking remote method 'launcher:invoke': Error: 服务器服务未启动或连接端口不可用",
    ]) {
        assert.equal(
            playerServerConnectionError(error),
            '无法连接游玩服务，请确认服务已启动、地址和端口正确后重新检查。',
        );
    }
    assert.equal(
        playerServerConnectionError(new Error('API 请求超时，请稍后重试')),
        '服务器响应超时，请稍后重新检查。',
    );
    assert.equal(
        playerServerConnectionError(new Error('无法解析服务器地址')),
        '无法解析服务器地址，请检查地址后重新检查。',
    );
    assert.equal(
        playerServerConnectionError(new Error('服务器连接被中断')),
        '服务器连接已中断，请稍后重新检查。',
    );
    for (const error of [new Error('secret stack /private/path'), null, {}]) {
        assert.equal(
            playerServerConnectionError(error),
            '无法读取服务器状态，请检查地址、端口和网络后重新检查。',
        );
    }
});

test('removes Electron IPC wrappers while preserving the player-facing network error', () => {
    assert.equal(
        playerServerAddError(
            new Error(
                "Error invoking remote method 'launcher:invoke': Error: 无法连接到游玩端服务器，请检查地址和网络",
            ),
        ),
        '无法连接到游玩端服务器，请检查地址、端口和网络后重试。',
    );
});

test('turns invalid server address errors into actionable player copy', () => {
    assert.equal(
        playerServerAddError(
            new Error(
                "Error invoking remote method 'launcher:invoke': Error: 请输入有效的游玩端服务器 IP 或域名",
            ),
        ),
        '服务器地址格式不正确，请检查后重试。',
    );
});
