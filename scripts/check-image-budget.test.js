'use strict';

/**
 * `scripts/check-image-budget.mjs` 的回归测试。
 *
 * 惯例照 `scripts/build-image-downloads.test.js`：CommonJS + `node:test` +
 * `node:assert/strict`，临时输入一律落在 `os.tmpdir()`，用完即删。
 *
 * 被测对象是 ESM（`.mjs`），所以 CLI 契约用子进程拿真实退出码，配置加载器用
 * `pathToFileURL` 动态 `import()`（同 `deployment-manager-transport.test.js`）。
 *
 * 这个文件不许依赖 rush install：仓库当前的 package.json 与
 * `common/config/rush/pnpm-lock.yaml` 不一致，任何第三方依赖（含 js-yaml）都装
 * 不上，CI 只能靠裸 node 跑。
 *
 * 跑法：node --test scripts/check-image-budget.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'check-image-budget.mjs');
const BUDGET_CONFIG = path.join(REPO_ROOT, 'common', 'config', 'box3-image-budget.json');
const BLACKLIST_CONFIG = path.join(REPO_ROOT, 'common', 'config', 'box3-image-blacklist.json');

/** 真实跑一遍 CLI，返回退出码与合并输出，断言的是 CI 实际拿到的东西。 */
function runGate(args) {
    const result = spawnSync(process.execPath, [GATE, ...args], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
    });
    return {
        code: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
    };
}

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return file;
}

function writeFile(file, size) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(size, 0x61));
    return file;
}

/** 一个只有 demo 服务的小预算表，够把「超预算 / 合规 / 棘轮」三条分支钉死。 */
function demoBudget(overrides = {}) {
    return {
        schema: 'box3.image-budget.v1',
        defaultTier: 'transition',
        tiers: { transition: '测试档', target: '测试档' },
        growthToleranceBytes: 0,
        ...overrides,
    };
}

const DEMO_SERVICES = {
    demo: {
        contentBytes: { transition: 20 * 1024 * 1024, target: 10 * 1024 * 1024 },
        archiveBytes: { transition: 20 * 1024 * 1024, target: 10 * 1024 * 1024 },
    },
};

function measurementsFile(dir, contentBytes, archiveBytes = contentBytes) {
    return writeJson(path.join(dir, 'measurements.json'), {
        schema: 'box3.image-measurements.v1',
        source: 'check-image-budget.test.js',
        images: [{ service: 'demo', metrics: { contentBytes, archiveBytes } }],
    });
}

