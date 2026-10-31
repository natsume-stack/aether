/**
 * Regression tests for the "VOX 识别码一直动态刷新" bug (fixed 2026-10-25).
 *
 * Root cause: readStore() returned a freshly generated workspace entry (new
 * random code) when agent-access.json was missing and never persisted it, so
 * the panel regenerated the code on every poll and join always failed.
 *
 * VOXA_DATA_PATH is read once at module load of local-voxa-store, so it must
 * be set BEFORE the dynamic import below.
 *
 * Standalone: node --experimental-strip-types server/agent-access.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { registerHooks } from 'node:module';

// Resolve extensionless relative imports to .ts sources (same trick as
// apps/game/server/creator-api-security.test.ts in standalone mode).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxa-agent-access-test-'));
process.env.VOXA_DATA_PATH = tempDir;

const { joinVoxaByCode, rotateVoxaCode, voxaAgentPanelState } = await import('./agent-access.ts');

const tests: Array<[string, () => Promise<void>]> = [
  ['fresh workspace: code stable across reads and persisted', async () => {
    const s1 = voxaAgentPanelState();
    const s2 = voxaAgentPanelState();
    assert.equal(s1.code, s2.code, 'code must not regenerate between polls');
    assert.match(s1.code, /^VOX-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const file = path.join(tempDir, 'agent-access.json');
    assert.ok(fs.existsSync(file), 'store must be persisted on first read');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.workspace.code, s1.code, 'persisted code must equal the panel code');
  }],

  ['join with the panel code succeeds', async () => {
    const { code } = voxaAgentPanelState();
    const join = await joinVoxaByCode({ code, name: 'zcode' });
    assert.ok(join.ok, 'join must succeed with the stable panel code');
    assert.ok(join.ok && join.token.startsWith('agx_'));
  }],

  ['rotate invalidates the old code only', async () => {
    const before = voxaAgentPanelState().code;
    const after = await rotateVoxaCode();
    assert.notEqual(after, before);
    assert.equal((await joinVoxaByCode({ code: before, name: 'x' })).ok, false);
    assert.equal((await joinVoxaByCode({ code: after, name: 'x' })).ok, true);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${(error as Error).message}`);
  }
}
fs.rmSync(tempDir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log('agent-access (voxa) regression suite PASS');
