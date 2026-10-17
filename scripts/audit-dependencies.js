'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const severities = ['info', 'low', 'moderate', 'high', 'critical'];

function parseAuditReport(output) {
    // Rush writes its version and command banner before pnpm's JSON document.
    const starts = [...String(output).matchAll(/^\s*\{/gm)];
    for (const { index } of starts) {
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let end = String(output).indexOf('{', index); end < output.length; end++) {
            const char = output[end];
            if (quoted) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    quoted = false;
                }
            } else if (char === '"') {
                quoted = true;
            } else if (char === '{') {
                depth++;
            } else if (char === '}' && --depth === 0) {
                try {
                    const value = JSON.parse(output.slice(index, end + 1));
                    if (value.advisories && value.metadata?.vulnerabilities) {
                        return value;
                    }
                } catch {
                    // A non-JSON banner is not an audit document.
                }
                break;
            }
        }
    }
    throw new Error('Dependency audit did not return a valid pnpm JSON report');
}

function validateExceptions(config, now) {
    if (config.formatVersion !== 1 || !Array.isArray(config.exceptions)) {
        throw new Error('Unsupported dependency audit exception configuration');
    }
    const seen = new Set();
    for (const entry of config.exceptions) {
        if (
            !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.advisory || '') ||
            !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(entry.package || '') ||
            !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(entry.version || '') ||
            !entry.reason?.trim() ||
            !Array.isArray(entry.evidence) ||
            !entry.evidence.length ||
            entry.evidence.some((value) => typeof value !== 'string' || !value.trim()) ||
            !Array.isArray(entry.paths) ||
            !entry.paths.length ||
            entry.paths.some(
                (value) => typeof value !== 'string' || !value || /[\s*?]/.test(value),
            ) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires || '')
        ) {
            throw new Error(
                'Audit exceptions require an advisory, exact package/version/paths, evidence, reason and expiry',
            );
        }
        const expiry = new Date(`${entry.expires}T00:00:00Z`);
        if (
            !Number.isFinite(expiry.getTime()) ||
            expiry.toISOString().slice(0, 10) !== entry.expires
        ) {
            throw new Error(`Invalid audit exception expiry for ${entry.advisory}`);
        }
        if (expiry <= now) {
            throw new Error(`Audit exception expired: ${entry.advisory}`);
        }
        const key = `${entry.advisory}:${entry.package}:${entry.version}`;
        if (seen.has(key)) {
            throw new Error(`Duplicate audit exception: ${entry.advisory}`);
        }
        seen.add(key);
    }
}

function evaluateAudit(report, exceptions) {
    const counts = report.metadata.vulnerabilities;
    if (
        Array.isArray(report.advisories) ||
        typeof report.advisories !== 'object' ||
        severities.some(
            (severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0,
        )
    ) {
        throw new Error('Dependency audit returned an unsupported report schema');
    }
    const blocked = [];
    const accepted = [];
    const observed = { high: 0, critical: 0 };
    for (const advisory of Object.values(report.advisories)) {
        if (!severities.includes(advisory.severity)) {
            throw new Error('Dependency audit returned an unknown severity');
        }
        if (!['high', 'critical'].includes(advisory.severity)) {
            continue;
        }
        observed[advisory.severity]++;
        const id = advisory.github_advisory_id;
        const packageName = advisory.module_name;
        if (
            !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id || '') ||
            !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName || '') ||
            !Array.isArray(advisory.findings) ||
            !advisory.findings.length
        ) {
            throw new Error('Dependency audit returned an incomplete high/critical advisory');
        }
        for (const finding of advisory.findings) {
            if (
                typeof finding.version !== 'string' ||
                !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(finding.version) ||
                !Array.isArray(finding.paths) ||
                !finding.paths.length ||
                finding.paths.some((value) => typeof value !== 'string' || !value)
            ) {
                throw new Error('Dependency audit returned an incomplete dependency finding');
            }
            const exception = exceptions.find(
                (entry) =>
                    entry.advisory === id &&
                    entry.package === packageName &&
                    entry.version === finding.version,
            );
            for (const dependencyPath of finding.paths) {
                const label = `${advisory.severity} ${id} ${packageName}@${finding.version}`;
                // Critical vulnerabilities always block, including a severity escalation
                // of an advisory that previously had a reviewed high-level exception.
                if (advisory.severity === 'high' && exception?.paths.includes(dependencyPath)) {
                    accepted.push(`${label} (reviewed path; expires ${exception.expires})`);
                } else {
                    blocked.push(label);
                }
            }
        }
    }
    if (observed.high !== counts.high || observed.critical !== counts.critical) {
        throw new Error('Dependency audit severity totals do not match its advisory records');
    }
    return { counts, blocked, accepted };
}

function auditDependencies({ run = spawnSync, config, now = new Date(), log = console.log } = {}) {
    const exceptions = config || { formatVersion: 1, exceptions: [] };
    validateExceptions(exceptions, now);
    const execution = run(
        process.execPath,
        [
            path.join(root, 'common/scripts/install-run-rush-pnpm.js'),
            'audit',
            '--prod',
            '--audit-level',
            'high',
            '--json',
        ],
        { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (execution.error || ![0, 1].includes(execution.status)) {
        throw new Error(
            'Dependency audit command failed; check registry connectivity and installed dependencies',
        );
    }
    // Exit 1 is normal when pnpm finds vulnerabilities, including lower levels. Never treat it as
    // a parse error or turn a network/registry error into a successful audit.
    const result = evaluateAudit(parseAuditReport(execution.stdout), exceptions.exceptions);
    if (execution.status === 1 && severities.every((severity) => !result.counts[severity])) {
        throw new Error('Dependency audit command failed without vulnerability records');
    }
    log(
        `Production audit: ${result.counts.critical} critical, ${result.counts.high} high, ${result.counts.moderate} moderate, ${result.counts.low} low`,
    );
    for (const entry of result.accepted) {
        log(`Exception: ${entry}`);
    }
    if (result.blocked.length) {
        for (const entry of new Set(result.blocked)) {
            log(`Blocked: ${entry}`);
        }
        throw new Error(
            'Production dependency audit failed: unreviewed high or critical vulnerabilities',
        );
    }
    log('Production dependency audit passed');
    return result;
}

if (require.main === module) {
    try {
        auditDependencies();
    } catch (error) {
        // Raw subprocess output may contain registry URLs or credentials.
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { auditDependencies };
