#!/usr/bin/env node

/**
 * Prune build-time toolchains out of a Next.js standalone output and out of a
 * `rushx deploy --legacy` runtime tree.
 *
 * Why this exists
 * ---------------
 * `outputFileTracingRoot` in apps/game/next.config.js is the repository root,
 * so `next build` materialises the whole pnpm virtual store
 * (`common/temp/node_modules/.pnpm`) inside `.next/standalone`. That store
 * carries the compiler stack (SWC, TypeScript, esbuild, Sass, Babel, webpack,
 * terser) which is only ever executed by `next build`. Creator/Play/Player
 * Service/VOXA then COPY that tree wholesale.
 *
 * The prune therefore runs in the *build* stages, not in the runtime stages.
 * A `RUN` in the final stage would only record overlay whiteouts while the
 * bytes stay in the earlier COPY layer, saving nothing in the published gzip.
 *
 * Safety model — a package directory is removed only when every one of these
 * holds:
 *   1. its pnpm directory name starts with one explicit rule below (no
 *      wildcard-everything sweep, and nothing outside the rules is touched);
 *   2. no JavaScript outside `node_modules` in the traced tree names it as a
 *      real module specifier (`require("x")`, `import "x"`, `from "x"`,
 *      `require.resolve("x")`). Bare string keys such as the `"typescript"`
 *      entry inside the serialised nextConfig embedded in server.js, or Monaco
 *      language ids in `.next/static` browser chunks, are deliberately not
 *      treated as requires because browser chunks can never load node_modules;
 *   3. no *surviving* store package depends on it through `dependencies`,
 *      `optionalDependencies`, or a `peerDependencies` entry the declaring
 *      package does not mark optional in `peerDependenciesMeta`. Declarations
 *      coming from packages that are themselves removed do not count, so a
 *      self-contained tool cluster (webpack + terser-webpack-plugin + terser +
 *      jest-worker) can leave together;
 *   4. it is not protected by `--keep`.
 *
 * Workspace manifests traced into the standalone (internals/, packages/,
 * services/, apps/) often still list these tools under `dependencies` even
 * though their traced sources never require them. Those declarations are
 * reported as `manifestDeclarations` warnings instead of blocking the removal,
 * because the package contents are the real evidence; pass `--strict-manifests`
 * to promote them into hard skips.
 *
 * Default is dry-run: nothing is deleted until `--apply` is passed.
 *
 * Usage
 * -----
 *   node scripts/prune-standalone.mjs <root> [<root> ...] [options]
 *
 * Options
 *   --apply                    delete instead of reporting
 *   --tier <core|all>          rule tiers to use, default: all
 *   --json <file>              write the machine readable CI summary
 *   --keep <substring>         never remove paths containing this (repeatable)
 *   --strict-manifests         also keep anything listed in a traced workspace
 *                              manifest
 *   --drop-embedded-static     remove the `.next/static` tree already inside the
 *                              standalone output, for targets whose Dockerfile
 *                              COPYs its own fresh copy over that same path
 *   --verify-boot <entry>      start `node <entry>` and require it to bind PORT
 *   --boot-timeout <ms>        verify-boot budget, default 60000
 *   --quiet                    print only the summary
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Rules matched against the pnpm store directory spelling (`@swc+core@1.4.13`). */
const CORE_RULES = [
    '@swc+core',
    '@swc+wasm',
    'typescript@',
    '@typescript',
    'esbuild@',
    '@esbuild+',
    'sass@',
    'sass-embedded@',
    '@babel+',
    'babel-',
    'amphtml',
];

/**
 * Only these are added at tier `all`. Every one of them is a bundler/minifier
 * that Next ships inside `next/dist/compiled` for production use, so an
 * external copy in the traced store is build-time weight.
 */
const EXTENDED_RULES = [
    'terser@',
    'terser-webpack-plugin@',
    'uglify-js@',
    'webpack@',
    'webpack-cli@',
    'webpack-sources@',
    'html-minifier-terser@',
    'jest@',
    'jest-',
    '@jest+',
    'eslint@',
    '@eslint+',
    'prettier@',
    'swc-loader@',
    'ts-loader@',
    'babel-loader@',
];

/**
 * Packages that must stay but still ship dead build payload. Trim rules delete
 * individual files inside them instead of the whole directory.
 */
