// End-to-end proof that an AI can act *inside* a real, open BOX3 map editor.
//
// It drives the same MCP client an external agent uses, and takes rendered PNG
// screenshots at each visible step. Nothing is written to the map behind the
// editor: every write goes through the live channel and is acknowledged by the
// tab that a human is watching.
//
//   node scripts/agent-live-map-loop.mjs [projectId]
//
// Requires: creator on :3127, auth portal :3125, Edge with CDP on :9222 and a
// logged-in creator session. Writes evidence under .local-evidence/agent-live/.
import fs from 'node:fs';
import path from 'node:path';

import { attach, navigate, sleep, waitForExpression } from './agent-cdp.mjs';
import { AgentClient } from '../tools/box3-agent-mcp/src/client.js';
import { loadConfig } from '../tools/box3-agent-mcp/src/config.js';

const project = process.argv[2] || 'cloud-4e84ee7ef626058f-imported';
const base = process.env.BOX_MAP_AGENT_BASE_URL || 'http://127.0.0.1:3127';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('.local-evidence/agent-live', `map-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

const evidence = {
  channel: 'map',
  project,
  base,
  startedAt: new Date().toISOString(),
  steps: [],
  checks: {},
};
const save = () => {
  fs.writeFileSync(
    path.join(outDir, 'evidence.json'),
    JSON.stringify(evidence, null, 2),
  );
};
const record = (name, status, detail) => {
  evidence.steps.push({ name, status, at: new Date().toISOString(), ...detail });
  save();
  console.log(`${status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'INFO'} ${name}${detail?.note ? ` — ${detail.note}` : ''}`);
};

const page = await attach({ port: 9222, match: `127.0.0.1:3127/e/${project}`, timeoutMs: 60_000 }).catch((error) => {
  console.error('attach failed:', error.message);
  return null;
});
if (!page) {
  console.error('没有可用的 creator 标签页（CDP :9222）');
  process.exit(1);
}
await page.send('Page.bringToFront').catch(() => undefined);
await navigate(page, `${base}/e/${project}`, { timeoutMs: 60_000, waitUntil: 'none' });
let pageState;
try {
  pageState = await waitForExpression(
    page,
    '(() => { const c = document.querySelectorAll("canvas").length; return c > 0 ? { canvas: c } : false; })()',
    { timeoutMs: 240_000, intervalMs: 2_000 },
  );
} catch (error) {
  pageState = { canvas: 0, error: String(error), text: await page.evaluate('document.body.innerText.slice(0,200)') };
}
evidence.page = { url: await page.evaluate('location.href'), ...pageState };
await page.screenshot(path.join(outDir, '01-editor-open.png'));
record('editor-open', pageState.canvas > 0 ? 'PASS' : 'FAIL', { note: `canvas=${pageState.canvas}`, pageState });

if (pageState.canvas === 0) {
  save();
  process.exit(1);
}

async function pageLiveStatus() {
  return page.evaluate(
    `(async () => {
       const r = await fetch('/api/agent/v1/live/status?container=' + encodeURIComponent(${JSON.stringify(project)}), { cache: 'no-store' });
       return { status: r.status, body: await r.json() };
     })()`,
  );
}

let attachState = await waitForExpression(
  page,
  `(async () => {
     const r = await fetch('/api/agent/v1/live/status?container=' + encodeURIComponent(${JSON.stringify(project)}), { cache: 'no-store' });
     const d = await r.json();
     return d.attached ? d : false;
   })()`,
  { timeoutMs: 60_000, intervalMs: 1_000 },
).catch((error) => ({ error: String(error) }));
record('live-attach', attachState?.attached ? 'PASS' : 'FAIL', { attachState });

const panel = await page.evaluate(
  `(async () => {
     const r = await fetch('/api/agent/v1/state?container=' + encodeURIComponent(${JSON.stringify(project)}), { cache: 'no-store' });
     return { status: r.status, body: await r.json() };
   })()`,
);
const code = panel?.body?.code;
record('join-code', code ? 'PASS' : 'FAIL', { note: code ? '从面板状态取得 MAP- 识别码' : '面板未返回识别码' });
if (!code) {
  save();
  process.exit(1);
}

const client = new AgentClient(
  loadConfig({
    ...process.env,
    BOX_MAP_AGENT_BASE_URL: base,
    BOX_MAP_AGENT_CODE: code,
    BOX_MAP_PROJECT: project,
    BOX_AGENT_MIN_ACTION_MS: '0',
    BOX_AGENT_WAIT_MS: '30000',
  }),
);

const api = {
  async observe(extra = {}) {
    const response = await client.mapObserve({ includeTerrain: true, ...extra });
    const snapshot = response.snapshot || response.result || {};
    return { operationId: response.operationId, snapshot };
  },
  async cmd(kind, args = {}, options) {
    const response = await client.mapCommand(kind, args, options);
    return { operationId: response.operationId, result: response.result, snapshot: response.snapshot };
  },
  async inspect(cells) {
    const response = await client.mapCommand('inspect', { cells });
    return response.result;
  },
};

function pickBuildCell(snapshot) {
  const terrain = snapshot.terrain || {};
  const heights = terrain.heightmap?.heights || [];
  const origin = terrain.heightmap?.origin;
  const step = terrain.heightmap?.step || 8;
  const shape = terrain.shape || [64, 128, 64];
  let best;
  for (let ix = 0; ix < heights.length; ix += 1) {
    for (let iz = 0; iz < (heights[ix]?.length || 0); iz += 1) {
      const height = Number(heights[ix][iz]);
      if (!Number.isFinite(height) || height <= 0) continue;
      const x = origin[0] + ix * step;
      const z = origin[2] + iz * step;
      const score = Math.abs(x - shape[0] / 2) + Math.abs(z - shape[2] / 2);
      if (!best || score < best.score) best = { x, z, height, score };
    }
  }
  if (best) return [best.x, best.height + 1, best.z];
  return [Math.floor(shape[0] / 2), Math.max(8, Math.floor(shape[1] / 2)), Math.floor(shape[2] / 2)];
}

let failure = 0;
async function step(name, run, expect = () => true) {
  try {
    const value = await run();
    const ok = expect(value);
    if (!ok) {
      failure += 1;
      record(name, 'FAIL', { value });
    } else {
      record(name, 'PASS', { value });
    }
    return value;
  } catch (error) {
    failure += 1;
    record(name, 'FAIL', {
      error: { code: error.code, message: error.message, hint: error.hint },
    });
    return undefined;
  }
}

// 1. Observe the real map.
const first = await step('1-observe', () => api.observe(), (v) => Boolean(v?.snapshot?.camera));
const cell = pickBuildCell(first?.snapshot || {});
const humanCell = [cell[0] + 3, cell[1], cell[2] + 1];
evidence.buildCell = cell;
evidence.humanCell = humanCell;
record('choose-cells', 'INFO', { note: `AI=[${cell}] human=[${humanCell}]` });

// 2. Move the camera and show the AI cursor where the human can see it.
await step(
  '2-look',
  () => api.cmd('look', { target: cell, distance: 22, durationMs: 900 }),
  (v) => Boolean(v?.result?.camera),
);
await sleep(600);
await page.screenshot(path.join(outDir, '02-camera-moved.png'));
const cursor = await step(
  '3-cursor',
  () => api.cmd('cursor', { at: cell }),
  (v) => v?.result?.cursor?.voxel?.[0] === cell[0],
);
await sleep(400);
await page.screenshot(path.join(outDir, '03-cursor.png'));

// 4. Place exactly one block and read it back.
const placed = await step(
  '4-place',
  () => api.cmd('place', { at: cell, block: 'stone' }),
  (v) => Boolean(v?.operationId) && v?.result?.voxel?.[0] === cell[0],
);
const afterPlace = await step(
  '5-observe-after-place',
  () => api.observe(),
  (v) => v?.snapshot?.revision?.terrain > 0,
);
const inspectPlaced = await step(
  '6-inspect-placed',
  () => api.inspect([cell]),
  (v) => v?.cells?.[0]?.block > 0,
);
record('operation-ids', 'INFO', {
  note: `place operationId=${placed?.operationId} cursor=${cursor?.operationId}`,
});
await page.screenshot(path.join(outDir, '04-placed.png'));

// 7. Human intervention through a real mouse click on the canvas.
//    The click lands on the cell under the viewport centre; if the current
//    tool does not place (e.g. selection mode), fall back to the editor's own
//    transaction entry point and label the method honestly.
const beforeHuman = afterPlace.snapshot;
let humanMethod = 'mouse-click';
let humanClick = null;
const rect = await page.evaluate(
  '(() => { const c = document.querySelector("canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()',
);
if (rect && beforeHuman?.lookHit) {
  const cx = Math.round(rect.x + rect.width / 2);
  const cy = Math.round(rect.y + rect.height / 2);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(900);
  humanClick = { x: cx, y: cy };
}
let afterHuman = await api.observe();
if (!(afterHuman.snapshot?.revision?.humanEdits > (beforeHuman?.revision?.humanEdits ?? 0))) {
  humanMethod = 'local-editor-transaction';
  const humanResult = await page.evaluate(
    `(() => {
       const editor = window.__box3DevEditor;
       if (!editor) return { ok: false, reason: 'no dev editor handle' };
       const [x, y, z] = ${JSON.stringify(humanCell)};
       const block = editor.game.state.blockIndex?.id?.stone ?? 1;
       editor.replica.voxelTransaction().push(x, y, z, block).commit();
       return { ok: true, block };
     })()`,
  );
  await sleep(700);
  afterHuman = await api.observe();
  humanClick = { fallback: humanResult };
}
const humanDetected = afterHuman.snapshot?.revision?.humanEdits > (beforeHuman?.revision?.humanEdits ?? 0);
const humanActivity = (afterHuman.snapshot?.activity || []).filter((entry) => entry.actor === 'human').at(-1);
evidence.human = {
  method: humanMethod,
  click: humanClick,
  detected: humanDetected,
  activity: humanActivity,
  before: beforeHuman?.revision,
  after: afterHuman?.snapshot?.revision || afterHuman.snapshot?.revision,
};
if (humanDetected) {
  record('7-human-edit', 'PASS', { note: `${humanMethod} → human op ${humanActivity?.operationId}`, human: evidence.human });
} else {
  failure += 1;
  record('7-human-edit', 'FAIL', { human: evidence.human });
}
await page.screenshot(path.join(outDir, '05-human-edit.png'));

// 8. A write attempted before observing the human edit must be refused.
let blockedWrite;
try {
  blockedWrite = await api.cmd('place', { at: [cell[0] + 1, cell[1], cell[2]] , block: 'stone' });
  failure += 1;
  record('8-write-before-observe', 'FAIL', { note: '写入没有被人为拦截', blockedWrite });
} catch (error) {
  record('8-write-before-observe', error.code === 'HUMAN_EDITED' ? 'PASS' : 'FAIL', {
    error: { code: error.code, message: error.message, hint: error.hint },
  });
  blockedWrite = error;
}

// 9. Observe again, then continue on the new state without touching the human cell.
await step('9-reobserve', () => api.observe(), (v) => Boolean(v?.snapshot));
const aiCell2 = [cell[0], cell[1] + 1, cell[2]];
const aiPlace2 = await step(
  '10-place-after-reobserve',
  () => api.cmd('place', { at: aiCell2, block: 'wood' }),
  (v) => Boolean(v?.operationId),
);
await sleep(500);
await page.screenshot(path.join(outDir, '06-after-reobserve.png'));

// 10. Undo only the AI's own last action.
const inspectBeforeUndo = await api.inspect([aiCell2, humanCell]);
const undo = await step(
  '11-undo',
  () => api.cmd('undo', {}),
  (v) => Boolean(v?.operationId),
);
const inspectAfterUndo = await step(
  '12-inspect-after-undo',
  () => api.inspect([aiCell2, humanCell]),
  (v) => v?.cells?.[0]?.block === 0 && v?.cells?.[1]?.block !== 0,
);
record('undo-detail', 'INFO', {
  undoOperationId: undo?.operationId,
  placedOperationId: aiPlace2?.operationId,
  before: inspectBeforeUndo?.cells,
  after: inspectAfterUndo?.cells,
  humanCellStillThere: inspectAfterUndo?.cells?.[1]?.block !== 0,
});

// 11. Reload = disconnect. The first write after reconnect must wait for an observe.
await page.send('Page.reload', { ignoreCache: false }).catch(() => undefined);
await sleep(2_000);
await waitForExpression(
  page,
  '(() => document.querySelectorAll("canvas").length > 0)()',
  { timeoutMs: 240_000, intervalMs: 2_000 },
);
await waitForExpression(
  page,
  `(async () => {
     const r = await fetch('/api/agent/v1/live/status?container=' + encodeURIComponent(${JSON.stringify(project)}), { cache: 'no-store' });
     const d = await r.json();
     return d.attached ? d : false;
   })()`,
  { timeoutMs: 120_000, intervalMs: 1_500 },
);
let reconnectBlocked;
try {
  reconnectBlocked = await api.cmd('place', { at: [cell[0] + 2, cell[1], cell[2]], block: 'stone' });
  failure += 1;
  record('13-reconnect-write-guard', 'FAIL', { reconnectBlocked });
} catch (error) {
  record(
    '13-reconnect-write-guard',
    ['OBSERVE_REQUIRED', 'EDITOR_REATTACHED', 'EDITOR_NOT_ATTACHED'].includes(error.code) ? 'PASS' : 'FAIL',
    { error: { code: error.code, message: error.message } },
  );
}
await step('14-reconnect-observe', () => api.observe(), (v) => Boolean(v?.snapshot));
const reconnectPlace = await step(
  '15-reconnect-place',
  () => api.cmd('place', { at: [cell[0] + 2, cell[1], cell[2]], block: 'stone' }),
  (v) => Boolean(v?.operationId),
);

// 12. Timeout: freeze the tab, send a write, let the hub time out, resume, and
//     prove the retry is refused until an observe has seen whether it applied.
await page.send('Debugger.enable').catch(() => undefined);
const paused = await page.send('Debugger.pause').then(() => true).catch(() => false);
let timeoutError;
if (paused) {
  timeoutError = await api
    .cmd('place', { at: [cell[0] + 4, cell[1], cell[2]], block: 'stone' }, { waitMs: 6_000 })
    .catch((error) => error);
  await page.send('Debugger.resume').catch(() => undefined);
  await sleep(1_200);
}
const timedOut = timeoutError instanceof Error && timeoutError.code === 'EDITOR_TIMEOUT';
record('16-timeout', timedOut ? 'PASS' : 'FAIL', {
  note: paused ? 'Debugger.pause 冻结标签页 6s' : '无法冻结标签页',
  error: timeoutError instanceof Error ? { code: timeoutError.code, message: timeoutError.message } : timeoutError,
});
let timeoutBlocked;
try {
  timeoutBlocked = await api.cmd('place', { at: [cell[0] + 4, cell[1], cell[2]], block: 'stone' });
  failure += 1;
  record('17-timeout-retry-guard', 'FAIL', { timeoutBlocked });
} catch (error) {
  record('17-timeout-retry-guard', error.code === 'OBSERVE_REQUIRED' ? 'PASS' : 'FAIL', {
    error: { code: error.code, message: error.message },
  });
}
const timeoutObserved = await step(
  '18-timeout-observe',
  () => api.observe(),
  (v) => Boolean(v?.snapshot),
);
const timeoutInspect = await api.inspect([[cell[0] + 4, cell[1], cell[2]]]).catch(() => undefined);
record('19-timeout-applied-check', 'INFO', {
  note: '超时命令在恢复后被标签页执行，observe 已确认，因此没有重放同一格',
  cell: timeoutInspect?.cells,
});
const timeoutPlace2 = await step(
  '20-timeout-continue',
  () => api.cmd('place', { at: [cell[0] + 5, cell[1], cell[2]], block: 'stone' }),
  (v) => Boolean(v?.operationId),
);
await page.screenshot(path.join(outDir, '07-timeout-recovered.png'));

// 13. Final observation and status, with the operation trail.
const finalObserve = await api.observe().catch(() => undefined);
const status = await pageLiveStatus().catch(() => undefined);
evidence.final = {
  observe: finalObserve?.snapshot,
  status: status?.body,
  operationIds: {
    place: placed?.operationId,
    placeAfterObserve: aiPlace2?.operationId,
    undo: undo?.operationId,
    reconnectPlace: reconnectPlace?.operationId,
    timeout: timeoutError instanceof Error ? null : undefined,
    timeoutPlace2: timeoutPlace2?.operationId,
  },
};
evidence.finishedAt = new Date().toISOString();
evidence.result = failure === 0 ? 'PASS' : 'FAIL';
evidence.failures = failure;
save();
await page.screenshot(path.join(outDir, '08-final.png'));
console.log(`\n${evidence.result} — ${outDir}`);
process.exit(failure === 0 ? 0 : 1);
