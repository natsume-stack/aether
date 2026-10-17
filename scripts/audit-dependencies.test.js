'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { auditDependencies } = require('./audit-dependencies');

const reviewed = {
    formatVersion: 1,
    exceptions: [
        {
            advisory: 'GHSA-aaaa-bbbb-cccc',
            package: 'braces',
            version: '3.0.3',
            paths: ['apps__build-tool>globby>braces'],
            expires: '2026-11-13',
            reason: 'Fixture for a reviewed build-tool dependency path.',
            evidence: ['https://example.test/advisory'],
        },
    ],
};
const now = new Date('2026-10-14T12:00:00Z');
const entry = reviewed.exceptions[0];

function report(advisories = []) {
    const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const advisory of advisories) {
        vulnerabilities[advisory.severity]++;
    }
    return {
        advisories: Object.fromEntries(advisories.map((advisory, i) => [String(i), advisory])),
        metadata: { vulnerabilities },
    };
}

function vulnerability(changes = {}) {
    return {
        github_advisory_id: entry.advisory,
        module_name: entry.package,
        severity: 'high',
        findings: [{ version: entry.version, paths: entry.paths }],
        ...changes,
    };
}

function execute(audit, config = reviewed, overrides = {}) {
    const output = [];
    const result = auditDependencies({
        config,
        now,
        log: (line) => output.push(line),
        run(command, args, options) {
            assert.equal(command, process.execPath);
            assert.deepEqual(args.slice(1), ['audit', '--prod', '--audit-level', 'high', '--json']);
            assert.equal(options.encoding, 'utf8');
            return {
                status:
                    audit.metadata.vulnerabilities.high || audit.metadata.vulnerabilities.critical
                        ? 1
                        : 0,
                stdout: `The Rush configuration requests a pinned version\nInvoking rush-pnpm audit\n${JSON.stringify(audit)}\n`,
                ...overrides,
            };
        },
    });
    return { result, output };
}

test('the CI entry point needs no exception file and blocks high vulnerabilities by default', () => {
    const run = (audit) =>
        auditDependencies({
            now,
            log() {},
            run() {
                return { status: 0, stdout: JSON.stringify(audit) };
            },
        });
    assert.equal(run(report()).blocked.length, 0);
    assert.throws(() => run(report([vulnerability()])), /unreviewed high or critical/);
});

test('accepts a clean production audit with the Rush banner and reports lower severities', () => {
    const audit = report();
    audit.metadata.vulnerabilities.low = 2;
    audit.metadata.vulnerabilities.moderate = 3;
    const { result, output } = execute(audit);
    assert.equal(result.blocked.length, 0);
    assert.ok(output[0].includes('3 moderate, 2 low'));
});

test('accepts audit exit 1 when the report contains only lower-severity vulnerabilities', () => {
    const audit = report();
    audit.metadata.vulnerabilities.moderate = 2;
    const { result } = execute(audit, reviewed, { status: 1 });
    assert.equal(result.blocked.length, 0);
});

test('accepts only the reviewed high advisory path/version, despite audit exit 1', () => {
    const { result, output } = execute(report([vulnerability()]));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.blocked.length, 0);
    assert.ok(output.some((line) => line.includes(`expires ${entry.expires}`)));
});

test('new high vulnerabilities block the same CI entry point', () => {
    assert.throws(
        () =>
            execute(
                report([
                    vulnerability({
                        github_advisory_id: 'GHSA-dddd-eeee-ffff',
                    }),
                ]),
            ),
        /unreviewed high or critical/,
    );
});

test('critical severity always blocks, even for a formerly reviewed advisory', () => {
    assert.throws(
        () => execute(report([vulnerability({ severity: 'critical' })])),
        /unreviewed high or critical/,
    );
});

test('adding an unreviewed runtime path to the same package blocks', () => {
    assert.throws(
        () =>
            execute(
                report([
                    vulnerability({
                        findings: [
                            {
                                version: entry.version,
                                paths: [...entry.paths, 'apps__game>braces'],
                            },
                        ],
                    }),
                ]),
            ),
        /unreviewed high or critical/,
    );
});

test('the exception never covers another installed version', () => {
    assert.throws(
        () =>
            execute(
                report([
                    vulnerability({
                        findings: [{ version: '3.0.2', paths: entry.paths }],
                    }),
                ]),
            ),
        /unreviewed high or critical/,
    );
});

test('expired exceptions fail even after an advisory disappears', () => {
    const config = structuredClone(reviewed);
    config.exceptions[0].expires = '2026-10-14';
    assert.throws(() => execute(report(), config), /exception expired/);
});

test('exceptions require exact scope and documented evidence', () => {
    for (const mutation of [
        (config) => {
            config.exceptions[0].paths = ['*'];
        },
        (config) => {
            config.exceptions[0].reason = '';
        },
        (config) => {
            config.exceptions[0].evidence = [];
        },
    ]) {
        const config = structuredClone(reviewed);
        mutation(config);
        assert.throws(() => execute(report(), config), /exact package\/version\/paths/);
    }
});

test('registry errors and command errors fail without printing credential-bearing output', () => {
    for (const overrides of [
        { status: 1, stdout: '{"error":{"message":"token=must-not-print"}}' },
        { status: 2, stderr: 'Authorization: must-not-print' },
        { status: 1, stdout: 'Registry URL https://user:must-not-print@example.test failed' },
        { error: new Error('must-not-print') },
    ]) {
        assert.throws(
            () => execute(report(), reviewed, overrides),
            (error) => !error.message.includes('must-not-print') && /audit/.test(error.message),
        );
    }
});

test('incomplete vulnerability totals cannot produce a green audit', () => {
    const audit = report();
    audit.metadata.vulnerabilities.high = 1;
    assert.throws(() => execute(audit), /totals do not match/);
    assert.throws(
        () => execute(report(), reviewed, { status: 1 }),
        /without vulnerability records/,
    );
});
