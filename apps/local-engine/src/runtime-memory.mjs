/**
 * 本地引擎运行时池的「实测」内存预算。
 *
 * 历史做法：launcher 给每个脚本 isolate 定上限时，用的是它观察不到的一列数字——地图体素数
 * （`> 64M -> 2048 MB`、`> 16M -> 1024 MB`、否则 `512 MB`）。那是「这张图大概要多少」的代理，
 * 完全不回答「这台机器给得起多少」；而且在 Play Library 路径上恒不生效——已发布的世界走不到
 * `--project` / `--release` 的 launch-target 解析。
 *
 * 本模块改为测进程真正所在的限额（cgroup v2 → cgroup v1 → `os.totalmem()`），推出每个并发运行时
 * 给得起的份额，并把上面那条体素阶梯留作下限：1024 宽的地形确实要脚本侧体素镜像的余量。
 *
 * 三条不变量，保证可以直接塞进 launcher：
 *   - 显式配置过的 isolate 上限永远优先，且绝不被下调；
 *   - 测得的值只能抬高默认值，且不超过历史最高档 2048 MB → 仍在出厂包络内；
 *   - 什么都测不到时，原样返回历史阶梯。
 *
 * `node runtime-memory.mjs --print` 不起引擎就能看当前主机/容器解析出的预算。
 * 验证状态 UNVERIFIED：还没有一条运行日志证明它算出的数与 `mem_limit`、`--max-old-space-size`
 * 这两层旧上限对齐——串行测量轮在部署镜像里 grep 本模块 0 命中（镜像一次都没重建）。
 */

import fs from 'node:fs';
import os from 'node:os';

export const MB = 1024 * 1024;

/** Historical ladder, kept as a floor. See launcher.js `requiredScriptMemoryMB`. */
export const LEGACY_TIERS = [
    { minVoxels: 64 * 1024 * 1024, memoryMB: 2048 },
    { minVoxels: 16 * 1024 * 1024, memoryMB: 1024 },
];
export const LEGACY_BASE_MB = 512;
/** Never hand a single isolate more than the historical top tier by default. */
export const DEFAULT_MAX_MB = 2048;
/** cgroup v1 reports this as "no limit"; cgroup v2 reports the string "max". */
const CGROUP_V1_UNLIMITED = 9223372036854771712;

function readTrimmed(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return '';
    }
}

function parseBytes(raw) {
    if (!raw || raw === 'max') {
        return null;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        return null;
    }
    return value;
}

/**
 * cgroup paths relative to a mounted cgroup root. `0::/foo` (unified) and the
 * v1 `memory` controller line both resolve here; systemd slices put the real
 * limit on an ancestor, so the walk goes bottom-up.
 */
function selfCgroupPaths(fileNames) {
    const raw = readTrimmed('/proc/self/cgroup');
    const relative = [];
    for (const line of raw.split('\n')) {
        const parts = line.split(':');
        const controller = parts[1] || '';
        if (parts.length >= 3 && (controller === '' || controller.split(',').includes('memory'))) {
            const path = parts.slice(2).join(':') || '/';
            if (path !== '/' && !relative.includes(path)) {
                relative.push(path);
            }
        }
    }
    const candidates = [];
    for (const path of relative) {
        const segments = path.split('/').filter(Boolean);
        while (segments.length) {
            for (const file of fileNames) {
                candidates.push(`/sys/fs/cgroup/${segments.join('/')}/${file}`);
            }
            segments.pop();
        }
    }
    for (const file of fileNames) {
        candidates.push(`/sys/fs/cgroup/${file}`);
        candidates.push(`/sys/fs/cgroup/memory/${file}`);
    }
    return candidates;
}

function firstResolvedValue(candidates, accept) {
    for (const file of candidates) {
        const value = accept(readTrimmed(file));
        if (value !== null && value !== undefined) {
            return { value, file };
        }
    }
    return null;
}

/**
 * @returns {{limitBytes: number|null, source: string, file: string, hostTotalBytes: number,
 *   currentBytes: number|null, highBytes: number|null, cpuQuota: number|null, note: string}}
 */
