import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { runOssProcess, OssProcessError } from './oss-process.mts';
import { createOssClient } from './oss-client.mts';

import type { OssProcessOptions } from './oss-process.mts';

test('streams byte/rate progress while hiding raw transfer paths', async () => {
    const logs:string[] = [];
    await runOssProcess({
        command: process.execPath,
        args: [
            '-e',
            "console.log('Completed 16.0 MiB/32.0 MiB (2.0 MiB/s) with 1 file(s) remaining');console.log('upload: local-private-path to s3://private-bucket/key')",
        ],
        description: 'fixture upload',
        timeoutMs: 10_000,
        progress: true,
        log: (line) => logs.push(line),
    });
    assert.ok(logs.some((line) => line.includes('16.0 MiB/32.0 MiB')));
    assert.ok(logs.some((line) => line.startsWith('Completed fixture upload')));
    assert.ok(
        logs.every(
            (line) => !line.includes('private-bucket') && !line.includes('local-private-path'),
        ),
    );
});

test(
    'transfer failures retain stderr and timeouts terminate the command',
    { timeout: 15_000 },
    async () => {
        await assert.rejects(
            runOssProcess({
                command: process.execPath,
                args: ['-e', "console.error('Read timeout');process.exit(1)"],
                description: 'fixture',
                timeoutMs: 10_000,
            }),
            (error:OssProcessError) => error.stderr.includes('Read timeout'),
        );
        await assert.rejects(
            runOssProcess({
                command: process.execPath,
                args: ['-e', 'setInterval(()=>{},1000)'],
                description: 'fixture',
                timeoutMs: 100,
            }),
            /exceeded/,
        );
    },
);

test('uses multipart-compatible cp for transfers, bounded network timeouts and installer object metadata', async () => {
    const calls:OssProcessOptions[] = [];
    const client = await createOssClient(
        {
            bucket: 'fixture-bucket',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            accessKeyId: 'fixture-id',
            accessKeySecret: 'fixture-secret',
        },
        async (options) => {
            calls.push(options);
            const config = await readFile(options.env.AWS_CONFIG_FILE, 'utf8');
            assert.match(config, /multipart_threshold = 16MB/);
            assert.match(config, /max_concurrent_requests = 4/);
            return { stdout: options.progress ? '' : '{"ContentLength":100}', stderr: '' };
        },
    );
    try {
        const key = 'box-player-launcher/player-v0.1.0/installer.exe';
        await client.upload(key, 'installer with spaces.exe', 'application/octet-stream', {
            'player-sha256': 'a'.repeat(64),
        });
        await client.download(key, 'download with spaces.exe');
        assert.equal((await client.head(key)).ContentLength, 100);
        assert.deepEqual(calls[0].args.slice(2, 6), [
            's3',
            'cp',
            'installer with spaces.exe',
            's3://fixture-bucket/' + key,
        ]);
        assert.ok(calls[0].args.includes(JSON.stringify({ 'player-sha256': 'a'.repeat(64) })));
        assert.equal(calls[0].progress, true);
        assert.deepEqual(calls[2].args.slice(2, 4), ['s3api', 'head-object']);
        assert.equal(calls[2].progress, false);
        for (const call of calls) {
            assert.ok(call.args.includes('--cli-connect-timeout'));
            assert.ok(!call.args.includes('fixture-id') && !call.args.includes('fixture-secret'));
        }
    } finally {
        await client.close();
    }
});