const TRIM_RULES = new Map([
    [
        'sql.js',
        {
            kind: 'sqljs-variants',
            note: 'sql.js bundles asm/debug/worker/emscripten variants; Node loads only the package.json `main` entry (dist/sql-wasm.js) plus its sibling .wasm',
        },
    ],
    [
        'isolated-vm',
        {
            kind: 'native-sources',
            note: 'isolated-vm ships a compiled out/isolated_vm.node; the C++/V8 headers and gyp inputs are only needed to rebuild it',
        },
    ],
]);

const SCANNABLE_EXTENSIONS = new Set([
    '.js',
    '.cjs',
    '.mjs',
    '.jsx',
    '.ts',
    '.tsx',
]);

/** Matches a module specifier used in a load position, not as an object key. */
const SPECIFIER_PATTERNS = [
    /require\(\s*['"`]([^'"`\n]{1,200})['"`]\s*\)/g,
    /import\(\s*['"`]([^'"`\n]{1,200})['"`]\s*\)/g,
    /\bfrom\s+['"`]([^'"`\n]{1,200})['"`]/g,
    /\bimport\s+['"`]([^'"`\n]{1,200})['"`]/g,
    /require\.resolve\(\s*['"`]([^'"`\n]{1,200})['"`]/g,
];

function parseArgs(argv) {
    const options = {
        roots: [],
        apply: false,
        tier: 'all',
        json: '',
        keep: [],
        strictManifests: false,
        dropEmbeddedStatic: false,
        verifyBoot: '',
        bootTimeoutMs: 60_000,
        quiet: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--tier') {
            options.tier = argv[++index] || 'all';
        } else if (arg === '--json') {
            options.json = argv[++index] || '';
        } else if (arg === '--keep') {
            options.keep.push(argv[++index] || '');
        } else if (arg === '--strict-manifests') {
            options.strictManifests = true;
        } else if (arg === '--drop-embedded-static') {
            options.dropEmbeddedStatic = true;
        } else if (arg === '--verify-boot') {
            options.verifyBoot = argv[++index] || '';
        } else if (arg === '--boot-timeout') {
            options.bootTimeoutMs = Number(argv[++index]) || 60_000;
        } else if (arg === '--quiet') {
            options.quiet = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            options.roots.push(arg);
        }
    }

    if (!options.verifyBoot && options.roots.length === 0) {
        throw new Error(
            'Usage: node scripts/prune-standalone.mjs <standalone-root> [...] [--apply] [--json report.json]',
        );
    }
    if (!['core', 'all'].includes(options.tier)) {
        throw new Error(`--tier must be "core" or "all", got: ${options.tier}`);
    }

    return options;
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/** Apparent bytes, the unit `du -b` reports. Never follows symlinks. */
function sizeOf(target) {
    let handle;
    try {
        handle = fs.lstatSync(target);
    } catch {
        return 0;
    }
    if (handle.isSymbolicLink() || handle.isFile()) {
        return handle.size;
    }
    if (!handle.isDirectory()) {
        return 0;
    }

    let total = handle.size;
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
        return handle.size;
    }
    for (const entry of entries) {
        total += sizeOf(path.join(target, entry.name));
    }
    return total;
}

function walk(target, visit, depth = 0) {
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(target, entry.name);
        visit(full, entry);
        if (entry.isDirectory() && depth < 30) {
            walk(full, visit, depth + 1);
        }
    }
}

function inNodeModules(target) {
    return target.includes(`${path.sep}node_modules${path.sep}`);
}

/**
 * Every pnpm virtual store below the root. The standalone output nests the
 * store under common/temp because the tracing root is the repository.
 */
function findPnpmStores(root) {
    const found = new Set();
    const seeds = [
        path.join(root, 'node_modules', '.pnpm'),
        path.join(root, 'common', 'temp', 'node_modules', '.pnpm'),
    ];
    for (const seed of seeds) {
        if (isDirectory(seed)) {
            found.add(seed);
        }
    }
    walk(root, (full, entry) => {
        if (entry.isDirectory() && entry.name === '.pnpm' && inNodeModules(full)) {
            found.add(full);
        }
    });
    return [...found];
}

function readManifest(packageDir) {
    const manifestPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return manifest && typeof manifest.name === 'string' ? manifest : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the package actually contained by a store entry. Each
 * `.pnpm/<name>@<version>/node_modules/` holds exactly one real directory (the
 * package itself) plus symlinks to its resolved dependencies. Reading the name
 * from package.json avoids mis-parsing scoped and peer-suffixed directories.
 */
function inspectStoreEntry(entryDir) {
    const inner = path.join(entryDir, 'node_modules');
    if (!isDirectory(inner)) {
        return null;
    }

    const check = (candidate) => {
        let stat;
        try {
            stat = fs.lstatSync(candidate);
        } catch {
            return null;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return null;
        }
        return readManifest(candidate);
    };

    for (const top of fs.readdirSync(inner)) {
        const first = path.join(inner, top);
        if (top.startsWith('@') && isDirectory(first)) {
            for (const sub of fs.readdirSync(first)) {
                const manifest = check(path.join(first, sub));
                if (manifest) {
                    return { packageDir: path.join(first, sub), manifest };
                }
            }
            continue;
        }
        const manifest = check(first);
        if (manifest) {
            return { packageDir: first, manifest };
        }
    }
    return null;
}

function collectStoreEntries(storeDirs) {
    const entries = [];
    for (const store of storeDirs) {
        let names;
        try {
            names = fs.readdirSync(store);
        } catch {
            continue;
        }
        for (const name of names) {
            const dir = path.join(store, name);
            if (name === 'node_modules' || !isDirectory(dir)) {
                continue;
            }
            const inspected = inspectStoreEntry(dir);
            if (!inspected) {
                continue;
            }
            entries.push({
                store,
                dir,
                packageDir: inspected.packageDir,
                dirName: name,
                name: inspected.manifest.name,
                manifest: inspected.manifest,
            });
        }
    }
    return entries;
}

function dependencyViews(entry) {
    const manifest = entry.manifest || {};
    const hard = new Set([
        ...Object.keys(manifest.dependencies || {}),
        ...Object.keys(manifest.optionalDependencies || {}),
    ]);
    const peers = new Set();
    const meta = manifest.peerDependenciesMeta || {};
    for (const name of Object.keys(manifest.peerDependencies || {})) {
        if (!meta[name] || !meta[name].optional) {
            peers.add(name);
        }
    }
    return { hard, peers };
}

/**
 * Collect module specifiers from loadable sources outside node_modules.
 * `.next/static` is included on purpose: a browser chunk that mentions a
 * package name is still evidence a developer wrote the specifier, so tier-`all`
 * rules can be audited against it. The trade-off is reported in `skipped`.
 */
function collectSpecifiers(root) {
    const specifiers = new Set();
    const scannedFiles = { count: 0, bytes: 0 };

    walk(root, (full, entry) => {
        if (inNodeModules(full) || entry.isSymbolicLink() || !entry.isFile()) {
            return;
        }
        if (!SCANNABLE_EXTENSIONS.has(path.extname(full))) {
            return;
        }
        let text;
        try {
            text = fs.readFileSync(full, 'utf8');
        } catch {
            return;
        }
        scannedFiles.count += 1;
        scannedFiles.bytes += Buffer.byteLength(text);
        for (const pattern of SPECIFIER_PATTERNS) {
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) {
                specifiers.add(match[1]);
            }
        }
    });

    return { specifiers, scannedFiles };
}

/** Package names declared by traced workspace manifests (outside node_modules). */
function collectManifestDeclarations(root) {
    const declared = new Map();
    walk(root, (full, entry) => {
        if (inNodeModules(full) || entry.isSymbolicLink() || !entry.isFile()) {
            return;
        }
        if (path.basename(full) !== 'package.json') {
            return;
        }
        const manifest = readManifest(path.dirname(full));
        if (!manifest) {
            return;
        }
        const from = path.relative(root, path.dirname(full));
        for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            for (const name of Object.keys(manifest[field] || {})) {
                if (!declared.has(name)) {
                    declared.set(name, []);
                }
                declared.get(name).push(`${from} (${field})`);
            }
        }
    });
    return declared;
}

function matchesRule(dirName, rules) {
    return rules.find((rule) => dirName.startsWith(rule));
}

function trimTargets(entry, kind) {
    const packageDir = entry.packageDir || path.join(entry.dir, 'node_modules', ...entry.name.split('/'));
    const results = [];

    if (kind === 'sqljs-variants') {
        const distDir = path.join(packageDir, 'dist');
        if (!isDirectory(distDir)) {
            return results;
        }
        const mainFile = path.basename(entry.manifest?.main || 'sql-wasm.js');
        const keepStem = mainFile.replace(/\.[^.]+$/, '');
        const keep = new Set([mainFile, `${keepStem}.wasm`, 'sql-wasm.js', 'sql-wasm.wasm']);
        for (const name of fs.readdirSync(distDir)) {
            const full = path.join(distDir, name);
            if (fs.statSync(full).isFile() && !keep.has(name)) {
                results.push(full);
            }
        }
        return results;
    }

    if (kind === 'native-sources') {
        const bindings = [];
        walk(packageDir, (full, e) => {
            if (e.isFile() && full.endsWith('.node')) {
                bindings.push(full);
            }
        });
        // Without the compiled binding the C++ inputs are the sandbox, so the
        // whole package has to stay.
        if (bindings.length === 0) {
            return results;
        }
        const keepDirs = new Set([path.join(packageDir, 'out')]);
        for (const dirName of ['src', 'vendor', 'native-example', 'build', 'bin']) {
            const dir = path.join(packageDir, dirName);
            if (!isDirectory(dir)) {
                continue;
            }
            walk(dir, (full, e) => {
                if (e.isFile() && !full.endsWith('.node')) {
                    results.push(full);
                }
            });
        }
        for (const dir of keepDirs) {
            if (!isDirectory(dir)) {
                continue;
            }
            walk(dir, (full, e) => {
                if (e.isFile() && !full.endsWith('.node')) {
                    results.push(full);
                }
            });
        }
        walk(packageDir, (full, e) => {
            if (e.isFile() && /\.(cc|cpp|c|h|hpp|gyp|gypi)$/.test(full)) {
                results.push(full);
            }
        });
        return [...new Set(results)];
    }

    return results;
}

function removePath(target, apply) {
    const bytes = sizeOf(target);
    if (apply) {
        fs.rmSync(target, { recursive: true, force: true });
    }
    return bytes;
}

function pruneRoot(root, options, log) {
    const storeDirs = findPnpmStores(root);
    const rules = options.tier === 'core' ? [...CORE_RULES] : [...CORE_RULES, ...EXTENDED_RULES];
    const entries = collectStoreEntries(storeDirs);
    const { specifiers, scannedFiles } = collectSpecifiers(root);
    const manifestDeclarations = collectManifestDeclarations(root);

    const records = entries.map((entry) => ({
        entry,
        state: 'pending',
        size: sizeOf(entry.dir),
        rule: '',
        reason: '',
    }));
    const byName = new Map();
    for (const record of records) {
        if (!byName.has(record.entry.name)) {
            byName.set(record.entry.name, []);
        }
        byName.get(record.entry.name).push(record);
        const views = dependencyViews(record.entry);
        record.hard = views.hard;
        record.peers = views.peers;
    }

    const declarersOf = new Map();
    for (const record of records) {
        for (const name of record.hard) {
            if (!declarersOf.has(name)) {
                declarersOf.set(name, []);
            }
            declarersOf.get(name).push({ record, kind: 'hard' });
        }
        for (const name of record.peers) {
            if (!declarersOf.has(name)) {
                declarersOf.set(name, []);
            }
            declarersOf.get(name).push({ record, kind: 'peer' });
        }
    }

    // Seed decisions: rule match plus the two source-level proofs.
    for (const record of records) {
        const rule = matchesRule(record.entry.dirName, rules);
        if (!rule) {
            record.state = 'keep';
            continue;
        }
        record.rule = rule;
        if (options.keep.some((needle) => record.entry.dir.includes(needle))) {
            record.state = 'keep';
            record.rule = '';
            record.reason = 'protected by --keep';
            continue;
        }
        if (specifiers.has(record.entry.name)) {
            record.state = 'keep';
            record.reason = 'required by traced application sources';
            continue;
        }
        if (
            options.strictManifests &&
            manifestDeclarations.has(record.entry.name)
        ) {
            record.state = 'keep';
            record.reason = `listed in traced workspace manifest: ${manifestDeclarations.get(record.entry.name).join(', ')}`;
            continue;
        }
        record.state = 'pending';
    }

    // Fixed point: a pending tool stays only if a package that *stays* needs it.
    for (;;) {
        let changed = false;
        for (const record of records) {
            if (record.state !== 'pending') {
                continue;
            }
            for (const declarer of declarersOf.get(record.entry.name) || []) {
                if (declarer.record === record) {
                    continue;
                }
                if (declarer.record.state === 'keep') {
                    record.state = 'keep';
                    record.reason = `needed at runtime by ${declarer.record.entry.name} (${declarer.kind} dependency)`;
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) {
            break;
        }
    }

    for (const record of records) {
        if (record.state === 'pending') {
            record.state = 'remove';
        }
    }

    const skipped = [];
    const deletedPackages = [];
    let deletedBytes = 0;
    const totalBefore = sizeOf(root);

    for (const record of records) {
        if (record.state === 'remove') {
            const bytes = removePath(record.entry.dir, options.apply);
            deletedBytes += bytes;
            deletedPackages.push({
                name: record.entry.name,
                dir: path.basename(record.entry.dir),
                path: record.entry.dir,
                bytes,
                rule: record.rule,
            });
            log(
                `  ${options.apply ? 'deleted' : 'would delete'} ${record.entry.dirName} (${bytes} bytes) via rule "${record.rule}"`,
            );
            continue;
        }
        if (record.reason) {
            skipped.push({
                name: record.entry.name,
                path: record.entry.dir,
                bytes: record.size,
                reason: record.reason,
            });
        }
    }

    // Files inside packages that must stay.
    const trimmedFiles = [];
    let trimmedBytes = 0;
    for (const record of records) {
        const rule = TRIM_RULES.get(record.entry.name);
        if (!rule || record.state === 'remove') {
            continue;
        }
        const targets = trimTargets(record.entry, rule.kind);
        if (targets.length === 0) {
            continue;
        }
        let bytes = 0;
        for (const target of targets) {
            const size = removePath(target, options.apply);
            bytes += size;
            trimmedFiles.push({
                name: record.entry.name,
                path: target,
                bytes: size,
                reason: rule.note,
            });
        }
        trimmedBytes += bytes;
        log(
            `  ${options.apply ? 'trimmed' : 'would trim'} ${targets.length} file(s) of ${record.entry.name} (${bytes} bytes): ${rule.note}`,
        );
    }

    const embeddedStatic = [];
    let embeddedStaticBytes = 0;
    if (options.dropEmbeddedStatic) {
        const seen = new Set();
        walk(root, (full, entry) => {
            if (!entry.isDirectory() || inNodeModules(full) || seen.has(full)) {
                return;
            }
            if (!/[\\/]\.next[\\/]static$/.test(full)) {
                return;
            }
            seen.add(full);
            const bytes = removePath(full, options.apply);
            embeddedStaticBytes += bytes;
            embeddedStatic.push({ path: full, bytes });
        });
        for (const item of embeddedStatic) {
            log(
                `  ${options.apply ? 'dropped' : 'would drop'} embedded static tree ${item.path} (${item.bytes} bytes), re-supplied by a later Dockerfile COPY`,
            );
        }
    }

    const danglingLinks = [];
    if (options.apply && deletedPackages.length > 0) {
        const removedDirs = new Set(
            records.filter((r) => r.state === 'remove').map((r) => r.entry.dir),
        );

        const visitLink = (link) => {
            let stat;
            try {
                stat = fs.lstatSync(link);
            } catch {
                return;
            }
            if (!stat.isSymbolicLink()) {
                return;
            }
            const resolved = path.resolve(path.dirname(link), fs.readlinkSync(link));
            if (removedDirs.has(resolved) && !fs.existsSync(resolved)) {
                try {
                    fs.unlinkSync(link);
                    danglingLinks.push(link);
                } catch {
                    /* a stale link is cosmetic, never a build failure */
                }
            }
        };

        const sweep = (dir) => {
            for (const scope of safeReadDir(dir)) {
                const first = path.join(dir, scope);
                if (scope.startsWith('@') && isDirectory(first) && !removedDirs.has(first)) {
                    for (const name of safeReadDir(first)) {
                        visitLink(path.join(first, name));
                    }
                    continue;
                }
                visitLink(first);
            }
        };

        // pnpm keeps dependency links inside every store entry, and the deployed
        // game-server tree keeps its own flat node_modules on top.
        for (const store of storeDirs) {
            for (const name of safeReadDir(store)) {
                const inner = path.join(store, name, 'node_modules');
                if (isDirectory(inner)) {
                    sweep(inner);
                }
            }
        }
        for (const flat of [
            path.join(root, 'node_modules'),
            path.join(root, 'common', 'temp', 'node_modules'),
        ]) {
            if (isDirectory(flat)) {
                sweep(flat);
            }
        }
    }

    const summary = {
        root,
        apply: options.apply,
        tier: options.tier,
        stores: storeDirs,
        scannedSourceFiles: scannedFiles.count,
        scannedSourceBytes: scannedFiles.bytes,
        storeEntryCount: records.length,
        totalBefore,
        totalAfter: options.apply
            ? sizeOf(root)
            : totalBefore - deletedBytes - trimmedBytes - embeddedStaticBytes,
        deletedBytes: deletedBytes + trimmedBytes + embeddedStaticBytes,
        buildToolDeletedBytes: deletedBytes,
        trimmedBytes,
        embeddedStaticBytes,
        deletedPackages: deletedPackages.sort((a, b) => b.bytes - a.bytes),
        trimmedFiles: trimmedFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 40),
        trimmedFileCount: trimmedFiles.length,
        embeddedStatic,
        skipped: skipped.sort((a, b) => b.bytes - a.bytes),
        manifestDeclarations: Object.fromEntries(
            [...manifestDeclarations]
                .filter(([name]) => records.some((r) => r.state === 'remove' && r.entry.name === name))
                .map(([name, sources]) => [name, sources]),
        ),
        danglingLinksRemoved: danglingLinks.length,
    };

    return summary;
}

function safeReadDir(dir) {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

async function verifyBoot(entryPath, options) {
    if (!fs.existsSync(entryPath)) {
        throw new Error(`verify-boot entry not found: ${entryPath}`);
    }

    const port = Number(process.env.BOX_PRUNE_BOOT_PORT) || 3457;
    const net = await import('node:net');
    const child = spawn(process.execPath, [entryPath], {
        cwd: path.dirname(entryPath),
        env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: String(port),
            HOSTNAME: '127.0.0.1',
            NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
        output += chunk;
    });
    child.stderr.on('data', (chunk) => {
        output += chunk;
    });

    let exited = null;
    child.on('exit', (code) => {
        exited = code;
    });
    child.on('error', (error) => {
        output += `\nspawn error: ${error.message}`;
        exited = -1;
    });

    const canConnect = () =>
        new Promise((resolve) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });
            socket.setTimeout(1000, () => {
                socket.destroy();
                resolve(false);
            });
        });

    const deadline = Date.now() + options.bootTimeoutMs;
    while (Date.now() < deadline) {
        if (await canConnect()) {
            child.kill('SIGKILL');
            return { ok: true, port, entry: entryPath, log: output.slice(-2000) };
        }
        if (exited !== null) {
            child.kill('SIGKILL');
            throw new Error(
                `standalone entry exited with code ${exited} before binding port ${port}:\n${output.slice(-6000)}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    child.kill('SIGKILL');
    throw new Error(
        `standalone entry did not bind port ${port} within ${options.bootTimeoutMs}ms:\n${output.slice(-6000)}`,
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const log = (line) => {
        if (!options.quiet) {
            process.stdout.write(`${line}\n`);
        }
    };
    const reports = [];

    for (const entry of options.roots) {
        const root = path.resolve(entry);
        if (!isDirectory(root)) {
            throw new Error(`Root is not a directory: ${root}`);
        }
        log(`\n== ${root}`);
        reports.push(pruneRoot(root, options, log));
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        apply: options.apply,
        tier: options.tier,
        strictManifests: options.strictManifests,
        deletedBytes: reports.reduce((total, item) => total + item.deletedBytes, 0),
        buildToolDeletedBytes: reports.reduce((total, item) => total + item.buildToolDeletedBytes, 0),
        trimmedBytes: reports.reduce((total, item) => total + item.trimmedBytes, 0),
        embeddedStaticBytes: reports.reduce((total, item) => total + item.embeddedStaticBytes, 0),
        totalBefore: reports.reduce((total, item) => total + item.totalBefore, 0),
        totalAfter: reports.reduce((total, item) => total + item.totalAfter, 0),
        skipped: reports.flatMap((item) => item.skipped),
        roots: reports,
    };

    if (options.verifyBoot) {
        const result = await verifyBoot(path.resolve(options.verifyBoot), options);
        summary.boot = { ok: result.ok, entry: result.entry, port: result.port };
        process.stdout.write(`\nboot gate passed: ${result.entry} bound port ${result.port}\n`);
    }

    process.stdout.write(
        `\n${options.apply ? 'APPLIED' : 'DRY-RUN'}: removed ${summary.deletedBytes} bytes ` +
            `(tools ${summary.buildToolDeletedBytes}, trimmed ${summary.trimmedBytes}, embedded static ${summary.embeddedStaticBytes}); ` +
            `${summary.skipped.length} candidate(s) kept; total ${summary.totalBefore} -> ${summary.totalAfter}\n`,
    );

    if (options.json) {
        const target = path.resolve(options.json);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
        process.stdout.write(`summary: ${target}\n`);
    }
}

await main();
