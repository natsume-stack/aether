'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let gnuTar;

/**
 * Windows GNU tar (the one Git for Windows ships) has two pathologies when a
 * path like `C:\Users\...` reaches it:
 *
 *   1. it parses `C:` as a remote host (`tar: Cannot connect to C:`)
 *   2. `--force-local` stops (1), but the argument still gets rewritten to
 *      `C\:\Users\...` and tar then fails with `Cannot open`
 *
 * Both disappear if tar never sees a drive letter: run it in the directory it
 * needs and pass relative POSIX paths instead. That is what prepareTar does.
 * `--force-local` stays as a belt-and-braces for arguments that cannot be made
 * relative (different drive/UNC); those still refuse loudly rather than write
 * somewhere unexpected.
 */
function isGnuTar() {
    if (gnuTar === undefined) {
        const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
        gnuTar = /GNU tar/i.test(`${probe.stdout || ''}${probe.stderr || ''}`);
    }
    return gnuTar;
}

function sameRoot(a, b) {
    return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

function toPosix(value) {
    return value.split(path.sep).join('/');
}

/** A path-ish argument we may rewrite: absolute and not an option. */
function isAbsoluteArgument(value) {
    return typeof value === 'string' && !value.startsWith('-') && path.isAbsolute(value);
}

/** Only existing paths are trusted as a hint for the working directory. */
function isPathArgument(value) {
    return isAbsoluteArgument(value) && fs.existsSync(value);
}

/**
 * Returns `{ args, cwd }` for spawnSync('tar', ...). Never mutates the caller's
 * array. On non-Windows this is a pass-through.
 */
function prepareTar(args) {
    if (process.platform !== 'win32') return { args: args.slice(), cwd: undefined };

    const work = args.slice();
    let cwd;
    const dashC = work.indexOf('-C');
    if (dashC !== -1 && typeof work[dashC + 1] === 'string') {
        cwd = work[dashC + 1];
        work.splice(dashC, 2);
    }

    const roots = work.filter(isPathArgument).map((value) => path.dirname(value));
    if (!cwd) cwd = roots[0];
    if (!cwd || !fs.existsSync(cwd)) {
        return { args: isGnuTar() ? ['--force-local', ...args] : args.slice(), cwd: undefined };
    }

    const rewritten = work.map((value) => {
        if (!isAbsoluteArgument(value)) return value;
        if (!sameRoot(value, cwd)) return value;
        const relative = path.relative(cwd, value);
        // `..` prefixes are fine: tar resolves them against cwd.
        return relative === '' ? '.' : toPosix(relative);
    });

    const stillAbsolute = rewritten.some(isAbsoluteArgument);
    return {
        args: stillAbsolute && isGnuTar() ? ['--force-local', ...rewritten] : rewritten,
        cwd,
    };
}

module.exports = { prepareTar };