export function detectMemoryLimit(platform = process.platform) {
    const hostTotalBytes = os.totalmem();
    if (platform === 'win32') {
        // No cgroup on Windows; the launcher runs there only in source/dev mode.
        return {
            limitBytes: hostTotalBytes,
            source: 'os.totalmem',
            file: '',
            hostTotalBytes,
            currentBytes: null,
            highBytes: null,
            cpuQuota: null,
            note: 'win32: no cgroup, falling back to os.totalmem()',
        };
    }

    const v2 = firstResolvedValue(selfCgroupPaths(['memory.max']), (raw) => {
        const value = parseBytes(raw);
        // A root/parent cgroup that is unlimited must not masquerade as a limit.
        return value !== null && value < CGROUP_V1_UNLIMITED ? value : null;
    });
    if (v2) {
        const current = firstResolvedValue(selfCgroupPaths(['memory.current']), (raw) =>
            parseBytes(raw),
        );
        const high = firstResolvedValue(selfCgroupPaths(['memory.high']), (raw) => parseBytes(raw));
        const cpu = firstResolvedValue(selfCgroupPaths(['cpu.max']), (raw) => {
            const [quota, period] = String(raw).split(/\s+/);
            if (!quota || quota === 'max') {
                return null;
            }
            const q = Number(quota);
            const p = Number(period) || 100000;
            return Number.isFinite(q) && q > 0 && p > 0 ? Math.round(q / p) : null;
        });
        return {
            limitBytes: v2.value,
            source: 'cgroup-v2',
            file: v2.file,
            hostTotalBytes,
            currentBytes: current?.value ?? null,
            highBytes: high?.value ?? null,
            cpuQuota: cpu?.value ?? null,
            note: v2.value > hostTotalBytes ? 'limit exceeds host memory' : '',
        };
    }

    const v1 = firstResolvedValue(selfCgroupPaths(['memory.limit_in_bytes']), (raw) => {
        const value = parseBytes(raw);
        return value !== null && value < CGROUP_V1_UNLIMITED ? value : null;
    });
    if (v1) {
        const usage = firstResolvedValue(selfCgroupPaths(['memory.usage_in_bytes']), (raw) =>
            parseBytes(raw),
        );
        return {
            limitBytes: v1.value,
            source: 'cgroup-v1',
            file: v1.file,
            hostTotalBytes,
            currentBytes: usage?.value ?? null,
            highBytes: null,
            cpuQuota: null,
            note: v1.value > hostTotalBytes ? 'limit exceeds host memory' : '',
        };
    }

    return {
        limitBytes: hostTotalBytes,
        source: 'os.totalmem',
        file: '',
        hostTotalBytes,
        currentBytes: null,
        highBytes: null,
        cpuQuota: null,
        note: 'no cgroup memory limit: falling back to os.totalmem()',
    };
}

export function legacyTierMB(voxelCount) {
    for (const tier of LEGACY_TIERS) {
        if (voxelCount > tier.minVoxels) {
            return tier.memoryMB;
        }
    }
    return LEGACY_BASE_MB;
}

function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Everything a container limit has to leave room for before isolates get a
 * say: the launcher itself, the Next server, per-runtime Node heaps, the game
 * server's own heap and the page cache a voxel load streams through. Measured
 * idle stack RSS is ~200-320 MiB per engine container, and each runtime adds a
 * Node process whose heap is unbounded unless BOX_RUNTIME_NODE_MEMORY_MB is
 * set, so a flat fraction of the limit is the least dishonest estimate.
 */
export function defaultReserveMB(limitMB, concurrentRuntimes) {
    const fraction = Math.floor(limitMB / 4);
    const perRuntime = 128 * Math.max(1, concurrentRuntimes);
    return Math.max(512, fraction, perRuntime);
}

/**
 * @param {object} input
 * @param {number} input.voxelCount          map volume, 0 when unknown
 * @param {number|null|undefined} input.explicitMB operator-configured isolate limit
 * @param {number} input.concurrentRuntimes  pool size the limit must be shared with
 * @param {number|null|undefined} input.limitBytes override, else measured
 * @param {number} input.reserveMB           non-isolate headroom
 * @param {number} input.minMB               never hand out less than this
 * @param {number} input.maxMB               never raise the default above this
 * @param {string} input.mode                'measured' (default) or 'compat'
 */
export function deriveScriptMemoryBudget(input = {}) {
    const voxelCount = Number(input.voxelCount) || 0;
    const tierMB = legacyTierMB(voxelCount);
    const minMB = positiveInt(input.minMB, LEGACY_BASE_MB);
    const maxMB = positiveInt(input.maxMB, DEFAULT_MAX_MB);
    const explicitRaw = Number(input.explicitMB);
    const hasExplicit = Number.isFinite(explicitRaw) && explicitRaw > 0;
    const concurrentRuntimes = positiveInt(input.concurrentRuntimes, 1);
    const detection =
        Number.isFinite(input.limitBytes) && input.limitBytes > 0
            ? { limitBytes: Number(input.limitBytes), source: 'provided', note: '' }
            : detectMemoryLimit();
    const limitMB =
        Number.isFinite(detection.limitBytes) && detection.limitBytes > 0
            ? Math.floor(detection.limitBytes / MB)
            : null;
    const reserveMB = positiveInt(
        input.reserveMB,
        limitMB ? defaultReserveMB(limitMB, concurrentRuntimes) : 512,
    );
    const shareMB = limitMB
        ? Math.max(0, Math.floor((limitMB - reserveMB) / concurrentRuntimes))
        : 0;
    const mode = input.mode === 'compat' ? 'compat' : 'measured';
    const warning = limitMB
        ? ''
        : 'memory limit is not measurable here; using the historical voxel ladder';

    let mb;
    let basis;
    if (hasExplicit) {
        // Operator intent always wins, exactly like the previous launcher code.
        mb = Math.max(explicitMB(explicitRaw), tierMB);
        basis = 'env';
    } else if (mode === 'compat' || !shareMB) {
        mb = Math.max(minMB, tierMB);
        basis = mode === 'compat' ? 'legacy(compat)' : 'legacy(unmeasured)';
    } else {
        mb = Math.min(maxMB, Math.max(tierMB, minMB, shareMB));
        basis = `measured(${detection.source}:${limitMB}MB/${concurrentRuntimes}runtimes-reserve${reserveMB}MB)`;
    }

    // Diagnostic only: lowering an isolate cap that somebody configured would
    // break the map that needs it, so an unaffordable pool is reported, not fixed.
    const nominalMB = mb * concurrentRuntimes;
    const overBudgetMB = limitMB ? nominalMB + reserveMB - limitMB : 0;
    return {
        mb,
        tierMB,
        explicitMB: hasExplicit ? explicitRaw : null,
        basis,
        mode,
        concurrentRuntimes,
        reserveMB,
        shareMB,
        limitMB,
        limitSource: detection.source,
        limitFile: detection.file || '',
        currentMB: detection.currentBytes ? Math.round(detection.currentBytes / MB) : null,
        hostTotalMB: Math.round(detection.hostTotalBytes / MB),
        nominalMB,
        overBudgetMB,
        warning,
        ...(overBudgetMB > 0
            ? {
                  headroom: `pool nominal ${nominalMB}MB + reserve ${reserveMB}MB > limit ${limitMB}MB by ${overBudgetMB}MB`,
              }
            : {}),
    };
}

