'use strict';

// This is a bounded pre-publication guard, not a full secret/PII audit.
// Diagnostics contain paths and rule names only, never matching values.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const maxTextBytes = 2 * 1024 * 1024;
const publicEnvironment = {
    'apps/game/.env.development': {
        NEXT_PUBLIC_APP_ENV: 'development',
        NEXT_PUBLIC_APP_EDITION: 'createra',
        NEXT_PUBLIC_APP_REGION: 'oversea',
    },
    'apps/game/rusty/.env.prod': { RUSTY_CONFIG_URL: '' },
};

function forbiddenPath(file) {
    return (
        path.basename(file) === '.runtime.env' ||
        /^(?:apps\/(?:migrator|license-server)\/|box-local-engine-internal\/|\.internal\/|\.private\/|license\/)/.test(
            file,
        ) ||
        /(?:^|\/)(?:node_modules|\.local|diagnostics|\.next[^/]*|private\/tmp)(?:\/|$)/.test(
            file,
        ) ||
        /^internals\/dev-certs\/certs\//.test(file) ||
        (/^(?:apps\/local-engine\/(?:projects|backups|runtime-cache|play-worlds)\/|apps\/voxa\/data\/)/.test(
            file,
        ) &&
            !file.endsWith('/.gitkeep')) ||
        /\.(?:boxlic|p12|pfx|sqlite3?|db|log|tar\.gz)$/i.test(file) ||
        /(?:^|\/)[^/]*private-key[^/]*\.pem$/i.test(file)
    );
}

function inspect(file, text) {
    const findings = [];
    if (forbiddenPath(file)) {
        findings.push('private-or-runtime-path');
    }
    if (/^apps\/local-engine\/data\/blobs\//.test(file)) {
        try {
            const value = JSON.parse(text);
            if (value && !Array.isArray(value) && typeof value === 'object') {
                if (
                    [
                        'owner',
                        'users',
                        'holderId',
                        'deviceId',
                        'collaborators',
                        'versionControl',
                    ].some((key) => Object.hasOwn(value, key)) ||
                    Object.keys(value).some((key) => /^\d+$/.test(key) && value[key]?.createdAt)
                ) {
                    findings.push('embedded-project-or-user-state');
                }
            }
        } catch {
            // Ordinary script and binary-resource text is not JSON state.
        }
        if (/portal-backstage\.(?:dao3|box3)\.fun/.test(text)) {
            findings.push('internal-business-script');
        }
    }
    const basename = path.basename(file);
    if (basename === 'package.json') {
        try {
            if (['@box/migrator', '@box/license-server'].includes(JSON.parse(text).name)) {
                findings.push('internal-project-manifest');
            }
        } catch {
            // Only valid manifests can declare an internal project name.
        }
    }
    for (const line of text.split('\n')) {
        const assignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
        if (!assignment) {
            continue;
        }
        const value = assignment[2].trim().replace(/^['"]|['"]$/g, '');
        if (
            !value ||
            /change|fixture|example|placeholder|dummy|sample|test|development|local-box|\$\{/i.test(
                value,
            )
        ) {
            continue;
        }
        if (/(?:PASSWORD|TOKEN|SECRET|API_KEY|ACCESS_KEY)$/.test(assignment[1])) {
            findings.push('embedded-environment-credential');
        }
        if (/^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//.test(value)) {
            try {
                if (new URL(value).password) {
                    findings.push('credential-database-url');
                }
            } catch {
                // Only parsable database URLs expose a password field.
            }
        }
    }
    if (publicEnvironment[file]) {
        const expected = publicEnvironment[file];
        for (const line of text.split('\n')) {
            const clean = line.trim();
            if (!clean || clean.startsWith('#')) {
                continue;
            }
            const match = /^([A-Z0-9_]+)=(.*)$/.exec(clean);
            if (
                !match ||
                !(match[1] in expected) ||
                match[2].trim().replace(/^['"]|['"]$/g, '') !== expected[match[1]]
            ) {
                findings.push('unexpected-public-environment-value');
                break;
            }
        }
    } else if (/^\.env(?:\.|$)/.test(basename) && !/\.example$/.test(basename)) {
        findings.push('private-environment-file');
    }
    if (
        /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(
            text,
        )
    ) {
        findings.push('private-key-material');
    }
    const provider =
        /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;
    for (const match of text.matchAll(provider)) {
        if (!/EXAMPLE|PLACEHOLDER/i.test(match[0])) {
            findings.push('provider-credential');
        }
    }
    if (/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/.test(text)) {
        findings.push('embedded-jwt');
    }
    const literal =
        /\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|apiKey|secretKey|signingSecret|password)\s*["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{32,})["']/g;
    for (const match of text.matchAll(literal)) {
        if (
            !/fixture|example|change|dummy|sample|test/i.test(match[1]) &&
            !/^(.)\1{15,}$/.test(match[1]) &&
            !/^[A-Z_]+$/.test(match[1])
        ) {
            findings.push('literal-credential');
        }
    }
    return [...new Set(findings)];
}

function git(args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function unsafeLink(file, target) {
    const relative = path.relative(root, path.resolve(root, path.dirname(file), target));
    return relative.startsWith('..') || forbiddenPath(relative.split(path.sep).join('/'));
}

function main() {
    const staged = process.argv.includes('--staged');
    const files = staged
        ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
              .split('\0')
              .filter(Boolean)
        : [
              ...new Set(
                  git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
                      .split('\0')
                      .filter(Boolean),
              ),
          ];
    const violations = [];
    let scanned = 0,
        skipped = 0;
    for (const file of files) {
        let buffer;
        if (staged) {
            const size = Number(git(['cat-file', '-s', `:${file}`]).trim());
            if (size > maxTextBytes) {
                if (forbiddenPath(file)) {
                    violations.push({ file, rule: 'private-or-runtime-path' });
                }
                skipped++;
                continue;
            }
            buffer = execFileSync('git', ['show', `:${file}`], {
                cwd: root,
                maxBuffer: maxTextBytes + 1024,
            });
            if (git(['ls-files', '--stage', '--', file]).startsWith('120000 ')) {
                if (unsafeLink(file, buffer.toString('utf8'))) {
                    violations.push({ file, rule: 'private-or-external-symlink' });
                }
                continue;
            }
        } else {
            const full = path.join(root, file);
            let stat;
            try {
                stat = fs.lstatSync(full);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            if (stat.isSymbolicLink()) {
                if (unsafeLink(file, fs.readlinkSync(full))) {
                    violations.push({ file, rule: 'private-or-external-symlink' });
                }
                continue;
            }
            if (!stat.isFile()) {
                continue;
            }
            if (stat.size > maxTextBytes) {
                if (forbiddenPath(file)) {
                    violations.push({ file, rule: 'private-or-runtime-path' });
                }
                skipped++;
                continue;
            }
            buffer = fs.readFileSync(full);
        }
        if (buffer.length > maxTextBytes || buffer.includes(0)) {
            if (forbiddenPath(file)) {
                violations.push({ file, rule: 'private-or-runtime-path' });
            }
            skipped++;
            continue;
        }
        scanned++;
        for (const rule of inspect(file, buffer.toString('utf8'))) {
            violations.push({ file, rule });
        }
    }
    for (const violation of violations) {
        console.error(`${violation.file}: ${violation.rule} (value redacted)`);
    }
    console.log(
        `Public repository guard: ${scanned} text files checked; ${skipped} binary/large files content not scanned; ${violations.length} findings`,
    );
    if (violations.length) {
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}
module.exports = { forbiddenPath, inspect };
