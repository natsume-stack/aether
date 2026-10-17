/**
 * 按 BOX3-IMAGE-CATALOG.json 给已 load 进来的镜像补打 compose 引用的版本 tag。
 *
 * 官方逐服务归档（`box-local-engine-image-<service>-<arch>-<sha>.tar.gz`）在构建期剥掉了 RepoTags，
 * `docker image load` 后只剩 `box-local-engine-<service>:launcher-content-<imageId>`；compose 要的却是
 * `:v<版本>-linux-<架构>`，缺 tag 时 Docker 会去 docker.io 拉一个不存在的镜像并超时——内网离线部署
 * 第一个踩的坑。`distribution/server/install.sh` 只给 server-manager 补了这一步，其余五个服务靠本脚本。
 *
 * 只读 + 追加：不删镜像、不动容器、不改已有 tag 的指向。纯 Node，只依赖 docker CLI，断网机可直跑。
 *
 * 用法：
 *   node scripts/tag-images-from-catalog.mjs --catalog <BOX3-IMAGE-CATALOG.json> [--dry-run|--json]
 *
 * 退出码：0 全部一致 / 1 存在缺失或冲突 / 2 用法或环境错误
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_USAGE = 2;

const ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    if (result.error) {
        return { ok: false, detail: result.error.message, stdout: '', stderr: '' };
    }
    return {
        ok: result.status === 0,
        detail: (result.stderr || result.stdout || '').trim(),
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
    };
}

function fail(message, code = EXIT_USAGE) {
    process.stderr.write(`[tag-images] ${message}\n`);
    process.exit(code);
}

function inspect(reference) {
    const result = docker(['image', 'inspect', '--format', '{{.Id}}\t{{.Os}}/{{.Architecture}}', reference]);
    if (!result.ok) {
        return null;
    }
    const [id, platform] = result.stdout.split('\t');
    return { id, platform };
}

function contentTags(image) {
    // The archives tag by content digest. Both the canonical imageId and the
    // extra ids recorded in imageIds (OCI manifest digest) can appear, so try
    // every one of them in catalog order.
    const ids = [image.imageId, ...(image.imageIds || [])].filter((id) => ID_PATTERN.test(id || ''));
    const unique = [...new Set(ids)];
    return unique.map((id) => `${image.image}:launcher-content-${id.slice('sha256:'.length)}`);
}

function readCatalog(file) {
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`无法读取 catalog：${error.message}`);
    }
    if (!catalog || !Array.isArray(catalog.images) || catalog.images.length === 0) {
        fail('catalog 缺少 images 数组');
    }
    return catalog;
}

export function planCatalogTags(catalog) {
    return catalog.images.map((image) => {
        const tag = image.imageTag || catalog.imageTag;
        const ids = [image.imageId, ...(image.imageIds || [])].filter((id) => ID_PATTERN.test(id || ''));
        return {
            image: image.image,
            tag,
            target: `${image.image}:${tag}`,
            platform: image.platform || catalog.platform,
            ids,
            sources: contentTags(image),
        };
    });
}

function classify(plan) {
    const current = inspect(plan.target);
    if (current) {
        if (!plan.ids.includes(current.id)) {
            return {
                action: 'conflict',
                detail: `${plan.target} 已指向 ${current.id}，与 catalog 的 imageIds 不一致；不覆盖`,
                inspect: current,
            };
        }
        if (plan.platform && current.platform !== plan.platform) {
            return {
                action: 'conflict',
                detail: `${plan.target} 平台为 ${current.platform}，catalog 要求 ${plan.platform}`,
                inspect: current,
            };
        }
        return { action: 'skip', detail: '版本 tag 已存在且内容一致', inspect: current };
    }
    for (const source of plan.sources) {
        const found = inspect(source);
        if (!found) {
            continue;
        }
        if (!plan.ids.includes(found.id)) {
            return { action: 'conflict', detail: `${source} 的内容 ${found.id} 不属于 catalog imageIds` };
        }
        if (plan.platform && found.platform !== plan.platform) {
            return {
                action: 'conflict',
                detail: `${source} 平台为 ${found.platform}，catalog 要求 ${plan.platform}`,
            };
        }
        return { action: 'tag', source, detail: `来自 ${source}`, inspect: found };
    }
    // Last resort: tag straight from the content id, which survives `docker
    // image load` even when the RepoTags were stripped twice by a mirror.
    for (const id of plan.ids) {
        const found = inspect(id);
        if (found && plan.ids.includes(found.id) && (!plan.platform || found.platform === plan.platform)) {
            return { action: 'tag', source: id, detail: `来自内容摘要 ${id}`, inspect: found };
        }
    }
    return {
        action: 'missing',
        detail: `未找到 ${plan.image} 的任何已导入归档；请先 docker image load 全部归档`,
    };
}

function parseArguments(argv) {
    const options = { catalog: '', dryRun: false, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--catalog') {
            options.catalog = argv[(index += 1)] || '';
        } else if (argument === '--dry-run') {
            options.dryRun = true;
        } else if (argument === '--json') {
            options.json = true;
        } else if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else {
            fail(`未知参数：${argument}`);
        }
    }
    if (!options.catalog) {
        fail('必须提供 --catalog <BOX3-IMAGE-CATALOG.json>');
    }
    return options;
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(
            '用法：node scripts/tag-images-from-catalog.mjs --catalog <BOX3-IMAGE-CATALOG.json> [--dry-run] [--json]\n',
        );
        return EXIT_OK;
    }
    const catalogFile = path.resolve(options.catalog);
    const catalog = readCatalog(catalogFile);
    if (!docker(['info', '--format', '{{.ServerVersion}}']).ok) {
        fail('无法访问 Docker Engine，请先确认 docker 服务与当前用户的 docker 组权限');
    }
    const plans = planCatalogTags(catalog);
    for (const plan of plans) {
        if (!TAG_PATTERN.test(plan.tag || '')) {
            fail(`catalog 中的镜像标签无效：${plan.image} -> ${plan.tag}`);
        }
    }
    const rows = plans.map((plan) => ({
        image: plan.image,
        target: plan.target,
        ids: plan.ids,
        ...classify(plan),
    }));
    let created = 0;
    if (!options.dryRun) {
        for (const row of rows) {
            if (row.action !== 'tag') {
                continue;
            }
            const tagged = docker(['tag', row.source, row.target]);
            if (!tagged.ok) {
                row.action = 'conflict';
                row.detail = `docker tag 失败：${tagged.detail}`;
                continue;
            }
            const verified = inspect(row.target);
            if (!verified || !row.ids.includes(verified.id)) {
                row.action = 'conflict';
                row.detail = `补 tag 后校验失败：${JSON.stringify(verified)}`;
                continue;
            }
            created += 1;
        }
    }
    const counts = rows.reduce((accumulator, row) => {
        accumulator[row.action] = (accumulator[row.action] || 0) + 1;
        return accumulator;
    }, {});
    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    catalog: catalogFile,
                    imageTag: catalog.imageTag,
                    platform: catalog.platform,
                    dryRun: options.dryRun,
                    created,
                    counts,
                    rows: rows.map(({ image, target, action, detail, source, inspect: found }) => ({
                        image,
                        target,
                        action,
                        detail,
                        source: source || null,
                        id: found ? found.id : null,
                        platform: found ? found.platform : null,
                    })),
                },
                null,
                2,
            )}\n`,
        );
    } else {
        process.stdout.write(
            `[tag-images] catalog=${path.basename(catalogFile)} tag=${catalog.imageTag} ` +
                `platform=${catalog.platform}${options.dryRun ? ' (dry-run)' : ''}\n`,
        );
        for (const row of rows) {
            const label = { skip: '已存在', tag: options.dryRun ? '待补' : '已补', conflict: '冲突', missing: '缺失' }[
                row.action
            ];
            const id = row.inspect ? row.inspect.id.slice(0, 19) : '-';
            process.stdout.write(`  ${label.padEnd(4)} ${row.target}  ${id}  ${row.detail}\n`);
        }
    }
    const bad = (counts.conflict || 0) + (counts.missing || 0);
    if (bad > 0) {
        process.stderr.write(`[tag-images] ${bad} 个镜像未能与 catalog 对齐\n`);
        return EXIT_MISMATCH;
    }
    process.stderr.write(`[tag-images] 全部 ${rows.length} 个镜像与 catalog 一致，新建 tag ${created} 个\n`);
    return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    process.exitCode = main();
}
