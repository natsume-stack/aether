#!/usr/bin/env node
/**
 * 字体审计与子集化待办清单（W3）。读 `scripts/font-manifest.json`，四个子命令：
 *
 *   analyze  扫源资产目录，可选再扫产物 media 目录与已发布 js/css bundle，逐个字体文件归类：
 *              keep            正常浏览器路径上有活引用
 *              deleteNow       任何位置都确认无引用，可删
 *              rustyBranchOnly 只在 process.env.RUSTY 分支可达——在 web bundle 里是死字符串，
 *                              要先改 defs.ts；本工具永不自动删这一类
 *              cssFallback     多格式 @font-face 的第二条 src()，只有重生成 CSS 后才能丢
 *   plan     analyze 加 --out <file.json>；另出 @font-face 重生成清单（每族按 manifest 优先级
 *            保留哪种格式）与待做的 unicode-range 子集化 backlog（附可直接跑的 pyftsubset 命令）
 *   tools    探测 fc-scan / pyftsubset / fontTools 是否存在，据此回答「本机能否真子集化」；
 *            测不出来就报 UNVERIFIED，不猜
 *   apply    只删 deleteNow 类，必须带 --yes，否则 dry-run
 *
 * 用法：
 *   node scripts/subset-fonts.mjs analyze [--media <mediaDir> --bundles <rootDir>]
 *   node scripts/subset-fonts.mjs plan --out font-plan.json
 *   node scripts/subset-fonts.mjs tools
 *   node scripts/subset-fonts.mjs apply --yes
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(scriptDir, 'font-manifest.json');

const FONT_EXT_RE = /(?:ttf|woff2|woff|otf)/i;
const TEXT_SCAN_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.css', '.scss', '.sass', '.ts', '.tsx', '.html',
]);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.pnpm-store']);

/** "ChillRoundGothic-Bold.096e89c0.ttf" -> { base: "ChillRoundGothic-Bold", ext: "ttf" } */
function fontIdentity(name) {
    const ext = path.extname(name).slice(1).toLowerCase();
    let base = path.basename(name, path.extname(name));
    // webpack media names are `<Name>.<8+ hex hash>`; strip a trailing hash part.
    base = base.replace(/\.[0-9a-f]{8,}$/i, '');
    return { base: base.toLowerCase(), ext };
}

function walk(dir, visit, depth = 0) {
    if (depth > 12 || !fs.existsSync(dir)) {
        return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (depth > 0 && (SKIP_DIR_NAMES.has(entry.name) || entry.name === 'dist' || entry.name === 'build')) {
                continue;
            }
            walk(full, visit, depth + 1);
        } else if (entry.isFile()) {
            visit(full, entry.name);
        }
    }
}

function listFontFiles(dir) {
    const out = [];
    walk(dir, (full, name) => {
        if (FONT_EXT_RE.test(name.slice(name.lastIndexOf('.') + 1)) && name.includes('.')) {
            out.push(full);
        }
    });
    return out;
}

/** Collect `family.ext` identities of every font filename mentioned inside any
 *  scannable text file below the roots (imports, url(), bundled media URLs). */
function collectReferenceIdentities(scanRoots) {
    const identities = new Set();
    for (const root of scanRoots) {
        if (!fs.existsSync(root)) {
            continue;
        }
        walk(root, (full) => {
            if (!TEXT_SCAN_EXTENSIONS.has(path.extname(full).toLowerCase())) {
                return;
            }
            let text;
            try {
                text = fs.readFileSync(full, 'utf8');
            } catch {
                return;
            }
            for (const match of text.matchAll(new RegExp(`[\\w.+-]+\\.(?:${FONT_EXT_RE.source})`, 'gi'))) {
                const { base, ext } = fontIdentity(match[0]);
                identities.add(`${base}.${ext}`);
            }
        });
    }
    return identities;
}

function manifestEntryFor(manifest, fileName) {
    const { base, ext } = fontIdentity(fileName);
    for (const family of manifest.families) {
        for (const [format, info] of Object.entries(family.formats || {})) {
            if (format !== ext) {
                continue;
            }
            const expected = fontIdentity(info.file || `${family.family}.${ext}`).base;
            if (expected === base) {
                return { family, format, info };
            }
        }
    }
    return null;
}