function explicitMB(value) {
    return Math.round(value);
}

function printReport(argv) {
    const readFlag = (name, fallback = '') => {
        const index = argv.indexOf(name);
        return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
    };
    const detection = detectMemoryLimit();
    const runtimes = Number(readFlag('--runtimes', '10')) || 10;
    const explicitRaw = readFlag('--explicit', process.env.BOX_SCRIPT_HEAP_MB || '');
    const explicit = explicitRaw === '' ? null : Number(explicitRaw);
    const mode = readFlag('--mode', process.env.BOX_SCRIPT_MEMORY_BUDGET || 'measured');
    const rows = [
        // Real presets: project-manager.js mapSizePresets / customMapSizeLimits.
        { label: 'preset huge 256x64x256', voxels: 256 * 64 * 256 },
        { label: 'custom 1024x128x512', voxels: 1024 * 128 * 512 },
        { label: 'custom max 1024x128x1024', voxels: 1024 * 128 * 1024 },
    ];
    const override = readFlag('--voxels', '');
    if (override !== '') {
        rows.length = 0;
        rows.push({ label: `explicit --voxels ${override}`, voxels: Number(override) });
    }

    console.log('BOX runtime memory budget (--print self-test)');
    console.log(
        `  source        : ${detection.source}${detection.file ? ` (${detection.file})` : ''}`,
    );
    console.log(
        `  limit         : ${
            detection.limitBytes ? `${Math.round(detection.limitBytes / MB)} MB` : 'unlimited'
        }`,
    );
    console.log(
        `  current usage : ${
            detection.currentBytes ? `${Math.round(detection.currentBytes / MB)} MB` : 'n/a'
        }`,
    );
    console.log(
        `  memory.high   : ${detection.highBytes ? Math.round(detection.highBytes / MB) : 'max'}`,
    );
    console.log(`  host totalmem : ${Math.round(detection.hostTotalBytes / MB)} MB`);
    console.log(`  cpu quota     : ${detection.cpuQuota ?? 'max'} (os.cpus=${os.cpus().length})`);
    console.log(
        `  /proc/self/cgroup: ${readTrimmed('/proc/self/cgroup').replace(/\n/g, ' | ') || 'n/a'}`,
    );
    if (detection.note) {
        console.log(`  note          : ${detection.note}`);
    }
    console.log(`  pool runtimes : ${runtimes}   mode=${mode}   explicit=${explicit ?? 'unset'}`);
    for (const row of rows) {
        const budget = deriveScriptMemoryBudget({
            voxelCount: row.voxels,
            explicitMB: explicit,
            concurrentRuntimes: runtimes,
            mode,
        });
        console.log(
            `  ${row.label.padEnd(24)} voxels=${String(row.voxels).padStart(11)} ` +
                `-> ${String(budget.mb).padStart(4)} MB  tier=${budget.tierMB} share=${
                    budget.shareMB
                } reserve=${budget.reserveMB} basis=${budget.basis}` +
                (budget.headroom ? `  WARN ${budget.headroom}` : '') +
                (budget.warning ? `  WARN ${budget.warning}` : ''),
        );
    }
    if (argv.includes('--json')) {
        console.log(
            JSON.stringify(
                {
                    detection,
                    budgets: rows.map((row) =>
                        deriveScriptMemoryBudget({
                            voxelCount: row.voxels,
                            explicitMB: explicit,
                            concurrentRuntimes: runtimes,
                            mode,
                        }),
                    ),
                },
                null,
                0,
            ),
        );
    }
}

const isCli = (() => {
    try {
        const invoked = process.argv[1] || '';
        return invoked.endsWith('runtime-memory.mjs');
    } catch {
        return false;
    }
})();

if (isCli) {
    printReport(process.argv.slice(2));
}

export { printReport };
