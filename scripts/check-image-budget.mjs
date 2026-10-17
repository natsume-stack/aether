/**
 * BOX3 镜像体积回归门：两道子门、一个入口，纯 Node 实现（无第三方依赖，离线机可直接 `node` 跑）。
 * 存在理由：v0.3.0 → v2026.1.4 六个镜像的 content 全部变大，而 CI 里只有 `size > 0` 这一种断言
 * （`scripts/verify-headless-server-package.js:33`）。
 *
 *   size      —— 按 `common/config/box3-image-budget.json` 逐服务比 contentBytes/archiveBytes，
 *                超预算 exit 1；`--tier ratchet` 用 `basis.observed` 原值做"只准减不准加"的棘轮。
 *   blacklist —— 按 `common/config/box3-image-blacklist.json` 扫已解包的镜像树（`--tree`/`--trees-dir`），
 *                命中 @swc/core、typescript、esbuild、sass、@babel、sql.js 调试变体、字体双拷贝即 exit 1。
 *
 * 输入缺失必须显式失败：没有任何输入源 exit 3；配置缺失或字段非法 exit 2；
 * 被 `--require` 声明为必须的子门没有跑 exit 1。
 *
 * 用法：
 *   node scripts/check-image-budget.mjs --catalog <BOX3-IMAGE-CATALOG.json> --tier ratchet --require size
 *   node scripts/check-image-budget.mjs --docker --catalog <BOX3-IMAGE-CATALOG.json>   # 需本机 docker inspect
 *   node scripts/check-image-budget.mjs --images-dir <dir>          # 直接量 tar.gz 目录
 *   node scripts/check-image-budget.mjs --measurements <file.json>  # 吃外部测得的字节
 *   node scripts/check-image-budget.mjs --tree <extracted-app-dir> --service play
 *   node scripts/check-image-budget.mjs --trees-dir <dir> --require size,blacklist
 *   node scripts/check-image-budget.mjs --self-test                 # 造 +1 MiB 垃圾，必须变红
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    EXIT_NO_DATA,
    EXIT_USAGE,
    EXIT_VIOLATION,
    formatBytes,
    formatDelta,
    formatInt,
    globToRegExp,
    parseArgs,
    parseList,
    readJsonFile,
    requireObject,
    requireSafeInteger,
    requireString,
    renderTable,
    runCommand,
    subtreeBytes,
    walkTree,
    warning,
    writeJsonReport,
} from './lib/budget.mjs';

const REPOSITORY_PREFIX = 'box-local-engine-';
const METRICS = ['contentBytes', 'archiveBytes'];
const REPO_ROOT = path.join(import.meta.dirname, '..');
const DEFAULT_CONFIG = path.join(REPO_ROOT, 'common', 'config', 'box3-image-budget.json');
const DEFAULT_BLACKLIST = path.join(REPO_ROOT, 'common', 'config', 'box3-image-blacklist.json');
const SIZE_INPUTS = ['docker', 'catalog', 'images-dir', 'measurements'];
const TREE_INPUTS = ['tree', 'trees-dir'];

/** 校验并归一化预算文件。 */
export function loadBudget(file) {
    const raw = requireObject(readJsonFile(file), `预算配置 ${file}`);
    if (raw.schema !== 'box3.image-budget.v1') {
        throw new Error(`${file}: schema 应为 box3.image-budget.v1，收到 ${String(raw.schema)}`);
    }
    const tiers = Object.keys(requireObject(raw.tiers, `${file}: tiers`));
    if (!tiers.includes('transition')) {
        throw new Error(`${file}: 缺少 transition 档`);
    }
    const services = requireObject(raw.services, `${file}: services`);
    const names = Object.keys(services);
    if (names.length === 0) {
        throw new Error(`${file}: services 为空`);
    }
    for (const name of names) {
        const entry = requireObject(services[name], `${file}: services.${name}`);
        const declared = Object.keys(entry).filter((metric) => METRICS.includes(metric));
        if (declared.length === 0) {
            throw new Error(`${file}: services.${name} 没有任何 ${METRICS.join('/')} 预算`);
        }
        for (const metric of declared) {
            const limits = requireObject(entry[metric], `${file}: ${name}.${metric}`);
            for (const tier of tiers) {
                if (limits[tier] !== null && limits[tier] !== undefined) {
                    requireSafeInteger(limits[tier], `${file}: ${name}.${metric}.${tier}`);
                }
            }
        }
    }
    const aggregate = raw.aggregate ? requireObject(raw.aggregate, `${file}: aggregate`) : null;
    return {
        file,
        tiers,
        defaultTier: typeof raw.defaultTier === 'string' ? raw.defaultTier : 'transition',
        services,
        aggregate,
        basis: raw.basis ? requireObject(raw.basis, `${file}: basis`) : null,
        growthToleranceBytes: requireSafeInteger(
            Number.isSafeInteger(raw.growthToleranceBytes) ? raw.growthToleranceBytes : 0,
            `${file}: growthToleranceBytes`,
        ),
    };
}

