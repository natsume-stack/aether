/**
 * Agent Live relay regression. No HTTP, no Next: attach → poll → ack →
 * dispatch, plus the invalidation paths an agent must be able to trust.
 *
 *   node --experimental-strip-types server/agent-live.test.ts
 */
import assert from 'node:assert/strict';

import {
  acknowledgeCommand,
  attachEditor,
  detachEditor,
  dispatchCommand,
  liveStatus,
  pollEditor,
  progressEditor,
  resetLiveSession,
} from './agent-live.ts';

const actor = { id: 'agent-1', name: 'builder' };

const tests: Array<[string, () => Promise<void>]> = [
  ['a fresh attach refuses writes until the agent observes', async () => {
    resetLiveSession('p0');
    attachEditor('p0');
    const refused = await dispatchCommand('p0', 'place', { at: [1, 1, 1], block: 'stone' }, actor, 8_000);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.error.code, 'OBSERVE_REQUIRED');
    const status = liveStatus('p0');
    assert.equal(status.requiresObserve, true);
    assert.equal(status.operations.length, 0);
    resetLiveSession('p0');
  }],

  ['a timeout marks the channel observe-first, and the next observe clears it', async () => {
    resetLiveSession('p1t');
    const attached = attachEditor('p1t');
    const first = dispatchCommand('p1t', 'observe', {}, actor, 8_000);
    const firstPoll = await pollEditor('p1t', attached.sessionId, attached.lastSeq, 1_000);
    acknowledgeCommand('p1t', attached.sessionId, {
      id: firstPoll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await first;
    assert.equal(liveStatus('p1t').requiresObserve, false);

    const timeoutPromise = dispatchCommand('p1t', 'look', {}, actor, 5_000);
    // The hub's timeout timer is unref'd, so keep the event loop alive while
    // pretending the tab never acks.
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const timeout = await timeoutPromise;
    assert.equal(timeout.ok, false);
    assert.equal(!timeout.ok && timeout.error.code, 'EDITOR_TIMEOUT');
    assert.equal(!timeout.ok && timeout.operationId !== undefined, true);
    assert.equal(liveStatus('p1t').requiresObserve, true);

    const blocked = await dispatchCommand('p1t', 'place', { at: [1, 1, 1] }, actor, 8_000);
    assert.equal(!blocked.ok && blocked.error.code, 'OBSERVE_REQUIRED');

    const observed = dispatchCommand('p1t', 'observe', {}, actor, 8_000);
    const poll = await pollEditor('p1t', attached.sessionId, 2, 1_000);
    acknowledgeCommand('p1t', attached.sessionId, {
      id: poll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;
    assert.equal(liveStatus('p1t').requiresObserve, false);
    resetLiveSession('p1t');
  }],

  ['operations and progress receipts carry the operation id', async () => {
    resetLiveSession('p1r');
    const attached = attachEditor('p1r');
    const observed = dispatchCommand('p1r', 'observe', {}, actor, 8_000);
    const poll = await pollEditor('p1r', attached.sessionId, attached.lastSeq, 1_000);
    acknowledgeCommand('p1r', attached.sessionId, {
      id: poll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;

    const running = dispatchCommand('p1r', 'place_path', { points: [[1, 1, 1]] }, actor, 8_000);
    const pathPoll = await pollEditor('p1r', attached.sessionId, 1, 1_000);
    progressEditor('p1r', attached.sessionId, { at: 'now' }, '正在沿路径搭建 1/1');
    acknowledgeCommand('p1r', attached.sessionId, {
      id: pathPoll.command!.id,
      ok: true,
      result: { summary: '完成', receipts: [{ done: 1, total: 1 }] },
      at: new Date().toISOString(),
    });
    await running;

    const status = liveStatus('p1r');
    const operation = status.operations.find((item) => item.operationId === pathPoll.command!.id);
    assert.equal(operation?.status, 'ok');
    assert.equal(operation?.actor.name, 'builder');
    assert.equal(status.progress.at(-1)?.operationId, pathPoll.command!.id);
    assert.equal(status.progress.at(-1)?.note, '正在沿路径搭建 1/1');
    resetLiveSession('p1r');
  }],

  ['attach → poll → ack resolves the agent command with the snapshot', async () => {
    resetLiveSession('p1');
    const attached = attachEditor('p1', { snapshot: { camera: { eye: [1, 2, 3] } } });
    const command = dispatchCommand('p1', 'observe', {}, actor, 8_000);
    const polled = await pollEditor('p1', attached.sessionId, attached.lastSeq, 1_000);
    assert.equal(polled.command?.kind, 'observe');
    assert.equal(polled.command?.seq, 1);

    const accepted = acknowledgeCommand('p1', attached.sessionId, {
      id: polled.command!.id,
      ok: true,
      result: { summary: '看见了地面' },
      snapshot: { cursor: { voxel: [4, 5, 6] } },
      at: new Date().toISOString(),
    });
    assert.equal(accepted, true);

    const outcome = await command;
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ok && outcome.snapshot, { cursor: { voxel: [4, 5, 6] } });
    const status = liveStatus('p1');
    assert.equal(status.attached, true);
    assert.equal(status.lastAction?.status, 'ok');
    resetLiveSession('p1');
  }],

  ['dispatch without an editor returns EDITOR_NOT_ATTACHED', async () => {
    resetLiveSession('p2');
    const outcome = await dispatchCommand('p2', 'look', {}, actor, 8_000);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error.code, 'EDITOR_NOT_ATTACHED');
  }],

  ['reattach fails the previous tab\'s pending command', async () => {
    resetLiveSession('p3');
    const first = attachEditor('p3');
    const observed = dispatchCommand('p3', 'observe', {}, actor, 8_000);
    const observePoll = await pollEditor('p3', first.sessionId, first.lastSeq, 1_000);
    acknowledgeCommand('p3', first.sessionId, {
      id: observePoll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;
    const pending = dispatchCommand('p3', 'place', { x: 1, y: 2, z: 3 }, actor, 8_000);
    await pollEditor('p3', first.sessionId, first.lastSeq + 1, 1_000);
    attachEditor('p3');
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error.code, 'EDITOR_REATTACHED');
    resetLiveSession('p3');
  }],

  ['detach fails pending work and invalidates polling', async () => {
    resetLiveSession('p4');
    const attached = attachEditor('p4');
    const observed = dispatchCommand('p4', 'observe', {}, actor, 8_000);
    const observePoll = await pollEditor('p4', attached.sessionId, attached.lastSeq, 1_000);
    acknowledgeCommand('p4', attached.sessionId, {
      id: observePoll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;
    const pending = dispatchCommand('p4', 'save', {}, actor, 8_000);
    await pollEditor('p4', attached.sessionId, attached.lastSeq + 1, 1_000);
    assert.equal(detachEditor('p4', attached.sessionId), true);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error.code, 'EDITOR_DETACHED');
    const polled = await pollEditor('p4', attached.sessionId, 0, 1_000);
    assert.equal(polled.sessionInvalid, true);
  }],

  ['stale ack is still recorded instead of resurrecting a pending command', async () => {
    resetLiveSession('p5');
    const attached = attachEditor('p5');
    const accepted = acknowledgeCommand('p5', attached.sessionId, {
      id: 'cmd_unknown',
      ok: true,
      result: { summary: 'late' },
      at: new Date().toISOString(),
    });
    assert.equal(accepted, true);
    resetLiveSession('p5');
  }],
  ['the hub lives on globalThis so every route bundle shares it', async () => {
    // Next.js gives every API route its own module graph. If the session map
    // were a module binding, attach would write to a hub the status/next routes
    // can never see (this actually happened: attach 200, status attached=false).
    resetLiveSession('hub-cross');
    const attached = attachEditor('hub-cross', { snapshot: { project: { name: 'hub' } } });
    const hub = (globalThis as Record<string, unknown>).__box3_agent_live_hub__ as
      | { sessions?: Map<string, { id: string }> }
      | undefined;
    assert.ok(hub?.sessions instanceof Map, 'session hub must be a process-wide global');
    assert.equal(hub?.sessions?.get('hub-cross')?.id, attached.sessionId);
    assert.equal(liveStatus('hub-cross').attached, true);
    resetLiveSession('hub-cross');
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
console.log('agent-live (game) regression suite PASS');