function probeTools() {
    const tools = {};
    const which = (cmd) => {
        const probe = process.platform === 'win32'
            ? spawnSync('where', [cmd], { encoding: 'utf8' })
            : spawnSync('sh', ['-c', `command -v ${cmd} >/dev/null 2>&1`], { encoding: 'utf8' });
        return probe.status === 0;
    };
    tools['fc-scan'] = which('fc-scan');
    tools['pyftsubset'] = which('pyftsubset');
    if (!tools['pyftsubset']) {
        let python = spawnSync('python', ['-c', 'import fontTools'], { encoding: 'utf8' });
        if (python.status !== 0) {
            python = spawnSync('python3', ['-c', 'import fontTools'], { encoding: 'utf8' });
        }
        tools['python -m fontTools'] = python.status === 0;
    } else {
        tools['python -m fontTools'] = true;
    }
    return tools;
}

function buildPlan(manifest, options) {
    const sourceDir = path.join(repoRoot, manifest.sourceDir);
    const mediaDirs = options.media
        ? [options.media]
        : manifest.emittedMediaDirs
            .map((dir) => path.join(repoRoot, dir))
            .filter((dir) => fs.existsSync(dir));
    // Default bundle roots: repo sources for source-dir files; for an emitted
    // media dir the sibling js/css chunks are the authoritative consumers.
    const sourceScanRoots = [
        path.join(repoRoot, 'apps'),
        path.join(repoRoot, 'packages'),
        path.join(repoRoot, 'internals'),
    ];

    const plan = {
        generatedAt: new Date().toISOString(),
        tools: probeTools(),
        deleteNow: [],
        keepLive: [],
        rustyBranchOnly: [],
        cssFallbacks: [],
        notInManifest: [],
        emittedMediaAudit: [],
        fontFaceRegeneration: [],
        subsetPending: [],
    };

    const sourceFiles = listFontFiles(sourceDir);
    const sourceRefs = collectReferenceIdentities(sourceScanRoots);
    for (const file of sourceFiles) {
        const name = path.basename(file);
        const { base, ext } = fontIdentity(name);
        const referenced = sourceRefs.has(`${base}.${ext}`);
        const entry = manifestEntryFor(manifest, name);
        const record = {
            file: path.relative(repoRoot, file).replace(/\\/g, '/'),
            bytes: fs.statSync(file).size,
            family: entry ? entry.family.family : null,
            format: entry ? entry.format : ext,
            status: entry ? entry.info.status : referenced ? 'live' : 'unreferenced',
        };
        if (!entry) {
            plan.notInManifest.push({ ...record, referenced });
        }
        if (record.status === 'rusty-branch-only') {
            plan.rustyBranchOnly.push(record);
        } else if (record.status === 'css-fallback') {
            plan.cssFallbacks.push(record);
        } else if (!referenced && record.status === 'unreferenced') {
            plan.deleteNow.push(record);
        } else {
            plan.keepLive.push(record);
        }
    }

    for (const dir of mediaDirs) {
        const files = listFontFiles(dir);
        if (files.length === 0) {
            continue;
        }
        const bundleRoot = options.bundles || path.dirname(path.dirname(dir));
        const mediaRefs = collectReferenceIdentities([bundleRoot]);
        const orphans = [];
        let orphanBytes = 0;
        for (const file of files) {
            const { base, ext } = fontIdentity(path.basename(file));
            if (!mediaRefs.has(`${base}.${ext}`)) {
                orphans.push({ file: path.basename(file), bytes: fs.statSync(file).size });
                orphanBytes += fs.statSync(file).size;
            }
        }
        plan.emittedMediaAudit.push({
            dir: path.relative(repoRoot, dir).replace(/\\/g, '/') || dir,
            bundleRoot: path.relative(repoRoot, bundleRoot).replace(/\\/g, '/') || bundleRoot,
            fontFiles: files.length,
            orphans,
            orphanBytes,
        });
    }

    // @font-face regeneration: per family keep the highest-priority available
    // format; lower-priority src() entries are only droppable after the CSS /
    // defs.ts references are rewritten, which other lanes own.
    for (const family of manifest.families) {
        const formats = Object.entries(family.formats || {})
            .filter(([format]) => manifest.formatPriority.includes(format))
            .sort((a, b) => manifest.formatPriority.indexOf(a[0]) - manifest.formatPriority.indexOf(b[0]));
        if (formats.length < 2) {
            continue;
        }
        plan.fontFaceRegeneration.push({
            family: family.family,
            keepFormat: formats[0][0],
            keepFile: formats[0][1].file || `${family.family}.${formats[0][0]}`,
            droppable: formats.slice(1).map(([format, info]) => ({
                format,
                file: info.file || `${family.family}.${format}`,
                status: info.status,
                shippedBytes: info.shippedBytes ?? null,
            })),
        });
    }

    const subsetTool = plan.tools['pyftsubset'] ? 'pyftsubset' : plan.tools['python -m fontTools'] ? 'python -m fontTools.subset' : null;
    for (const family of manifest.families.filter((f) => f.subsetCandidate)) {
        const candidates = ['woff2', 'woff', 'ttf']
            .map((ext) => path.join(sourceDir, `${family.family}.${ext}`))
            .filter((file) => fs.existsSync(file));
        const target = candidates[0];
        if (!target) {
            continue;
        }
        const rel = path.relative(repoRoot, target).replace(/\\/g, '/');
        const command = `${subsetTool || 'pyftsubset'} "${rel}" ` +
            '--unicodes=U+0020-007E,U+3000-303F,U+4E00-9FFF,U+FF00-FFEF ' +
            `--flavor=woff2 --output-file="${rel.replace(/\.[a-z0-9]+$/i, '')}.subset.woff2"`;
        plan.subsetPending.push({
            family: family.family,
            target: rel,
            bytes: fs.statSync(target).size,
            command,
            status: subsetTool ? 'ready-to-run (not executed by this script)' : 'UNVERIFIED (no pyftsubset/fontTools on PATH)',
        });
    }
    return plan;
}

