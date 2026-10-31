// Regression for the VOXA live relay. Mirrors the map-side test: attach, poll,
// ack, reattach, detach, and a late ack must all behave.
import assert from 'node:assert/strict';

import {
  acknowledgeVoxaCommand,
  attachVoxaEditor,
  detachVoxaEditor,
  dispatchVoxaCommand,
  pollVoxaEditor,
  progressVoxaEditor,
  resetVoxaLiveSession,
  voxaLiveStatus,
} from './agent-live.ts';

const actor = { id: 'agent-1', name: 'zcode' };

function test(name: string, run: () => Promise<void> | void) {
  return { name, run };
}

const tests = [
  test('attach → poll → ack delivers one command and keeps the snapshot', async () => {
    resetVoxaLiveSession();
    const attached = attachVoxaEditor({ snapshot: { bounds: { shape: [8, 8, 8] } } });
    assert.ok(attached.sessionId.startsWith('vxlive_'));

    const polling = pollVoxaEditor(attached.sessionId, 0, 1_000);
    const dispatching = dispatchVoxaCommand('look', { target: [1, 2, 3] }, actor, 5_000);

    const polled = await polling;
    assert.equal(polled.command?.kind, 'look');
    assert.equal(polled.command?.seq, 1);

    acknowledgeVoxaCommand(attached.sessionId, {
      id: polled.command!.id,
      ok: true,
      result: { summary: '镜头移动' },
      snapshot: { camera: { position: [4, 5, 6] } },
      at: new Date().toISOString(),
    });

    const outcome = await dispatching;
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.snapshot?.camera !== undefined, true);
    }
    const status = voxaLiveStatus();
    assert.equal(status.attached, true);
    assert.equal(status.lastAction?.status, 'ok');
    resetVoxaLiveSession();
  }),

  test('no editor attached reports EDITOR_NOT_ATTACHED', async () => {
    resetVoxaLiveSession();
    const outcome = await dispatchVoxaCommand('look', {}, actor, 5_000);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'EDITOR_NOT_ATTACHED');
  }),

  test('reattach invalidates the previous session and fails its pending command', async () => {
    resetVoxaLiveSession();
    const first = attachVoxaEditor();
    const observed = dispatchVoxaCommand('observe', {}, actor, 5_000);
    const observePoll = await pollVoxaEditor(first.sessionId, 0, 1_000);
    acknowledgeVoxaCommand(first.sessionId, {
      id: observePoll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;
    const pending = dispatchVoxaCommand('paint', { at: [1, 1, 1] }, actor, 5_000);
    const second = attachVoxaEditor();
    assert.notEqual(first.sessionId, second.sessionId);

    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'EDITOR_REATTACHED');

    const stale = await pollVoxaEditor(first.sessionId, 0, 1_000);
    assert.equal(stale.sessionInvalid, true);
    resetVoxaLiveSession();
  }),

  test('detach resolves waiters and clears the slot', async () => {
    resetVoxaLiveSession();
    const attached = attachVoxaEditor();
    const polling = pollVoxaEditor(attached.sessionId, 0, 5_000);
    assert.equal(detachVoxaEditor(attached.sessionId), true);
    const polled = await polling;
    assert.equal(polled.sessionInvalid, true);
    assert.equal(voxaLiveStatus().attached, false);
  }),

  test('a late ack for an unknown command is recorded without breaking the session', () => {
    resetVoxaLiveSession();
    const attached = attachVoxaEditor();
    const accepted = acknowledgeVoxaCommand(attached.sessionId, {
      id: 'cmd_unknown',
      ok: true,
      result: { summary: '迟到的回执' },
      at: new Date().toISOString(),
    });
    assert.equal(accepted, true);
    const status = voxaLiveStatus();
    assert.equal(status.attached, true);
    assert.equal(status.queued, 0);
    resetVoxaLiveSession();
  }),

  test('a fresh attach refuses writes until observe; receipts keep the operation id', async () => {
    resetVoxaLiveSession();
    const attached = attachVoxaEditor();
    const refused = await dispatchVoxaCommand('paint', { at: [0, 0, 0] }, actor, 5_000);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, 'OBSERVE_REQUIRED');

    const observed = dispatchVoxaCommand('observe', {}, actor, 5_000);
    const observePoll = await pollVoxaEditor(attached.sessionId, 0, 1_000);
    acknowledgeVoxaCommand(attached.sessionId, {
      id: observePoll.command!.id,
      ok: true,
      result: { summary: '看见' },
      at: new Date().toISOString(),
    });
    await observed;

    const painted = dispatchVoxaCommand('paint_path', { points: [[0, 0, 0]] }, actor, 5_000);
    const paintPoll = await pollVoxaEditor(attached.sessionId, 1, 1_000);
    progressVoxaEditor(attached.sessionId, { occupiedCells: 1 }, '正在沿路径上色 1/1');
    acknowledgeVoxaCommand(attached.sessionId, {
      id: paintPoll.command!.id,
      ok: true,
      result: { summary: '完成', operationId: paintPoll.command!.id },
      at: new Date().toISOString(),
    });
    await painted;
    const status = voxaLiveStatus();
    assert.equal(status.requiresObserve, false);
    assert.equal(status.operations.at(-1)?.operationId, paintPoll.command!.id);
    assert.equal(status.progress.at(-1)?.note, '正在沿路径上色 1/1');
    resetVoxaLiveSession();
  }),

  test('progress updates the snapshot without consuming a command', () => {
    resetVoxaLiveSession();
    const attached = attachVoxaEditor();
    assert.equal(
      progressVoxaEditor(attached.sessionId, { occupiedCells: 42 }, '正在建模'),
      true,
    );
    assert.deepEqual(voxaLiveStatus().snapshot, { occupiedCells: 42 });
    resetVoxaLiveSession();
  }),
];

let failures = 0;
for (const entry of tests) {
  try {
    await entry.run();
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${entry.name}`);
    console.error(error);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
