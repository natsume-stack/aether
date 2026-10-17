import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runSmoke } from './smoke-runner.mts';

test('test profile is removed by the parent after the child releases its files', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'smoke-parent-test-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const marker = path.join(root, 'profile-path');
    await runSmoke({
        executable: process.execPath,
        cwd: root,
        name: 'fixture',
        timeoutMs: 10_000,
        args: [
            '-e',
            `const fs=require('node:fs'); const path=require('node:path'); const profile=process.env.BOX_LAUNCHER_TEST_USER_DATA; fs.writeFileSync(process.argv[1], profile); fs.openSync(path.join(profile,'open-cache-file'),'w');`,
            marker,
        ],
    });
    const profile = await readFile(marker, 'utf8');
    await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('nonzero child exit is a failed smoke test', async () => {
    await assert.rejects(
        runSmoke({
            executable: process.execPath,
            args: ['-e', 'process.exit(2)'],
            cwd: process.cwd(),
            name: 'fixture',
            timeoutMs: 10_000,
        }),
        /smoke failed \(2\)/,
    );
});

test(
    'a lingering test process is terminated and fails instead of hanging the pipeline',
    { timeout: 15_000 },
    async () => {
        await assert.rejects(
            runSmoke({
                executable: process.execPath,
                args: ['-e', 'setInterval(()=>{},1000)'],
                cwd: process.cwd(),
                name: 'fixture',
                timeoutMs: 100,
            }),
            /smoke timed out/,
        );
    },
);