function printSummary(plan) {
    const sum = (list) => list.reduce((total, item) => total + (item.bytes || 0), 0);
    console.log('tools:', JSON.stringify(plan.tools));
    console.log(`deleteNow (confirmed unreferenced): ${plan.deleteNow.length} files, ${sum(plan.deleteNow)} bytes`);
    for (const item of plan.deleteNow) {
        console.log(`  ${item.file} (${item.bytes} B)`);
    }
    console.log(`keepLive: ${plan.keepLive.length} files, ${sum(plan.keepLive)} bytes`);
    console.log(`rustyBranchOnly (NOT auto-deletable, needs defs.ts change): ${plan.rustyBranchOnly.length}, ${sum(plan.rustyBranchOnly)} bytes`);
    for (const item of plan.rustyBranchOnly) {
        console.log(`  ${item.file} (${item.bytes} B)`);
    }
    console.log(`cssFallbacks: ${plan.cssFallbacks.length}, ${sum(plan.cssFallbacks)} bytes`);
    console.log(`notInManifest: ${plan.notInManifest.length}`);
    for (const item of plan.notInManifest) {
        console.log(`  ${item.file} referenced=${item.referenced} status=${item.status}`);
    }
    for (const audit of plan.emittedMediaAudit) {
        console.log(`media audit ${audit.dir} (bundles: ${audit.bundleRoot}): ${audit.fontFiles} font files, orphans=${audit.orphans.length} (${audit.orphanBytes} B)`);
        for (const orphan of audit.orphans) {
            console.log(`  orphan: ${orphan.file} (${orphan.bytes} B)`);
        }
    }
    console.log(`@font-face regeneration targets: ${plan.fontFaceRegeneration.length}`);
    for (const face of plan.fontFaceRegeneration) {
        console.log(`  ${face.family}: keep ${face.keepFormat} (${face.keepFile}), drop ${face.droppable.map((d) => `${d.format} [${d.status}]`).join(', ')}`);
    }
    console.log(`unicode-range subset backlog: ${plan.subsetPending.length}`);
    for (const item of plan.subsetPending) {
        console.log(`  ${item.family}: ${item.bytes} B - ${item.status}`);
        console.log(`    $ ${item.command}`);
    }
}

function main() {
    const argv = process.argv.slice(2);
    const command = argv[0] || 'analyze';
    const flags = {};
    for (let i = 1; i < argv.length; i += 1) {
        if (['--media', '--bundles', '--out'].includes(argv[i])) {
            flags[argv[i].slice(2)] = argv[i + 1];
            i += 1;
        } else if (argv[i] === '--yes') {
            flags.yes = true;
        }
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (command === 'tools') {
        console.log(JSON.stringify(probeTools(), null, 2));
        return;
    }

    const plan = buildPlan(manifest, {
        media: flags.media ? path.resolve(flags.media) : undefined,
        bundles: flags.bundles ? path.resolve(flags.bundles) : undefined,
    });

    if (flags.out) {
        fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`plan written to ${flags.out}`);
    }
    printSummary(plan);

    if (command === 'apply') {
        if (!flags.yes) {
            console.log('\nDRY RUN: re-run `apply --yes` to delete the deleteNow files listed above.');
            return;
        }
        for (const item of plan.deleteNow) {
            fs.rmSync(path.join(repoRoot, item.file), { force: true });
            console.log(`deleted ${item.file}`);
        }
        return;
    }
    if (!['analyze', 'plan'].includes(command)) {
        console.error(`unknown command: ${command}`);
        process.exitCode = 1;
    }
}

main();
