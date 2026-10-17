/**
 * Shared primitives for the BOX3 image size gates. `check-image-budget.mjs`
 * owns both the byte budget (`common/config/box3-image-budget.json`) and the
 * build-tool blacklist (`common/config/box3-image-blacklist.json`).
 *
 * The gates must run on a bare Node runtime with no package manager and no
 * third-party dependency, because the private/self-hosted deployments this
 * repository targets cannot assume a populated Rush install. Everything here
 * therefore uses only `node:fs`, `node:path` and `node:child_process`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Exit code: the gate ran and found a violation. */
export const EXIT_VIOLATION = 1;
/** Exit code: bad configuration or bad invocation. */
export const EXIT_USAGE = 2;
/** Exit code: nothing could be measured (no images, no catalog). */
export const EXIT_NO_DATA = 3;

/** Parse `--key value`, `--key=value` and bare `--flag` arguments. */
export function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            throw new Error(`位置参数不被支持：${argument}`);
        }
        const name = argument.slice(2);
        const equals = name.indexOf('=');
        if (equals >= 0) {
            options[name.slice(0, equals)] = name.slice(equals + 1);
            continue;
        }
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
            options[name] = true;
            continue;
        }
        options[name] = next;
        index += 1;
    }
    return options;
}

/** Read and parse a JSON file, reporting the path instead of throwing raw. */
export function readJsonFile(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`缺少文件：${file}`);
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${file}: ${(error && error.message) || 'invalid JSON'}`);
    }
}

/** Require a plain object and label it for readable failures. */
export function requireObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是 JSON 对象`);
    }
    return value;
}

export function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${label} 必须是非空字符串`);
    }
    if (/[\n\r\t"'$`\\]/.test(value)) {
        throw new Error(`${label} 含被禁止的字符（换行/制表/引号）：${value}`);
    }
    return value.trim();
}

export function requireSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} 必须是非负整数，收到 ${String(value)}`);
    }
    return value;
}

/** `678713391` -> `678,713,391`. */
export function formatInt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return String(value);
    }
    return Math.round(value).toLocaleString('en-US');
}

/** `678713391` -> `647.20 MiB`. */
export function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'n/a';
    }
    let cursor = Math.abs(value);
    let unit = 0;
    while (cursor >= 1024 && unit < BINARY_UNITS.length - 1) {
        cursor /= 1024;
        unit += 1;
    }
    const rendered = unit === 0 ? String(Math.round(cursor)) : cursor.toFixed(2);
    return `${value < 0 ? '-' : ''}${rendered} ${BINARY_UNITS[unit]}`;
}

/** Signed percentage of `actual` relative to `budget`. */
export function formatDelta(actual, budget) {
    if (!Number.isFinite(actual) || !Number.isFinite(budget) || budget === 0) {
        return 'n/a';
    }
    const percent = ((actual - budget) / budget) * 100;
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/**
 * Render an aligned ASCII table. `columns` is `[{ title, align }]` and rows
 * are arrays of strings, so CI logs and offline reports share one renderer.
 */
export function renderTable(columns, rows) {
    const cells = rows.map((row) => columns.map((_, index) => String(row[index] ?? '')));
    const widths = columns.map((column, index) =>
        Math.max(column.title.length, ...cells.map((row) => row[index].length)),
    );
    const line = (values) =>
        values
            .map((value, index) =>
                columns[index].align === 'right'
                    ? value.padStart(widths[index])
                    : value.padEnd(widths[index]),
            )
            .join('  ')
            .trimEnd();
    const separator = widths.map((width) => '-'.repeat(width)).join('  ');
    return [line(columns.map((column) => column.title)), separator, ...cells.map(line)].join('\n');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const globCache = new Map();

/**
 * Compile a path glob (single star, question mark, double star) into an
 * anchored regular expression. A single star never crosses a slash, a double
 * star swallows whole segments and may match none, which is what makes a
 * leading "double star slash" mean any depth below the root.
 */
export function globToRegExp(glob) {
    const cached = globCache.get(glob);
    if (cached) {
        return cached;
    }
    const segments = String(glob).split('/');
    let source = '^';
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const last = index === segments.length - 1;
        if (segment === '**') {
            source += last ? '.*' : '(?:[^/]+/)*';
            continue;
        }
        let rendered = '';
        for (const character of segment) {
            if (character === '*') {
                rendered += '[^/]*';
            } else if (character === '?') {
                rendered += '[^/]';
            } else {
                rendered += escapeRegExp(character);
            }
        }
        source += rendered;
        if (!last) {
            source += '/';
        }
    }
    const compiled = new RegExp(`${source}$`);
    globCache.set(glob, compiled);
    return compiled;
}

export function matchGlob(glob, relativePath) {
    return globToRegExp(glob).test(relativePath);
}

/** Run a command without a shell and normalise the "binary is absent" case. */
export function runCommand(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    if (result.error) {
        return {
            ok: false,
            unavailable: true,
            reason:
                result.error.code === 'ENOENT'
                    ? `${command} 不存在（可用 --docker-bin 指定路径）`
                    : result.error.message,
            stdout: '',
            stderr: '',
            status: null,
        };
    }
    return {
        ok: result.status === 0,
        unavailable: false,
        reason: '',
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        status: result.status,
    };
}

/** Depth-first walk that yields every entry below `root` with its size. */
export function walkTree(root, visit) {
    const stack = [root];
    while (stack.length > 0) {
        const directory = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            let stats = null;
            try {
                stats = entry.isSymbolicLink() ? fs.lstatSync(absolute) : fs.statSync(absolute);
            } catch {
                continue;
            }
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            visit({
                absolute,
                relative,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
                size: stats.size,
            });
            if (entry.isDirectory()) {
                stack.push(absolute);
            }
        }
    }
}

/** Sum the bytes of all regular files under `target` (following directory). */
export function subtreeBytes(target) {
    let stats;
    try {
        stats = fs.statSync(target);
    } catch {
        return 0;
    }
    if (stats.isFile()) {
        return stats.size;
    }
    if (!stats.isDirectory()) {
        return 0;
    }
    let total = 0;
    walkTree(target, (entry) => {
        if (entry.isFile) {
            total += entry.size;
        }
    });
    return total;
}

export function countSubtreeFiles(target) {
    if (!fs.existsSync(target)) {
        return 0;
    }
    if (!fs.statSync(target).isDirectory()) {
        return 1;
    }
    let total = 0;
    walkTree(target, (entry) => {
        if (entry.isFile) {
            total += 1;
        }
    });
    return total;
}

/** Write a machine-readable gate report for CI artifacts and other lanes. */
export function writeJsonReport(file, value) {
    if (typeof file !== 'string' || file.trim() === '') {
        return;
    }
    const absolute = path.resolve(file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    console.log(`报告已写入：${absolute}`);
}

/** `a,b , c` -> `['a', 'b', 'c']`. */
export function parseList(value) {
    if (value === undefined || value === true || value === '') {
        return [];
    }
    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

/** GitHub Actions friendly annotation without importing any Actions toolkit. */
export function notice(message) {
    console.log(`::notice::${message}`);
}

export function warning(message) {
    console.error(`::warning::${message}`);
}
