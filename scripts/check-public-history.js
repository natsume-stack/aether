'use strict';

// History checks are explicit: local development may keep a private recovery
// history, while a repository prepared for publication must pass this guard.
// Never print object contents or credential values.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { forbiddenPath, inspect } = require('./check-public-repository');

function checkPublicHistory(repository) {
    const git = (args, options = {}) =>
        execFileSync('git', args, {
            cwd: repository,
            maxBuffer: 512 * 1024 * 1024,
            ...options,
        });
    if (git(['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
        throw new Error(
            'Public history checks require a complete clone; fetch the full history first',
        );
    }
    const refs = git(['for-each-ref', '--format=%(refname) %(objecttype)'], { encoding: 'utf8' });
    const problems = [];
    for (const line of refs.trim().split('\n').filter(Boolean)) {
        const [name, kind] = line.split(' ');
        if (!/^refs\/(?:heads|tags|remotes)\//.test(name) || !['commit', 'tag'].includes(kind)) {
            problems.push(`${name}: non-public-reference`);
        }
    }
    const objects = new Map();
    const pathsByBlob = new Map();
    const rememberPath = (id, file) => {
        if (!file || /^0+$/.test(id)) {
            return;
        }
        if (!pathsByBlob.has(id)) {
            pathsByBlob.set(id, new Set());
        }
        pathsByBlob.get(id).add(file);
        if (forbiddenPath(file)) {
            problems.push(`${file}: private-or-runtime-path`);
        }
    };
    for (const line of git(['rev-list', '--objects', '--all'], { encoding: 'utf8' }).split('\n')) {
        const offset = line.indexOf(' ');
        const id = offset < 0 ? line : line.slice(0, offset);
        const file = offset < 0 ? '' : line.slice(offset + 1);
        if (!id) {
            continue;
        }
        objects.set(id, file);
        rememberPath(id, file);
    }
    // rev-list prints each object once and may label a renamed blob only with
    // its newest path. Raw, unrenamed changes preserve every historical role,
    // including the old path of a deletion or rename. NUL delimiters retain
    // spaces and quoted characters in filenames without Git's display quoting.
    const changes = git([
        'log',
        '--all',
        '--raw',
        '--no-abbrev',
        '--format=',
        '--no-renames',
        '--diff-merges=separate',
        '-z',
    ])
        .toString('utf8')
        .split('\0');
    for (let index = 0; index < changes.length; index += 1) {
        const header = /^:[0-7]{6} [0-7]{6} ([a-f0-9]+) ([a-f0-9]+) [A-Z]\d*$/.exec(
            changes[index].trim(),
        );
        if (!header) {
            continue;
        }
        const file = changes[++index];
        if (file === undefined) {
            throw new Error('Incomplete Git history path stream');
        }
        rememberPath(header[1], file);
        rememberPath(header[2], file);
    }
    const input = [...objects.keys()].join('\n') + '\n';
    const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        input,
        encoding: 'utf8',
    })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [id, type, size] = line.split(' ');
            return { id, type, size: Number(size) };
        });
    const blobs = metadata.filter(({ type, size }) => type === 'blob' && size <= 8 * 1024 * 1024);
    const skippedLarge = metadata.filter(
        ({ type, size }) => type === 'blob' && size > 8 * 1024 * 1024,
    ).length;
    const batch = blobs.length
        ? git(['cat-file', '--batch'], { input: blobs.map(({ id }) => id).join('\n') + '\n' })
        : Buffer.alloc(0);
    let offset = 0;
    let scanned = 0;
    let skippedBinary = 0;
    for (const blob of blobs) {
        const headerEnd = batch.indexOf(10, offset);
        if (headerEnd < 0) {
            throw new Error('Incomplete Git history object stream');
        }
        const header = batch.subarray(offset, headerEnd).toString('ascii').split(' ');
        if (header[0] !== blob.id || Number(header[2]) !== blob.size) {
            throw new Error('Invalid Git history object stream');
        }
        const body = batch.subarray(headerEnd + 1, headerEnd + 1 + blob.size);
        if (body.length !== blob.size) {
            throw new Error('Truncated Git history object');
        }
        offset = headerEnd + blob.size + 2;
        if (body.includes(0)) {
            skippedBinary += 1;
            continue;
        }
        scanned += 1;
        const filenames = pathsByBlob.get(blob.id) || new Set(['(unlabelled object)']);
        const text = body.toString('utf8');
        for (const file of filenames) {
            for (const rule of inspect(file, text)) {
                problems.push(`${file}: ${rule} [${blob.id.slice(0, 12)}]`);
            }
        }
    }
    return { scanned, skippedBinary, skippedLarge, problems: [...new Set(problems)] };
}

if (require.main === module) {
    try {
        const repository = path.resolve(process.argv[2] || path.join(__dirname, '..'));
        const result = checkPublicHistory(repository);
        for (const problem of result.problems) {
            console.error(problem);
        }
        console.log(
            `Public history guard: ${result.scanned} text blobs; ${result.skippedBinary} binary and ${result.skippedLarge} large blobs not content-scanned; ${result.problems.length} findings`,
        );
        if (result.problems.length) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(`Public history check failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { checkPublicHistory };