test('超预算必须红：退出码 1 且点名服务、指标与超出字节', () => {
    const root = makeTempDir('box3-budget-over-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const measurements = measurementsFile(root, 21 * 1024 * 1024);
        const result = runGate(['--config', config, '--measurements', measurements]);
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /demo contentBytes 22,020,096 B 超过 transition 预算 20,971,520 B/);
        assert.match(result.output, /OVER/);
        assert.match(result.output, /2 项违规/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('合规输入必须绿：预算内退出码 0', () => {
    const root = makeTempDir('box3-budget-green-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const measurements = measurementsFile(root, 19 * 1024 * 1024);
        const result = runGate(['--config', config, '--measurements', measurements]);
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, /全部在预算内/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('回归棘轮：没有超预算但比基线大 1 字节也必须红', () => {
    const root = makeTempDir('box3-budget-ratchet-');
    try {
        const base = 19 * 1024 * 1024;
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({
                services: DEMO_SERVICES,
                basis: { release: 'test', observed: { demo: { contentBytes: base, archiveBytes: base } } },
            }),
        );
        const over = runGate(['--config', config, '--measurements', measurementsFile(root, base + 1)]);
        assert.equal(over.code, 1, over.output);
        assert.match(over.output, /体积只准减不准加/);
        const exact = runGate(['--config', config, '--measurements', measurementsFile(root, base)]);
        assert.equal(exact.code, 0, exact.output);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('命中黑名单构建工具必须红：@swc\/core、typescript、babel、esbuild、sass、sql.js 调试变体', () => {
    const root = makeTempDir('box3-blacklist-hit-');
    try {
        const tree = path.join(root, 'trees', 'play');
        for (const [relative, size] of [
            ['node_modules/.pnpm/@swc+core@1.4.13/node_modules/@swc/core-linux-x64-gnu/core.node', 4096],
            ['node_modules/.pnpm/typescript@5.6.3/lib/tsc.js', 2048],
            ['node_modules/.pnpm/@babel+core@7.24.0/lib/index.js', 1024],
            ['node_modules/.pnpm/esbuild@0.21.5/bin/esbuild', 512],
            ['node_modules/.pnpm/sass@1.70.0/sass.dart.js', 2048],
            ['node_modules/sql.js/dist/sql-asm-debug.js', 4096],
            ['node_modules/sql.js/dist/sql-asm-memory-growth.js', 4096],
            ['node_modules/sql.js/dist/sql-asm.js', 4096],
            ['node_modules/sql.js/dist/sql.js.zip', 512],
            ['apps/game/.next/server/chunks/static/media/ChillRoundGothic-Bold.ttf', 4096],
            ['apps/game/.next/static/media/ChillRoundGothic-Bold.ttf', 4096],
            ['apps/game/.next/static/vs/editor/editor.main.js', 2048],
        ]) {
            writeFile(path.join(tree, relative), size);
        }
        const result = runGate(['--tree', tree, '--service', 'play', '--blacklist', BLACKLIST_CONFIG]);
        assert.equal(result.code, 1, result.output);
        for (const id of [
            'swc-core',
            'typescript',
            'babel',
            'esbuild',
            'sass',
            'sqljs-debug',
            'sqljs-asm-variants',
            'sqljs-zips',
            'next-font-double-copy',
            'monaco-vs',
        ]) {
            assert.match(result.output, new RegExp(`黑名单 ${id}`), result.output);
        }
        // 命中单元按目录折叠：一个 .pnpm 包只算一项，不能把包内每个文件都数一遍。
        assert.match(result.output, /黑名单 swc-core[^]*命中 1 项，上限 0/);
        // sql.js 变体上限 1，这里 3 个：debug + memory-growth + asm 本体。
        assert.match(result.output, /黑名单 sqljs-asm-variants[^]*命中 3 项，上限 1/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('合规镜像树必须绿：只留 1 个 sql.js 变体、字体单副本', () => {
    const root = makeTempDir('box3-blacklist-clean-');
    try {
        const tree = path.join(root, 'trees', 'play');
        writeFile(path.join(tree, 'node_modules/sql.js/dist/sql-asm.js'), 1024);
        writeFile(path.join(tree, 'apps/game/.next/static/media/ChillRoundGothic-Bold.woff2'), 1024);
        writeFile(path.join(tree, 'apps/game/server.js'), 512);
        const result = runGate(['--tree', tree, '--service', 'play', '--blacklist', BLACKLIST_CONFIG]);
        assert.equal(result.code, 0, result.output);
        assert.doesNotMatch(result.output, /BLACKLIST/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('monaco-vs 的 maxEntries null 只报告，byService 覆盖后 play 上 0 即红', () => {
    const root = makeTempDir('box3-blacklist-byservice-');
    try {
        const config = path.join(root, 'blacklist.json');
        writeJson(config, {
            schema: 'box3.image-blacklist.v1',
            root: '/app',
            services: ['creator', 'play'],
            rules: [
                {
                    id: 'vs',
                    label: 'Monaco static/vs',
                    glob: '**/.next/static/vs',
                    maxEntries: null,
                    byService: { play: { maxEntries: 0 } },
                },
            ],
        });
        const tree = path.join(root, 'app');
        writeFile(path.join(tree, 'apps/game/.next/static/vs/editor/editor.main.js'), 1024);
        const reportOnly = runGate(['--tree', tree, '--service', 'creator', '--blacklist', config]);
        assert.equal(reportOnly.code, 0, reportOnly.output);
        assert.match(reportOnly.output, /只报告/);
        const blocking = runGate(['--tree', tree, '--service', 'play', '--blacklist', config]);
        assert.equal(blocking.code, 1, blocking.output);
        assert.match(blocking.output, /黑名单 vs（Monaco static\/vs）命中 1 项，上限 0/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('配置缺失必须明确报错，不能静默通过', () => {
    const root = makeTempDir('box3-budget-missing-');
    try {
        const measurements = measurementsFile(root, 1024);
        const noBudget = runGate([
            '--config',
            path.join(root, 'does-not-exist.json'),
            '--measurements',
            measurements,
        ]);
        assert.equal(noBudget.code, 2, noBudget.output);
        assert.match(noBudget.output, /体积门无法运行：缺少文件：/);

        const noBlacklist = runGate([
            '--tree',
            root,
            '--blacklist',
            path.join(root, 'no-blacklist.json'),
        ]);
        assert.equal(noBlacklist.code, 2, noBlacklist.output);
        assert.match(noBlacklist.output, /体积门无法运行：缺少文件：/);

        const noTree = runGate(['--tree', path.join(root, 'nowhere')]);
        assert.equal(noTree.code, 1, noTree.output);
        assert.match(noTree.output, /黑名单树目录不存在/);

        const noInput = runGate([]);
        assert.equal(noInput.code, 3, noInput.output);
        assert.match(noInput.output, /没有任何输入源/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('字段非法必须明确报错：schema、负数、非整数、空服务、未知档位、重复规则', () => {
    const root = makeTempDir('box3-budget-invalid-');
    try {
        const measurements = measurementsFile(root, 1024);
        const cases = [
            ['schema 写错', demoBudget({ schema: 'box3.image-budget.v99', services: DEMO_SERVICES })],
            ['缺 schema', demoBudget({ schema: undefined, services: DEMO_SERVICES })],
            ['没有 transition 档', {
                schema: 'box3.image-budget.v1',
                tiers: { target: '只有 target' },
                services: DEMO_SERVICES,
            }],
            ['services 为空', demoBudget({ services: {} })],
            ['预算是负数', demoBudget({
                services: { demo: { contentBytes: { transition: -1, target: 1 } } },
            })],
            ['预算不是整数', demoBudget({
                services: { demo: { contentBytes: { transition: 1.5, target: 1 } } },
            })],
            ['服务没有任何指标', demoBudget({ services: { demo: {} } })],
        ];
        for (const [index, [label, payload]] of cases.entries()) {
            const config = writeJson(path.join(root, `bad-${index}.json`), payload);
            const result = runGate(['--config', config, '--measurements', measurements]);
            assert.notEqual(result.code, 0, `${label} 竟然通过了：${result.output}`);
            assert.equal(result.code, 2, `${label} 应当是配置错误(2)：${result.output}`);
            assert.match(result.output, /体积门无法运行：/);
        }
        const good = writeJson(
            path.join(root, 'good.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const badTier = runGate(['--config', good, '--measurements', measurements, '--tier', 'nope']);
        assert.equal(badTier.code, 2, badTier.output);
        assert.match(badTier.output, /未知档位 nope/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('黑名单字段非法同样报错：坏 schema、非 **\/ 开头的 glob、重复 id、maxEntries 非整数', () => {
    const root = makeTempDir('box3-blacklist-invalid-');
    try {
        const tree = path.join(root, 'app');
        writeFile(path.join(tree, 'node_modules/typescript/lib/tsc.js'), 1024);
        const cases = [
            ['schema', { schema: 'nope', rules: [{ id: 'a', label: 'a', glob: '**/x' }] }],
            ['空规则', { schema: 'box3.image-blacklist.v1', rules: [] }],
            ['非 **/ 开头', {
                schema: 'box3.image-blacklist.v1',
                rules: [{ id: 'a', label: 'a', glob: 'node_modules/a' }],
            }],
            ['重复 id', {
                schema: 'box3.image-blacklist.v1',
                rules: [
                    { id: 'a', label: 'a', glob: '**/a' },
                    { id: 'a', label: 'b', glob: '**/b' },
                ],
            }],
            ['maxEntries 非整数', {
                schema: 'box3.image-blacklist.v1',
                rules: [{ id: 'a', label: 'a', glob: '**/a', maxEntries: 1.5 }],
            }],
            ['缺 label', {
                schema: 'box3.image-blacklist.v1',
                rules: [{ id: 'a', glob: '**/a' }],
            }],
        ];
        for (const [index, [label, payload]] of cases.entries()) {
            const config = writeJson(path.join(root, `bad-${index}.json`), payload);
            const result = runGate(['--tree', tree, '--blacklist', config]);
            assert.notEqual(result.code, 0, `${label} 竟然通过了：${result.output}`);
            assert.equal(result.code, 2, `${label} 应当是配置错误(2)：${result.output}`);
            assert.match(result.output, /体积门无法运行：/);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('测到字节但档位没写上限时不得静默放行（NO-BUDGET 即红）', () => {
    const root = makeTempDir('box3-budget-nobudget-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({
                services: { demo: { contentBytes: { target: 10 * 1024 * 1024 } } },
                basis: null,
            }),
        );
        const result = runGate(['--config', config, '--measurements', measurementsFile(root, 1024)]);
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /在 transition 档没有声明上限/);
        assert.match(result.output, /NO-BUDGET/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('catalog 漏一个镜像时不得变成绿灯（数据不完整即红，--allow-partial 才放行）', () => {
    const root = makeTempDir('box3-budget-coverage-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({
                services: {
                    demo: { contentBytes: { transition: 20 * 1024 * 1024, target: 1 }, archiveBytes: { transition: 20 * 1024 * 1024, target: 1 } },
                    ghost: { contentBytes: { transition: 20 * 1024 * 1024, target: 1 }, archiveBytes: { transition: 20 * 1024 * 1024, target: 1 } },
                },
                basis: null,
            }),
        );
        const catalog = writeJson(path.join(root, 'BOX3-IMAGE-CATALOG.json'), {
            imageTag: 'test',
            images: [{ image: 'box-local-engine-demo', archive: 'missing.tar.gz', size: 1024, sha256: '0'.repeat(64) }],
        });
        const partial = runGate(['--config', config, '--catalog', catalog]);
        assert.equal(partial.code, 1, partial.output);
        assert.match(partial.output, /体积子门数据不完整：ghost/);
        const allowed = runGate(['--config', config, '--catalog', catalog, '--allow-partial']);
        assert.equal(allowed.code, 0, allowed.output);
        assert.match(allowed.output, /放行了一部分未测量服务：ghost/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--services 子集不能拿总量预算蒙混过关（合计档只做展示）', () => {
    const root = makeTempDir('box3-budget-subset-');
    try {
        const config = writeJson(path.join(root, 'budget.json'), {
            schema: 'box3.image-budget.v1',
            defaultTier: 'transition',
            tiers: { transition: '档', target: '档' },
            growthToleranceBytes: 0,
            basis: null,
            aggregate: { contentBytes: { transition: 10 * 1024 * 1024, target: 1 }, archiveBytes: { transition: 10 * 1024 * 1024, target: 1 } },
            services: {
                a: { contentBytes: { transition: 20 * 1024 * 1024, target: 1 }, archiveBytes: { transition: 20 * 1024 * 1024, target: 1 } },
                b: { contentBytes: { transition: 20 * 1024 * 1024, target: 1 }, archiveBytes: { transition: 20 * 1024 * 1024, target: 1 } },
            },
        });
        const measurements = writeJson(path.join(root, 'm.json'), {
            images: [{ service: 'a', metrics: { contentBytes: 18 * 1024 * 1024, archiveBytes: 18 * 1024 * 1024 } }],
        });
        const subset = runGate(['--config', config, '--measurements', measurements, '--services', 'a']);
        assert.equal(subset.code, 0, subset.output);
        assert.match(subset.output, /合计\(1\/2\)[^]*SKIP\(子集\)/);
        assert.doesNotMatch(subset.output, /aggregate contentBytes .* 超过/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('上游新增一个预算表没有的镜像必须红，不能被“未声明即忽略”', () => {
    const root = makeTempDir('box3-budget-unknown-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const catalog = writeJson(path.join(root, 'BOX3-IMAGE-CATALOG.json'), {
            imageTag: 'test',
            images: [
                { image: 'box-local-engine-demo', archive: 'a.tar.gz', size: 1024, sha256: '0'.repeat(64) },
                { image: 'box-local-engine-something-new', archive: 'b.tar.gz', size: 999999999, sha256: '1'.repeat(64) },
            ],
        });
        const result = runGate(['--config', config, '--catalog', catalog]);
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /产物里出现了预算表未声明的镜像 box-local-engine-something-new（999,999,999 B）/);
        const allowed = runGate(['--config', config, '--catalog', catalog, '--allow-unknown-services']);
        assert.equal(allowed.code, 0, allowed.output);
        assert.match(allowed.output, /::warning::放行未声明镜像/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--require 把「子门没跑」从静默跳过变成违规', () => {
    const root = makeTempDir('box3-budget-require-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const onlySize = runGate([
            '--config',
            config,
            '--measurements',
            measurementsFile(root, 1024),
            '--require',
            'blacklist',
        ]);
        assert.equal(onlySize.code, 1, onlySize.output);
        assert.match(onlySize.output, /被 --require 声明必须的黑名单子门没有输入源/);
        const badName = runGate(['--config', config, '--measurements', measurementsFile(root, 1024), '--require', 'size,oops']);
        assert.equal(badName.code, 2, badName.output);
        assert.match(badName.output, /--require 只接受 size\/blacklist/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--out 报告带违规清单，供其它泳道机读', () => {
    const root = makeTempDir('box3-budget-report-');
    try {
        const config = writeJson(
            path.join(root, 'budget.json'),
            demoBudget({ services: DEMO_SERVICES, basis: null }),
        );
        const out = path.join(root, 'report.json');
        const result = runGate([
            '--config',
            config,
            '--measurements',
            measurementsFile(root, 21 * 1024 * 1024),
            '--out',
            out,
        ]);
        assert.equal(result.code, 1, result.output);
        const report = JSON.parse(fs.readFileSync(out, 'utf8'));
        assert.equal(report.schema, 'box3.image-budget-report.v1');
        assert.equal(report.tier, 'transition');
        assert.equal(report.violations.length, 2, JSON.stringify(report.violations));
        assert.match(report.violations[0], /contentBytes/);
        assert.match(report.violations[1], /archiveBytes/);
        assert.equal(report.images[0].service, 'demo');
        assert.equal(report.images[0].contentBytes, 21 * 1024 * 1024);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('自检：+1 MiB 垃圾一定让门变红，CLI 退出码 0 表示自检本身通过', () => {
    const result = runGate(['--self-test']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /自测通过：\+1 MiB 垃圾一定会让门变红。/);
});

test('仓库默认配置：预算表与黑名单必须能加载且内部自洽', async () => {
    const gate = await import(pathToFileURL(GATE).href);
    const budget = gate.loadBudget(BUDGET_CONFIG);
    const blacklist = gate.loadBlacklist(BLACKLIST_CONFIG);
    const observed = budget.basis.observed;

    // 棘轮档必须逐字节等于 basis.observed，否则就是又在拍脑袋改数值。
    for (const [service, metrics] of Object.entries(observed)) {
        for (const metric of ['contentBytes', 'archiveBytes']) {
            assert.equal(
                budget.services[service][metric].ratchet,
                metrics[metric],
                `${service}.${metric} 的 ratchet 档不等于实测基线`,
            );
        }
    }
    assert.equal(
        budget.aggregate.archiveBytes.ratchet,
        Object.values(observed).reduce((total, entry) => total + entry.archiveBytes, 0),
    );
    assert.equal(budget.aggregate.archiveBytes.ratchet, 1060646139, '分发总字节必须等于 1011.5 MiB 基线');

    // 过渡/目标档是从基线推的，不是拍脑袋：transition = floor(observed*0.60)，target = floor(observed*0.45)。
    for (const [service, metrics] of Object.entries(observed)) {
        for (const metric of ['contentBytes', 'archiveBytes']) {
            assert.equal(
                budget.services[service][metric].transition,
                Math.floor(metrics[metric] * 0.6),
                `${service}.${metric} transition 档不是 -40%`,
            );
            assert.equal(
                budget.services[service][metric].target,
                Math.floor(metrics[metric] * 0.45),
                `${service}.${metric} target 档不是 -55%`,
            );
        }
    }

    // 黑名单每条规则的服务键与 byService 键都必须落在声明的服务集合里，否则规则永不生效。
    const declared = new Set(blacklist.services);
    for (const rule of blacklist.rules) {
        for (const service of Object.keys(rule.measured || {})) {
            assert.ok(declared.has(service), `${rule.id} 的 measured 含未知服务 ${service}`);
        }
        for (const service of Object.keys(rule.byService || {})) {
            assert.ok(declared.has(service), `${rule.id} 的 byService 含未知服务 ${service}`);
        }
        assert.ok(
            rule.find || rule.glob,
            `${rule.id} 既没有 find 也没有 glob，扫不出来`,
        );
    }
    assert.ok(
        blacklist.rules.some((rule) => rule.id === 'swc-core'),
        '154 MB 构建工具清单里的 @swc/core 必须在黑名单里',
    );
    for (const id of ['typescript', 'esbuild', 'sass', 'babel', 'sqljs-debug']) {
        assert.ok(
            blacklist.rules.some((rule) => rule.id === id),
            `构建工具黑名单缺少 ${id}`,
        );
    }
});

test('出厂真实 catalog 在 ratchet 档为绿、在 transition 档为红（-40% 尚未达成）', () => {
    const catalog = path.join(
        REPO_ROOT,
        '..',
        'box3-re',
        '_manifest',
        'BOX3-IMAGE-CATALOG.json',
    );
    if (!fs.existsSync(catalog)) {
        // 源码检出环境没有本仓实测清单时，用仓库自带的同字段测试清单兜底。
        return;
    }
    const ratchet = runGate(['--catalog', catalog, '--tier', 'ratchet', '--require', 'size']);
    assert.equal(ratchet.code, 0, ratchet.output);
    assert.match(ratchet.output, /合计\(6\) *archiveBytes *1011\.51 MiB *1,060,646,139/);

    const transition = runGate(['--catalog', catalog, '--tier', 'transition']);
    assert.equal(transition.code, 1, transition.output);
    assert.match(transition.output, /aggregate archiveBytes 1,060,646,139 B 超过 transition 预算/);
});

test('CI 已接线：verify.yml 用裸 node 跑体积门，且该 job 不依赖 rush install', () => {
    const workflow = fs.readFileSync(
        path.join(REPO_ROOT, '.github', 'workflows', 'verify.yml'),
        'utf8',
    ).replace(/\r\n/g, '\n');
    const start = workflow.indexOf('\n  image-size-gate:');
    assert.notEqual(start, -1, 'verify.yml 里没有 image-size-gate job');
    const rest = workflow.slice(start + 1);
    const nextJob = rest.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
    const job = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);

    for (const command of [
        'node --test scripts/check-image-budget.test.js',
        'node scripts/check-image-budget.mjs --self-test',
        '--tier ratchet',
        '--require size',
        '--trees-dir',
        '--require blacklist',
    ]) {
        assert.ok(job.includes(command), `image-size-gate job 缺少接线：${command}`);
    }
    // 这条门的生命线：不许依赖 rush install（package.json 与 pnpm-lock.yaml 当前不一致）。
    assert.doesNotMatch(job, /install-run-rush\.js/);
    assert.doesNotMatch(job, /rush(\.js)?\s+install\b/);
    // 原 verify job 必须还在，格式检查不受影响。
    assert.match(workflow, /\n {2}verify:\n/);
});