/** 从 BOX3-IMAGE-CATALOG.json 取 archiveBytes（tar.gz 真实字节）。 */
function catalogFile(options) {
    if (typeof options.catalog === 'string') {
        return options.catalog;
    }
    if (typeof options['images-dir'] === 'string') {
        return path.join(options['images-dir'], 'BOX3-IMAGE-CATALOG.json');
    }
    if (process.env.BOX3_IMAGE_CATALOG) {
        return process.env.BOX3_IMAGE_CATALOG;
    }
    if (process.env.BOX3_IMAGE_DIR) {
        return path.join(process.env.BOX3_IMAGE_DIR, 'BOX3-IMAGE-CATALOG.json');
    }
    return null;
}

function serviceOf(imageName) {
    return String(imageName || '').startsWith(REPOSITORY_PREFIX)
        ? String(imageName).slice(REPOSITORY_PREFIX.length)
        : String(imageName);
}

function collectFromCatalog(options, target, notes) {
    const file = catalogFile(options);
    if (!file) {
        return;
    }
    if (!fs.existsSync(file)) {
        notes.push(`UNAVAILABLE catalog: ${file} 不存在`);
        return;
    }
    const catalog = requireObject(readJsonFile(file), `catalog ${file}`);
    if (!Array.isArray(catalog.images)) {
        throw new Error(`${file}: images 必须是数组`);
    }
    const directory =
        typeof options['images-dir'] === 'string'
            ? options['images-dir']
            : path.dirname(path.resolve(file));
    notes.push(`catalog: ${file}（imageTag=${String(catalog.imageTag || 'unknown')}）`);
    for (const image of catalog.images) {
        const service = serviceOf(image.image);
        if (!target.services[service]) {
            // 上游“只会加不会减”：新增一个镜像如果没人改预算表就被忽略，体积门
            // 等于给新镜像开了免检通道。这里按违规处理，除非显式 --allow-unknown-services。
            target.unknown.push({ service, image: image.image, size: image.size });
            notes.push(`UNDECLARED image: ${image.image} 未在预算表声明`);
            continue;
        }
        requireSafeInteger(image.size, `catalog ${service}.size`);
        const entry = target.entryFor(service, `catalog:${image.image}`);
        entry.archiveBytes = image.size;
        entry.imageTag = typeof image.imageTag === 'string' ? image.imageTag : entry.imageTag;
        entry.sha256 = typeof image.sha256 === 'string' ? image.sha256 : entry.sha256;
        // 归档真实性：catalog 声明的 size 必须等于磁盘上的 tar.gz 大小。
        const archivePath = path.join(directory, String(image.archive || ''));
        if (image.archive && fs.existsSync(archivePath)) {
            const onDisk = fs.statSync(archivePath).size;
            entry.archives.push({ file: archivePath, declared: image.size, onDisk });
            if (onDisk !== image.size) {
                const delta = onDisk - image.size;
                entry.violations.push(
                    `${service}: ${path.basename(archivePath)} 磁盘 ${formatInt(onDisk)} B` +
                        ` != catalog.size ${formatInt(image.size)} B（差 ${formatInt(delta)} B）`,
                );
            }
        }
    }
    target.catalogTag = typeof catalog.imageTag === 'string' ? catalog.imageTag : target.catalogTag;
}

function collectFromDocker(options, target, notes) {
    if (!options.docker) {
        return;
    }
    const bin = typeof options['docker-bin'] === 'string'
        ? options['docker-bin']
        : process.env.DOCKER_BIN || 'docker';
    const tag =
        typeof options['image-tag'] === 'string'
            ? options['image-tag']
            : process.env.BOX3_IMAGE_TAG || target.catalogTag;
    if (!tag) {
        notes.push('UNAVAILABLE docker: 既没有 --image-tag 也没有 BOX3_IMAGE_TAG，且 catalog 缺失');
        return;
    }
    const probe = runCommand(bin, ['version', '-f', '{{.Server.Version}}']);
    if (!probe.ok) {
        notes.push(`UNAVAILABLE docker: ${probe.reason || probe.stderr || 'docker 不可用'}`);
        return;
    }
    notes.push(`docker: server ${probe.stdout.trim()}，tag ${tag}`);
    for (const service of target.requested) {
        const reference = `${REPOSITORY_PREFIX}${service}:${tag}`;
        const result = runCommand(bin, ['image', 'inspect', '-f', '{{.Size}}', reference]);
        const entry = target.entryFor(service, reference);
        if (!result.ok) {
            entry.unavailable = `镜像未 load：${reference}`;
            notes.push(`UNAVAILABLE image: ${reference}`);
            continue;
        }
        const size = Number.parseInt(result.stdout.trim(), 10);
        if (!Number.isSafeInteger(size) || size <= 0) {
            throw new Error(`docker image inspect 返回不可解析的 Size：${reference} -> ${result.stdout}`);
        }
        entry.contentBytes = size;
        entry.unavailable = null;
    }
}

