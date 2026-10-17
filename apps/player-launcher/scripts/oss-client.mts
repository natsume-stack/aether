import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runOssProcess } from './oss-process.mts';
export interface OssConfig {
    bucket:string;
    endpoint:string;
    accessKeyId:string;
    accessKeySecret:string;
}
export interface OssObjectHead {
    ContentLength:number;
    Metadata?:Record<string, string>;
}

export function ossConfiguration(env:NodeJS.ProcessEnv):OssConfig {
    for (const name of [
        'OSS_BUCKET',
        'OSS_ENDPOINT',
        'OSS_ACCESS_KEY_ID',
        'OSS_ACCESS_KEY_SECRET',
    ]) {
        if (!env[name]) {
            throw new Error(`Missing required GitHub Actions OSS configuration: ${name}`);
        }
    }
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.OSS_BUCKET!)) {
        throw new Error('ALIYUN_OSS_BUCKET must contain only the bucket name');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(env.OSS_ENDPOINT!)) {
        throw new Error(
            'ALIYUN_OSS_ENDPOINT must be an OSS endpoint hostname without a protocol or path',
        );
    }
    return {
        bucket: env.OSS_BUCKET!,
        endpoint: env.OSS_ENDPOINT!,
        accessKeyId: env.OSS_ACCESS_KEY_ID!,
        accessKeySecret: env.OSS_ACCESS_KEY_SECRET!,
    };
}

export function isMissingObject(error:string):boolean {
    return /\((?:404|NoSuchKey|NotFound|NoSuchObject)\)/.test(error);
}

/** Uses the same OSS S3 compatibility as release.yml's Windows transfer steps. */
export async function createOssClient(
    config:OssConfig,
    execute = runOssProcess,
    keyPrefix = 'box-player-launcher/player-v',
) {
    if (
        !(
            keyPrefix.startsWith('box-player-launcher/player-v') ||
            /^box-player-launcher-staging\/player-v[0-9A-Za-z.-]+staging\/[a-f0-9]{40}\/$/.test(
                keyPrefix,
            )
        ) ||
        keyPrefix.includes('..') ||
        keyPrefix.includes('\\')
    ) {
        throw new Error('Invalid player OSS scope');
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'box-player-oss-'));
    const configFile = path.join(directory, 'aws-config');
    await writeFile(
        configFile,
        '[default]\nregion = us-east-1\ns3 =\n    addressing_style = virtual\n    payload_signing_enabled = false\n    multipart_threshold = 16MB\n    multipart_chunksize = 16MB\n    max_concurrent_requests = 4\n',
        { mode: 0o600 },
    );
    const env = {
        ...process.env,
        AWS_CONFIG_FILE: configFile,
        AWS_ACCESS_KEY_ID: config.accessKeyId,
        AWS_SECRET_ACCESS_KEY: config.accessKeySecret,
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
        AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
        AWS_RETRY_MODE: 'standard',
        AWS_MAX_ATTEMPTS: '8',
        PYTHONUTF8: '1',
    };
    async function call(
        operation:'head' | 'upload' | 'download',
        key:string,
        extra:string[] = [],
        allowMissing = false,
    ):Promise<string | null> {
        if (!key.startsWith(keyPrefix) || key.includes('..') || key.includes('\\')) {
            throw new Error('OSS key must stay in the player release directory');
        }
        try {
            const transfer = operation !== 'head';
            const uri = `s3://${config.bucket}/${key}`;
            const command =
                operation === 'head'
                    ? [
                          's3api',
                          'head-object',
                          '--bucket',
                          config.bucket,
                          '--key',
                          key,
                          '--output',
                          'json',
                      ]
                    : operation === 'upload'
                      ? ['s3', 'cp', extra[0], uri, ...extra.slice(1)]
                      : ['s3', 'cp', uri, extra[0]];
            const { stdout } = await execute({
                command: 'python',
                args: [
                    '-m',
                    'awscli',
                    ...command,
                    '--endpoint-url',
                    `https://${config.endpoint}`,
                    '--cli-connect-timeout',
                    '30',
                    '--cli-read-timeout',
                    '120',
                ],
                // A slow but progressing multipart transfer must not be cut off at an arbitrary 10-minute mark.
                env,
                timeoutMs: transfer ? 1_800_000 : 90_000,
                description: `OSS ${operation} ${path.posix.basename(key)}`,
                progress: transfer,
            });
            return stdout;
        } catch (error) {
            const failure = error as Error & { stderr?:string };
            const stderr = [failure.message, failure.stderr].filter(Boolean).join('\n');
            if (allowMissing && isMissingObject(stderr)) {
                return null;
            }
            const redacted = stderr
                .split(config.accessKeyId)
                .join('[redacted]')
                .split(config.accessKeySecret)
                .join('[redacted]');
            throw new Error(`OSS ${operation} failed for ${key}: ${redacted.trim()}`);
        }
    }
    return {
        directory,
        async head(key:string):Promise<OssObjectHead | null> {
            const result = await call('head', key, [], true);
            return result === null ? null : JSON.parse(result);
        },
        async download(key:string, file:string):Promise<void> {
            await call('download', key, [file]);
        },
        async upload(
            key:string,
            file:string,
            contentType = 'application/octet-stream',
            metadata:Record<string, string> = {},
        ):Promise<void> {
            await call('upload', key, [
                file,
                '--content-type',
                contentType,
                '--metadata',
                JSON.stringify(metadata),
            ]);
        },
        async close():Promise<void> {
            await rm(directory, { recursive: true, force: true });
        },
    };
}
