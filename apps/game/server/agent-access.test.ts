/**
 * Regression tests for the "识别码一直动态刷新" bug (fixed 2026-10-25).
 *
 * Root cause: ensureMapAgentAccess only persisted the store when the storage
 * file did not exist yet. With the file present but the queried project entry
 * missing, every panel poll generated a throwaway new code and join always
 * failed with INVALID_CODE.
 *
 * Standalone: node --experimental-strip-types server/agent-access.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  authenticateMapAgent,
  ensureMapAgentAccess,
  joinMapByCode,
  mapAgentPanelState,
  recordMapAgentAction,
  redactAgentSecrets,
  revokeMapAgent,
  rotateMapCode,
} from './agent-access.ts';

async function withTempStore(run: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-test-'));
  const file = path.join(dir, 'agent-access.json');
  const previous = process.env.BOX_AGENT_ACCESS_PATH;
  process.env.BOX_AGENT_ACCESS_PATH = file;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.BOX_AGENT_ACCESS_PATH;
    else process.env.BOX_AGENT_ACCESS_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ['entry created while file exists is persisted (regression)', async () => {
    await withTempStore(async () => {
      // 先让文件存在（只含 project-a 的 entry），模拟“文件已有、新工程 entry 不在”的场景。
      const first = await ensureMapAgentAccess('project-a');
      const seeded = JSON.parse(fs.readFileSync(process.env.BOX_AGENT_ACCESS_PATH!, 'utf8'));
      assert.ok(seeded.maps['project-a'], 'seed entry should be on disk');

      const a = await ensureMapAgentAccess('project-b');
      const state1 = mapAgentPanelState('project-b');
      const state2 = mapAgentPanelState('project-b');
      assert.equal(state1?.code, a.code, 'panel state must not regenerate the code');
      assert.equal(state2?.code, a.code, 'code must be stable across polls');
      assert.equal(a.code, first.code ? a.code : a.code); // noop guard for lint symmetry

      const onDisk = JSON.parse(fs.readFileSync(process.env.BOX_AGENT_ACCESS_PATH!, 'utf8'));
      assert.equal(onDisk.maps['project-b'].code, a.code, 'created entry must be written to disk');

      const join = await joinMapByCode({ code: a.code, name: 'zcode' });
      assert.ok(join.ok, 'join with the panel code must succeed');
      assert.equal(join.ok && join.projectId, 'project-b');
    });
  }],

  ['code survives across ensure calls without rotate', async () => {
    await withTempStore(async () => {
      const first = await ensureMapAgentAccess('project-x');
      const second = await ensureMapAgentAccess('project-x');
      assert.equal(second.code, first.code);
    });
  }],

  ['rotate invalidates the old code only', async () => {
    await withTempStore(async () => {
      const before = await ensureMapAgentAccess('project-r');
      const after = await rotateMapCode('project-r');
      assert.notEqual(after, before.code);
      assert.equal((await joinMapByCode({ code: before.code, name: 'x' })).ok, false);
      assert.equal((await joinMapByCode({ code: after, name: 'x' })).ok, true);
    });
  }],

  ['two maps get different codes and a token never crosses maps', async () => {
    await withTempStore(async () => {
      const mapA = await ensureMapAgentAccess('map-a');
      const mapB = await ensureMapAgentAccess('map-b');
      assert.notEqual(mapA.code, mapB.code, 'each map must have its own code');

      const joinedA = await joinMapByCode({ code: mapA.code, name: 'agent-a' });
      const joinedB = await joinMapByCode({ code: mapB.code, name: 'agent-b' });
      assert.ok(joinedA.ok && joinedB.ok);
      assert.equal(joinedA.projectId, 'map-a');
      assert.equal(joinedB.projectId, 'map-b');

      // The credential is bound to the map whose salt hashed it.
      const onA = authenticateMapAgent('map-a', `Bearer ${joinedA.token}`);
      assert.equal(onA.ok, true);
      assert.equal(onA.ok && onA.agent.name, 'agent-a');

      const crossAtoB = authenticateMapAgent('map-b', `Bearer ${joinedA.token}`);
      assert.equal(crossAtoB.ok, false);
      assert.equal(!crossAtoB.ok && crossAtoB.code, 'CROSS_MAP_TOKEN');

      const crossBtoA = authenticateMapAgent('map-a', `Bearer ${joinedB.token}`);
      assert.equal(!crossBtoA.ok && crossBtoA.code, 'CROSS_MAP_TOKEN');

      const garbage = authenticateMapAgent('map-a', 'Bearer agx_not-a-real-token');
      assert.equal(!garbage.ok && garbage.code, 'INVALID_TOKEN');
    });
  }],

  ['rotation keeps existing agents usable and blocks the old code', async () => {
    await withTempStore(async () => {
      const entry = await ensureMapAgentAccess('rotate-keep');
      const joined = await joinMapByCode({ code: entry.code, name: 'keeper' });
      assert.ok(joined.ok);

      const nextCode = await rotateMapCode('rotate-keep');
      assert.equal((await joinMapByCode({ code: entry.code, name: 'late' })).ok, false);
      assert.equal((await joinMapByCode({ code: nextCode, name: 'late' })).ok, true);

      const stillValid = authenticateMapAgent('rotate-keep', `Bearer ${joined.token}`);
      assert.equal(stillValid.ok, true, 'already-joined agents survive rotation');
    });
  }],

  ['revoking one agent kills its token but leaves the other agent alone', async () => {
    await withTempStore(async () => {
      const entry = await ensureMapAgentAccess('revoke-map');
      const first = await joinMapByCode({ code: entry.code, name: 'first' });
      const second = await joinMapByCode({ code: entry.code, name: 'second' });
      assert.ok(first.ok && second.ok);

      assert.equal(await revokeMapAgent('revoke-map', first.agent.id), true);
      const revoked = authenticateMapAgent('revoke-map', `Bearer ${first.token}`);
      assert.equal(!revoked.ok && revoked.code, 'INVALID_TOKEN');
      assert.equal(authenticateMapAgent('revoke-map', `Bearer ${second.token}`).ok, true);
      assert.equal((await joinMapByCode({ code: entry.code, name: 'third' })).ok, true);
    });
  }],

  ['code and joined token survive a process restart (fresh node reads the same store)', async () => {
    await withTempStore(async () => {
      const entry = await ensureMapAgentAccess('restart-map');
      const joined = await joinMapByCode({ code: entry.code, name: 'survivor' });
      assert.ok(joined.ok);

      const moduleUrl = new URL('./agent-access.ts', import.meta.url).href;
      const script = [
        `import { joinMapByCode, authenticateMapAgent } from ${JSON.stringify(moduleUrl)};`,
        `const result = await joinMapByCode({ code: ${JSON.stringify(entry.code)}, name: 'after-restart' });`,
        `const reused = authenticateMapAgent('restart-map', 'Bearer ${joined.token}');`,
        'process.stdout.write(JSON.stringify({',
        '  ok: result.ok,',
        '  projectId: result.ok ? result.projectId : null,',
        '  preRestartTokenStillValid: reused.ok,',
        '}));',
      ].join('\n');
      const output = execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
        { encoding: 'utf8', env: process.env },
      );
      const parsed = JSON.parse(output) as {
        ok: boolean;
        projectId: string | null;
        preRestartTokenStillValid: boolean;
      };
      assert.equal(parsed.ok, true, 'the same code must still join in a new process');
      assert.equal(parsed.projectId, 'restart-map');
      assert.equal(parsed.preRestartTokenStillValid, true, 'a token issued before restart must still authenticate');

      const stored = JSON.parse(fs.readFileSync(process.env.BOX_AGENT_ACCESS_PATH!, 'utf8'));
      assert.equal(stored.maps['restart-map'].code, entry.code, 'restart must not rotate the code');
      assert.equal(stored.maps['restart-map'].agents[0].name, 'survivor', 'joined agents persist');
    });
  }],

  ['audit trail never stores a reusable code or token', async () => {
    await withTempStore(async () => {
      const entry = await ensureMapAgentAccess('secret-map');
      const joined = await joinMapByCode({ code: entry.code, name: 'leaky' });
      assert.ok(joined.ok);

      // An agent pastes its own credentials into a tool argument.
      await recordMapAgentAction('secret-map', joined.agent.id, {
        action: 'live:say',
        result: 'applied',
        detail: `text=${entry.code} token=${joined.token}`,
      });
      const state = mapAgentPanelState('secret-map');
      const detail = state?.logs[0]?.detail || '';
      assert.ok(!detail.includes(entry.code), 'map code must be redacted from logs');
      assert.ok(!detail.includes(joined.token), 'token must be redacted from logs');
      assert.match(detail, /\[redacted:MAP\]/);
      assert.match(detail, /\[redacted:agx\]/);

      assert.equal(redactAgentSecrets('plain text'), 'plain text');
    });
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
if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log('agent-access (game) regression suite PASS');
