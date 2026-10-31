// Live VOXA verification: open the real editor, wait for the live channel to
// attach, ask the agent to move the camera and paint voxels, and capture the
// canvas before/after. Rendered PNGs are the evidence, not a log line.
import { openTab, attach, waitForExpression, sleep } from './agent-cdp.mjs';
import { AgentClient } from '../tools/box3-agent-mcp/src/client.js';
import { loadConfig } from '../tools/box3-agent-mcp/src/config.js';

const port = Number(process.env.CDP_PORT || 9222);
const voxaBase = process.env.BOX_VOXA_AGENT_BASE_URL || 'http://127.0.0.1:3123';

let page;
try {
  page = await attach({ port, match: voxaBase });
  console.log('attached to existing VOXA tab');
} catch {
  page = await openTab(`${voxaBase}/?modelId=1`, { port });
  console.log('opened VOXA tab');
}

await waitForExpression(page, 'document.readyState === "complete"', { timeoutMs: 60_000 });
await sleep(3000);

const info = await page.evaluate(`(() => ({
  url: location.href,
  title: document.title,
  hasEditor: Boolean(window.editor),
  body: document.body.innerText.slice(0, 300),
}))()`);
console.log('page', JSON.stringify(info));

const attached = await waitForExpression(
  page,
  `(async () => {
     try {
       const r = await fetch('/api/agent/v1/live/status', { cache: 'no-store' });
       const d = await r.json();
       return d.attached ? d : false;
     } catch (e) { return false; }
   })()`,
  { timeoutMs: 45_000, intervalMs: 1_000 },
);
console.log('live status', JSON.stringify(attached).slice(0, 400));

await page.screenshot('.local-evidence/voxa-live-01-attached.png');
console.log('evidence', '.local-evidence/voxa-live-01-attached.png');

const config = loadConfig(process.env);
const client = new AgentClient(config);

const observe = await client.voxaObserve({});
const snapshot = observe.result?.snapshot || observe.snapshot || {};
console.log('observe', JSON.stringify({
  bounds: snapshot.bounds,
  camera: snapshot.camera,
  occupied: snapshot.occupiedCells,
  palette: snapshot.palette,
}));

const look = await client.voxaCommand('look', { target: [4, 4, 4], distance: 26, durationMs: 900 });
console.log('look', look.result?.summary);

const palette = await client.voxaCommand('palette', {});
const colorId = palette.result?.selectedId || palette.result?.items?.[1]?.id;
console.log('palette', JSON.stringify({ colorId, count: palette.result?.items?.length }));

if (colorId) {
  // Paint a short visible line; each cell appears with pacing so a human sees it.
  const points = [];
  for (let x = 1; x <= 5; x += 1) points.push([x, 1, 1]);
  const painted = await client.voxaCommand('paint_path', { points, paletteId: colorId, paceMs: 120 });
  console.log('paint_path', painted.result?.summary);
}

await sleep(800);
await page.screenshot('.local-evidence/voxa-live-02-painted.png');
console.log('evidence', '.local-evidence/voxa-live-02-painted.png');

const after = await client.voxaObserve({});
const afterSnapshot = after.result?.snapshot || after.snapshot || {};
console.log('after', JSON.stringify({
  occupied: afterSnapshot.occupiedCells,
  camera: afterSnapshot.camera,
  cursor: afterSnapshot.cursor,
}));

const shot = await client.voxaCommand('screenshot', {});
console.log('screenshot', JSON.stringify({
  summary: shot.result?.summary,
  bytes: shot.result?.data ? Math.round(shot.result.data.length * 0.75) : 0,
}));