function collectFromMeasurements(options, target, notes) {
    const file = options.measurements;
    if (typeof file !== 'string') {
        return;
    }
    const payload = requireObject(readJsonFile(file), `measurements ${file}`);
    if (!Array.isArray(payload.images)) {
        throw new Error(`${file}: images 必须是数组`);
    }
    notes.push(`measurements: ${file}（source=${String(payload.source || 'unknown')}）`);
    for (const image of payload.images) {
        const service = serviceOf(image.image || image.service);
        if (!target.services[service]) {
            target.unknown.push({ service, image: image.image || service, size: undefined });
            notes.push(`UNDECLARED measurement: ${service} 未在预算表声明`);
            continue;
        }
        const metrics = requireObject(image.metrics || {}, `${file}: ${service}.metrics`);
        const entry = target.entryFor(service, image.ref || `measurements:${service}`);
        for (const metric of METRICS) {
            if (metrics[metric] !== undefined && metrics[metric] !== null) {
                entry[metric] = requireSafeInteger(metrics[metric], `${file}: ${service}.${metric}`);
            }
        }
        entry.estimated = Boolean(image.estimated);
        entry.basis = typeof image.basis === 'string' ? image.basis : entry.basis;
    }
}

/**
 * 校验并归一化黑名单文件。字段非法一律抛错，绝不静默跳过：
 * 一张没人消费的表等于没有表。
 */
export function loadBlacklist(file) {
    const raw = requireObject(readJsonFile(file), `黑名单配置 ${file}`);
    if (raw.schema !== 'box3.image-blacklist.v1') {
        throw new Error(`${file}: schema 应为 box3.image-blacklist.v1，收到 ${String(raw.schema)}`);
    }
    const rules = raw.rules;
    if (!Array.isArray(rules) || rules.length === 0) {
        throw new Error(`${file}: rules 必须是非空数组`);
    }
    const services = Array.isArray(raw.services) ? raw.services.map(String) : [];
    const seen = new Set();
    for (const [index, rule] of rules.entries()) {
        const label = `${file}: rules[${index}]`;
        requireObject(rule, label);
        const id = requireString(rule.id, `${label}.id`);
        if (seen.has(id)) {
            throw new Error(`${file}: 规则 id 重复：${id}`);
        }
        seen.add(id);
        requireString(rule.label, `${label}.${id}.label`);
        const glob = requireString(rule.glob, `${label}.${id}.glob`);
        if (!glob.startsWith('**/')) {
            throw new Error(`${label}.${id}.glob 必须以 **/ 开头，否则无法匹配任意深度的镜像树：${glob}`);
        }
        if (rule.maxEntries !== null && rule.maxEntries !== undefined) {
            requireSafeInteger(rule.maxEntries, `${label}.${id}.maxEntries`);
        }
        if (rule.byService) {
            const byService = requireObject(rule.byService, `${label}.${id}.byService`);
            for (const [service, override] of Object.entries(byService)) {
                const entry = requireObject(override, `${label}.${id}.byService.${service}`);
                if (entry.maxEntries !== null && entry.maxEntries !== undefined) {
                    requireSafeInteger(entry.maxEntries, `${label}.${id}.byService.${service}.maxEntries`);
                }
            }
        }
    }
    return { file, root: typeof raw.root === 'string' ? raw.root : '/', services, rules };
}

/** 某条规则在当前服务下生效的条目上限；null = 只报告不设限。 */
function ruleLimit(rule, service) {
    const override = rule.byService && service ? rule.byService[service] : undefined;
    if (override && Object.prototype.hasOwnProperty.call(override, 'maxEntries')) {
        return override.maxEntries === undefined ? null : override.maxEntries;
    }
    return rule.maxEntries === undefined ? 0 : rule.maxEntries;
}

/**
 * 返回相对路径里最短的、能够整条匹配 glob 的前缀（即“命中单元”）。
 * 目录命中时整个目录算一个单元，里面的文件不再重复计数。
 */
