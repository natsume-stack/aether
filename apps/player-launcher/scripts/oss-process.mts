import { spawn } from 'node:child_process';

export interface OssProcessOptions {
    command:string;
    args:string[];
    env?:NodeJS.ProcessEnv;
    description:string;
    timeoutMs:number;
    progress?:boolean;
    log?:(message:string) => void;
}

export class OssProcessError extends Error {
    public stderr:string;

    public constructor(message:string, stderr:string) {
        super(message);
        this.stderr = stderr;
    }
}

/** Stream transfer status while retaining JSON output for HEAD calls. No AWS debug headers are logged. */
export async function runOssProcess({
    command,
    args,
    env,
    description,
    timeoutMs,
    progress = false,
    log = console.log,
}:OssProcessOptions):Promise<{ stdout:string; stderr:string }> {
    if (progress) {
        log(`Starting ${description}`);
    }
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
            stderr = '',
            progressBuffer = '',
            lastProgress = '',
            lastReport = 0;
        let timedOut = false;
        let excessiveOutput = false;
        const started = Date.now();
        const notify = () =>
            log(
                `${description}: ${Math.round((Date.now() - started) / 1000)}s elapsed${lastProgress ? `; ${lastProgress}` : '; waiting for transfer response'}`,
            );
        const heartbeat = progress ? setInterval(notify, 15_000) : undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);
        const clear = () => {
            clearTimeout(timer);
            if (heartbeat) {
                clearInterval(heartbeat);
            }
        };
        const collect = (chunk:Buffer, stream:'stdout' | 'stderr') => {
            const text = chunk.toString('utf8');
            if (stream === 'stdout') {
                stdout += text;
            } else {
                stderr += text;
            }
            if (stdout.length + stderr.length > 4 * 1024 * 1024) {
                excessiveOutput = true;
                child.kill('SIGTERM');
                return;
            }
            if (progress) {
                progressBuffer = (progressBuffer + text).slice(-4096);
                const matches = progressBuffer.match(/Completed [^\r\n]+/g);
                if (matches?.length) {
                    // Only byte/rate progress is surfaced; raw paths, URLs and request headers are not.
                    lastProgress = matches[matches.length - 1].replace(/\x1b\[[0-9;]*m/g, '');
                    if (Date.now() - lastReport >= 10_000) {
                        lastReport = Date.now();
                        notify();
                    }
                }
            }
        };
        child.stdout.on('data', (chunk:Buffer) => collect(chunk, 'stdout'));
        child.stderr.on('data', (chunk:Buffer) => collect(chunk, 'stderr'));
        child.once('error', (error) => {
            clear();
            reject(new OssProcessError(error.message, stderr));
        });
        child.once('close', (code, signal) => {
            clear();
            if (timedOut) {
                reject(new OssProcessError(`${description} exceeded ${timeoutMs / 1000}s`, stderr));
            } else if (excessiveOutput) {
                reject(
                    new OssProcessError(`${description} output exceeded the safety limit`, stderr),
                );
            } else if (code !== 0) {
                reject(new OssProcessError(`${description} failed (${code ?? signal})`, stderr));
            } else {
                if (progress) {
                    log(
                        `Completed ${description} in ${Math.round((Date.now() - started) / 1000)}s`,
                    );
                }
                resolve({ stdout, stderr });
            }
        });
    });
}
