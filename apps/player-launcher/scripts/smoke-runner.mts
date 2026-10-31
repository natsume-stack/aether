import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

interface SmokeOptions {
    executable:string;
    args:string[];
    cwd:string;
    name:string;
    timeoutMs?:number;
    env?:NodeJS.ProcessEnv;
}

/** The parent owns cleanup: Windows can retain Chromium profile locks until exit. */
export async function runSmoke({
    executable,
    args,
    cwd,
    name,
    timeoutMs = 120_000,
    env = process.env,
}:SmokeOptions):Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'box-player-smoke-'));
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(executable, args, {
                cwd,
                stdio: 'inherit',
                windowsHide: true,
                detached: process.platform !== 'win32',
                env: { ...env, BOX_LAUNCHER_TEST_USER_DATA: directory },
            });
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                console.error(
                    `${name} smoke exceeded ${timeoutMs / 1000}s; terminating the isolated test process`,
                );
                if (!child.pid) {
                    reject(new Error(`${name} smoke failed to start`));
                    return;
                }
                if (process.platform === 'win32') {
                    execFile(
                        'taskkill.exe',
                        ['/PID', String(child.pid), '/T', '/F'],
                        { windowsHide: true },
                        (error) => {
                            if (error) {
                                child.kill();
                            }
                        },
                    );
                } else {
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                    } catch {
                        child.kill('SIGKILL');
                    }
                }
            }, timeoutMs);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once('close', (code, signal) => {
                clearTimeout(timer);
                if (timedOut) {
                    reject(new Error(`${name} smoke timed out; test process did not finish`));
                } else if (code !== 0) {
                    reject(new Error(`${name} smoke failed (${code ?? signal})`));
                } else {
                    resolve();
                }
            });
        });
    } finally {
        try {
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
            console.warn(
                `Temporary smoke profile could not be cleaned after exit: ${(error as Error).message}`,
            );
        }
    }
}