function shortestMatchUnit(compiled, relative) {
    const parts = relative.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
        const candidate = parts.slice(0, depth).join('/');
        if (compiled.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

/** 扫描一棵已解包的镜像目录树，逐规则给出命中数与命中字节。 */
export function scanBlacklistTree(blacklist, root, service) {
    const findings = [];
    for (const rule of blacklist.rules) {
        const compiled = globToRegExp(rule.glob);
        const units = new Set();
        walkTree(root, (entry) => {
            for (const unit of units) {
                if (entry.relative === unit || entry.relative.startsWith(`${unit}/`)) {
                    return;
                }
            }
            const unit = shortestMatchUnit(compiled, entry.relative);
            if (unit !== null) {
                units.add(unit);
            }
        });
        let bytes = 0;
        for (const unit of units) {
            bytes += subtreeBytes(path.join(root, unit));
        }
        findings.push({
            id: rule.id,
            label: rule.label,
            service: service || null,
            limit: ruleLimit(rule, service),
            count: units.size,
            bytes,
            samples: [...units].slice(0, 3),
        });
    }
    return findings;
}

function blacklistViolations(findings, treeLabel) {
    const violations = [];
    for (const finding of findings) {
        if (finding.limit === null || finding.count <= finding.limit) {
            continue;
        }
        violations.push(
            `${treeLabel} 黑名单 ${finding.id}（${finding.label}）命中 ` +
                `${finding.count} 项，上限 ${finding.limit}，合计 ${formatInt(finding.bytes)} B：` +
                finding.samples.join(' / '),
        );
    }
    return violations;
}

function blacklistRows(findings) {
    return findings.map((finding) => [
        finding.service || '-',
        finding.id,
        formatInt(finding.count),
        finding.limit === null ? '只报告' : formatInt(finding.limit),
        formatBytes(finding.bytes),
        formatInt(finding.bytes),
        finding.limit !== null && finding.count > finding.limit ? 'BLACKLIST' : 'OK',
    ]);
}

/**
 * 黑名单子门：吃 `--tree`（单棵树，可用 --service 标注）或 `--trees-dir`
 * （每个一级子目录是一个服务树）。没有输入源时 skipped，由 run() 决定是
 * 警告还是按 --require 失败。
 */
export function runBlacklist(options, notes) {
    const file = typeof options.blacklist === 'string' ? options.blacklist : DEFAULT_BLACKLIST;
    const blacklist = loadBlacklist(
        path.isAbsolute(file) ? file : path.resolve(file),
    );
    const trees = [];
    if (typeof options.tree === 'string') {
        const service = typeof options.service === 'string' ? options.service : null;
        if (service && blacklist.services.length > 0 && !blacklist.services.includes(service)) {
            throw new Error(
                `${blacklist.file}: 未知服务 ${service}，黑名单声明了 ${blacklist.services.join(', ')}`,
            );
        }
        trees.push({ root: path.resolve(options.tree), service });
    }
    if (typeof options['trees-dir'] === 'string') {
        const base = path.resolve(options['trees-dir']);
        if (!fs.existsSync(base)) {
            throw new Error(`缺少目录：${base}（--trees-dir 必须是已解包的镜像树目录）`);
        }
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const known =
                blacklist.services.length === 0 || blacklist.services.includes(entry.name);
            trees.push({
                root: path.join(base, entry.name),
                service: known ? entry.name : null,
            });
        }
    }
    if (trees.length === 0) {
        notes.push('UNAVAILABLE blacklist: 没有 --tree / --trees-dir，黑名单子门未运行');
        return { skipped: true, rows: [], violations: [], findings: [], trees: [] };
    }
    const rows = [];
    const violations = [];
    const findings = [];
    for (const tree of trees) {
        if (!fs.existsSync(tree.root) || !fs.statSync(tree.root).isDirectory()) {
            violations.push(`黑名单树目录不存在：${tree.root}`);
            continue;
        }
        const treeFindings = scanBlacklistTree(blacklist, tree.root, tree.service);
        const label = tree.service ? `${tree.service} (${tree.root})` : tree.root;
        notes.push(`blacklist: ${label}，规则 ${blacklist.rules.length} 条`);
        findings.push(...treeFindings.map((finding) => ({ ...finding, tree: tree.root })));
        rows.push(...blacklistRows(treeFindings));
        violations.push(...blacklistViolations(treeFindings, label));
    }
    return { skipped: false, rows, violations, findings, trees, config: blacklist.file };
}

/** 累积测量值并逐服务比较。 */
class Target {
    constructor(budget, services) {
        this.budget = budget;
        this.services = budget.services;
        this.requested = services;
        this.entries = new Map();
        this.unknown = [];
        this.catalogTag = null;
    }

    entryFor(service, ref) {
        if (!this.entries.has(service)) {
            this.entries.set(service, {
                service,
                ref,
                contentBytes: null,
                archiveBytes: null,
                archives: [],
                violations: [],
                unavailable: null,
                estimated: false,
                basis: null,
            });
        }
        return this.entries.get(service);
    }
}

function evaluate(target, tier) {
    const rows = [];
    const violations = [];
    const totals = {};
    for (const service of target.requested) {
        const entry = target.entries.get(service);
        const budgets = target.budget.services[service];
        for (const metric of METRICS) {
            if (budgets[metric] === undefined) {
                continue;
            }
            totals[metric] = (totals[metric] || 0) + (entry && entry[metric] ? entry[metric] : 0);
            const budget = budgets[metric][tier];
            const actual = entry ? entry[metric] : null;
            if (actual === null || actual === undefined) {
                rows.push([
                    service,
                    metric,
                    'n/a',
                    'n/a',
                    formatBytes(budget),
                    formatInt(budget),
                    entry && entry.unavailable ? entry.unavailable : '未测量',
                    'SKIP',
                ]);
                continue;
            }
            let status = 'OK';
            if (Number.isSafeInteger(budget) && actual > budget) {
                status = 'OVER';
                violations.push(
                    `${service} ${metric} ${formatInt(actual)} B 超过 ${tier} 预算 ` +
                        `${formatInt(budget)} B（超 ${formatInt(actual - budget)} B，` +
                        `${formatDelta(actual, budget)}）`,
                );
            }
            const observed = target.budget.basis && target.budget.basis.observed;
            const base = observed && observed[service] && observed[service][metric];
            if (
                Number.isSafeInteger(base) &&
                actual > base + target.budget.growthToleranceBytes
            ) {
                status = status === 'OVER' ? status : 'GROWTH';
                if (status === 'GROWTH') {
                    violations.push(
                        `${service} ${metric} 相比 ${String(target.budget.basis.release || 'basis')} 基线 ` +
                            `${formatInt(base)} B 增长到 ${formatInt(actual)} B（+${formatInt(actual - base)} B），` +
                            '体积只准减不准加',
                    );
                }
            }
            if (budget === undefined) {
                status = 'NO-BUDGET';
                violations.push(
                    `${service} ${metric} 在 ${tier} 档没有声明上限：测到 ${formatInt(actual)} B ` +
                        '却没有预算可比，门无法判定，按违规处理（显式写 null 才是“只报告”）',
                );
            } else if (budget === null && status === 'OK') {
                status = 'REPORT';
            }
            rows.push([
                service,
                metric,
                formatBytes(actual),
                formatInt(actual),
                Number.isSafeInteger(budget) ? formatBytes(budget) : budget === null ? '只报告' : '缺失',
                Number.isSafeInteger(budget) ? formatInt(budget) : 'n/a',
                Number.isSafeInteger(budget) ? formatDelta(actual, budget) : 'n/a',
                status,
            ]);
        }
        for (const violation of (entry && entry.violations) || []) {
            violations.push(violation);
        }
    }
    if (target.budget.aggregate) {
        // 合计档只在“全部声明服务都被请求”时评估。否则 `--services play` 这种
        // 子集会拿 1 个服务的字节去和 6 个服务的总预算比，永远为绿，是个静默放行口子。
        const declaredNames = Object.keys(target.budget.services);
        const coversAllServices =
            target.requested.length === declaredNames.length &&
            declaredNames.every((service) => target.requested.includes(service));
        if (!coversAllServices) {
            for (const metric of METRICS) {
                const budget = target.budget.aggregate[metric]
                    ? target.budget.aggregate[metric][tier]
                    : undefined;
                if (!Number.isSafeInteger(budget) || totals[metric] === undefined) {
                    continue;
                }
                rows.push([
                    `合计(${target.requested.length}/${declaredNames.length})`,
                    metric,
                    formatBytes(totals[metric]),
                    formatInt(totals[metric]),
                    formatBytes(budget),
                    formatInt(budget),
                    'n/a',
                    'SKIP(子集)',
                ]);
            }
        } else {
            for (const metric of METRICS) {
                const budget = target.budget.aggregate[metric]
                    ? target.budget.aggregate[metric][tier]
                    : undefined;
                if (!Number.isSafeInteger(budget) || totals[metric] === undefined) {
                    continue;
                }
                const actual = totals[metric];
                const measuredAll = target.requested.every((service) => {
                    const entry = target.entries.get(service);
                    return entry && Number.isSafeInteger(entry[metric]);
                });
                if (!measuredAll) {
                    continue;
                }
                rows.push([
                    `合计(${declaredNames.length})`,
                    metric,
                    formatBytes(actual),
                    formatInt(actual),
                    formatBytes(budget),
                    formatInt(budget),
                    formatDelta(actual, budget),
                    actual > budget ? 'OVER' : 'OK',
                ]);
                if (actual > budget) {
                    violations.push(
                        `aggregate ${metric} ${formatInt(actual)} B 超过 ${tier} 预算 ${formatInt(budget)} B（` +
                            `${formatDelta(actual, budget)}）`,
                    );
                }
            }
        }
    }
    return { rows, violations };
}

/**
 * @param {Record<string, string | boolean>} options 解析后的 CLI 参数
 * @returns {{exitCode: number, rows: string[][], violations: string[], notes: string[]}}
 */
export function run(options = {}) {
    const notes = [];
    const required = new Set(parseList(options.require));
    for (const name of required) {
        if (name !== 'size' && name !== 'blacklist') {
            throw new Error(`--require 只接受 size/blacklist，收到 ${name}`);
        }
    }
    const hasSizeInput = SIZE_INPUTS.some(
        (name) => options[name] === true || typeof options[name] === 'string',
    );
    const hasTreeInput = TREE_INPUTS.some((name) => typeof options[name] === 'string');
    if (!hasSizeInput && !hasTreeInput) {
        notes.push(
            '没有任何输入源：需要 --docker / --catalog / --images-dir / --measurements，' +
                '或 --tree / --trees-dir',
        );
        console.error('体积门无法运行：没有任何输入源');
        for (const note of notes) {
            console.error(`  ✗ ${note}`);
        }
        return { exitCode: EXIT_NO_DATA, rows: [], violations: [], notes, report: null };
    }

    const violations = [];
    let sizeRows = [];
    let tier = null;
    let budget = null;
    let requested = [];
    let target = null;

    if (hasSizeInput) {
        const configPath = typeof options.config === 'string' ? options.config : DEFAULT_CONFIG;
        budget = loadBudget(
            path.isAbsolute(configPath) ? configPath : path.resolve(configPath),
        );
        tier = typeof options.tier === 'string' ? options.tier : budget.defaultTier;
        if (!budget.tiers.includes(tier)) {
            throw new Error(`未知档位 ${tier}，可选：${budget.tiers.join(', ')}`);
        }
        const declared = Object.keys(budget.services);
        requested = options.services
            ? parseList(options.services).filter((service) => declared.includes(service))
            : declared;
        if (requested.length === 0) {
            throw new Error(`没有可检查的服务；预算表声明了 ${declared.join(', ')}`);
        }
        target = new Target(budget, requested);
        collectFromCatalog(options, target, notes);
        collectFromDocker(options, target, notes);
        collectFromMeasurements(options, target, notes);
        const evaluated = evaluate(target, tier);
        sizeRows = evaluated.rows;
        violations.push(...evaluated.violations);
        for (const unknown of target.unknown) {
            if (options['allow-unknown-services']) {
                warning(`放行未声明镜像 ${unknown.image}`);
                continue;
            }
            violations.push(
                `产物里出现了预算表未声明的镜像 ${unknown.image}` +
                    `${Number.isSafeInteger(unknown.size) ? `（${formatInt(unknown.size)} B）` : ''}：` +
                    '上游新增/改名镜像必须先加进 box3-image-budget.json，否则体积门对它完全没有约束',
            );
        }
        const uncovered = requested.filter((service) => {
            const entry = target.entries.get(service);
            return !entry || !METRICS.some((metric) => Number.isSafeInteger(entry[metric]));
        });
        if (uncovered.length > 0 && !options['allow-partial']) {
            violations.push(
                `体积子门数据不完整：${uncovered.join(', ')} 一个指标都没测到。` +
                    '镜像漏 load / catalog 漏条目会让门变成绿灯，必须显式失败' +
                    '（确认只测部分服务时才用 --allow-partial）',
            );
        } else if (uncovered.length > 0) {
            warning(`体积子门放行了一部分未测量服务：${uncovered.join(', ')}`);
        }
    } else if (required.has('size')) {
        violations.push('被 --require 声明必须的体积子门没有输入源');
    } else {
        notes.push('UNAVAILABLE size: 没有 --docker/--catalog/--images-dir/--measurements，体积子门未运行');
        warning('体积子门没有输入源，本次只跑了黑名单子门');
    }

    let blacklist = null;
    if (hasTreeInput || required.has('blacklist')) {
        blacklist = runBlacklist(options, notes);
        violations.push(...blacklist.violations);
        if (blacklist.skipped && required.has('blacklist')) {
            violations.push('被 --require 声明必须的黑名单子门没有输入源（--tree/--trees-dir）');
        }
    } else {
        notes.push('UNAVAILABLE blacklist: 没有 --tree / --trees-dir，黑名单子门未运行');
    }

    const measured = target
        ? requested.filter((service) => {
              const entry = target.entries.get(service);
              return entry && METRICS.some((metric) => Number.isSafeInteger(entry[metric]));
          })
        : [];

    console.log(
        `体积门 tier=${tier || 'n/a'}，服务=${requested.join(', ') || 'n/a'}，` +
            `体积子门=${hasSizeInput ? 'RUN' : 'SKIP'}，黑名单子门=${blacklist && !blacklist.skipped ? 'RUN' : 'SKIP'}`,
    );
    for (const note of notes) {
        console.log(`  · ${note}`);
    }
    if (sizeRows.length > 0) {
        console.log(
            renderTable(
                [
                    { title: '服务', align: 'left' },
                    { title: '指标', align: 'left' },
                    { title: '实际', align: 'left' },
                    { title: '实际字节', align: 'right' },
                    { title: '预算', align: 'left' },
                    { title: '预算字节', align: 'right' },
                    { title: '超标%', align: 'right' },
                    { title: '结果', align: 'left' },
                ],
                sizeRows,
            ),
        );
    }
    if (blacklist && blacklist.rows.length > 0) {
        console.log(
            renderTable(
                [
                    { title: '服务', align: 'left' },
                    { title: '规则', align: 'left' },
                    { title: '命中', align: 'right' },
                    { title: '上限', align: 'right' },
                    { title: '命中字节', align: 'left' },
                    { title: '字节', align: 'right' },
                    { title: '结果', align: 'left' },
                ],
                blacklist.rows,
            ),
        );
    }
    if (violations.length > 0) {
        console.error(`\n体积回归：${violations.length} 项违规`);
        for (const violation of violations) {
            console.error(`  ✗ ${violation}`);
        }
    } else {
        console.log('\n体积回归：全部在预算内，且没有黑名单命中。');
    }

    const report = {
        schema: 'box3.image-budget-report.v1',
        gate: 'check-image-budget',
        tier,
        config: budget ? budget.file : null,
        notes,
        violations,
        images: target ? requested.map((service) => target.entries.get(service)) : [],
        blacklist: blacklist ? { config: blacklist.config || null, findings: blacklist.findings } : null,
    };
    writeJsonReport(options.out, report);

    if (violations.length > 0) {
        return { exitCode: EXIT_VIOLATION, rows: [...sizeRows, ...(blacklist ? blacklist.rows : [])], violations, notes, report };
    }
    if (!hasSizeInput || measured.length === 0) {
        if (blacklist && !blacklist.skipped) {
            return { exitCode: 0, rows: blacklist.rows, violations, notes, report };
        }
        notes.push('没有任何镜像可测：需要 --docker、--catalog/--images-dir/--measurements 或 --tree');
        return { exitCode: EXIT_NO_DATA, rows: sizeRows, violations, notes, report };
    }
    return {
        exitCode: 0,
        rows: [...sizeRows, ...(blacklist ? blacklist.rows : [])],
        violations,
        notes,
        report,
    };
}

/** 自测：临时目录 + 副本，故意加 1 MiB 垃圾，门必须变红。 */
export function selfTest() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-budget-selftest-'));
    const oneMebibyte = 1024 * 1024;
    const budgetBytes = 20 * oneMebibyte;
    // 干净副本只留 64 KiB 余量，这样“加 1 MiB 垃圾”必然越过预算。
    const cleanBytes = budgetBytes - 64 * 1024;
    const configPath = path.join(root, 'box3-image-budget.json');
    fs.writeFileSync(
        configPath,
        `${JSON.stringify(
            {
                schema: 'box3.image-budget.v1',
                defaultTier: 'transition',
                tiers: { transition: '自测档', target: '自测档' },
                growthToleranceBytes: 0,
                basis: { release: 'selftest', observed: { demo: { contentBytes: cleanBytes } } },
                services: {
                    demo: {
                        contentBytes: { transition: budgetBytes, target: budgetBytes },
                        archiveBytes: { transition: budgetBytes, target: budgetBytes },
                    },
                },
            },
            null,
            2,
        )}\n`,
        'utf8',
    );
    const imagesDir = path.join(root, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const archive = path.join(imagesDir, 'box-local-engine-image-demo-amd64-selftest.tar.gz');
    const catalogPath = path.join(imagesDir, 'BOX3-IMAGE-CATALOG.json');

    const writeInputs = (contentBytes, archiveBytes, archiveOnDisk) => {
        const catalog = {
            imageTag: 'selftest',
            images: [
                {
                    image: `${REPOSITORY_PREFIX}demo`,
                    imageTag: 'selftest',
                    archive: path.basename(archive),
                    sha256: '0'.repeat(64),
                    size: archiveBytes,
                },
            ],
        };
        fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
        fs.writeFileSync(archive, Buffer.alloc(archiveOnDisk, 0x61), 'utf8');
        const measurements = {
            schema: 'box3.image-measurements.v1',
            source: 'selftest',
            images: [
                {
                    service: 'demo',
                    metrics: { contentBytes },
                },
            ],
        };
        const file = path.join(root, 'measurements.json');
        fs.writeFileSync(file, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
        return file;
    };

    const cases = [];
    const runCase = (title, contentBytes, archiveBytes, archiveOnDisk, expectViolation) => {
        const file = writeInputs(contentBytes, archiveBytes, archiveOnDisk);
        const result = run({
            config: configPath,
            catalog: catalogPath,
            measurements: file,
        });
        const observed = result.violations.length > 0;
        cases.push([
            title,
            formatInt(contentBytes),
            formatInt(archiveOnDisk),
            observed ? 'RED' : 'GREEN',
            expectViolation ? 'RED' : 'GREEN',
            observed === expectViolation ? 'PASS' : 'FAIL',
        ]);
        return observed === expectViolation;
    };

    console.log('体积门自测（临时目录 + 副本，不触碰任何真实镜像）');
    let allPassed = true;
    allPassed =
        runCase('1) 干净副本（预算内 1 MiB 余量）', cleanBytes, cleanBytes, cleanBytes, false) &&
        allPassed;
    allPassed =
        runCase(
            '2) 故意塞进 1 MiB 垃圾到 content 测量值',
            cleanBytes + oneMebibyte,
            cleanBytes,
            cleanBytes,
            true,
        ) && allPassed;
    allPassed =
        runCase(
            '3) 1 MiB 垃圾只进了 tar.gz，catalog.size 未同步（完整性）',
            cleanBytes,
            cleanBytes,
            cleanBytes + oneMebibyte,
            true,
        ) && allPassed;
    allPassed =
        runCase(
            '4) 未超预算但比基线长大（回归棘轮）',
            cleanBytes + 1,
            cleanBytes,
            cleanBytes,
            true,
        ) && allPassed;

    console.log(
        `\n${renderTable(
            [
                { title: '场景', align: 'left' },
                { title: 'contentBytes', align: 'right' },
                { title: '归档字节', align: 'right' },
                { title: '门实际', align: 'left' },
                { title: '门应该', align: 'left' },
                { title: '自测', align: 'left' },
            ],
            cases,
        )}`,
    );
    fs.rmSync(root, { recursive: true, force: true });
    if (!allPassed) {
        console.error('自测失败：门没有按预期对 +1 MiB 变红。');
        return EXIT_VIOLATION;
    }
    console.log('自测通过：+1 MiB 垃圾一定会让门变红。');
    return 0;
}

function usage() {
    console.log(
        [
            '用法：node scripts/check-image-budget.mjs [选项]',
            '  --config <file>        预算文件，默认 common/config/box3-image-budget.json',
            '  --images-dir <dir>     含 BOX3-IMAGE-CATALOG.json 与 tar.gz 的目录',
            '  --catalog <file>       直接指定 BOX3-IMAGE-CATALOG.json（或用 BOX3_IMAGE_CATALOG）',
            '  --docker               用 docker image inspect 取 content 字节',
            '  --image-tag <tag>      镜像标签，默认取 catalog 的 imageTag 或 BOX3_IMAGE_TAG',
            '  --docker-bin <path>    docker 可执行文件，默认 docker / DOCKER_BIN',
            '  --measurements <file>  预先测量好的 JSON（W1 dry-run 可直接喂进来）',
            '  --tier transition|ratchet|target',
            '  --services a,b         只检查列出的服务（此时合计档不参与判定）',
            '  --allow-partial        允许部分服务未测量（默认：数据不完整即红）',
            '  --allow-unknown-services  允许产物里出现预算表未声明的镜像（默认：即红）',
            '  --blacklist <file>     黑名单文件，默认 common/config/box3-image-blacklist.json',
            '  --tree <dir>           已解包的单镜像目录树（配合 --service 应用 byService 上限）',
            '  --trees-dir <dir>      每个一级子目录 = 一个服务树',
            '  --service <name>       标注 --tree 属于哪个服务',
            '  --require size,blacklist  声明必须的子门，缺输入源即红（不许静默放行）',
            '  --out <file.json>      机器可读报告',
            '  --self-test            证明 +1 MiB 垃圾一定会让门变红',
            '退出码：0 通过 / 1 违规 / 2 配置错误 / 3 无可测镜像',
        ].join('\n'),
    );
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        usage();
        return EXIT_USAGE;
    }
    if (options.help) {
        usage();
        return 0;
    }
    if (options['self-test']) {
        return selfTest();
    }
    try {
        return run(options).exitCode;
    } catch (error) {
        console.error(`体积门无法运行：${error.message}`);
        return EXIT_USAGE;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    process.exitCode = await main();
}
