// Human-like incremental build through the local edit runtime (no browser).
// 1) survey the map for an empty footprint, 2) floor, 3) walls side by side,
// 4) cut a door, 5) build a deliberately short roof, read the real gap,
// 6) revert that roof, 7) rebuild and verify every cell.
import fs from 'node:fs';
import path from 'node:path';

const projectId = process.argv[2] || 'project-mvmuax72';
const base = process.env.BOX_CREATOR_BASE_URL || 'http://127.0.0.1:3127';
const url = `${base}/api/internal/map-authoring/${encodeURIComponent(projectId)}/tool`;
const logDir = process.env.RUN_DIR || path.resolve('.local-evidence/agent-live', 'local-build');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'hut-steps.jsonl');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(tool, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 2000) };
  }
  const record = { at: new Date().toISOString(), tool, args, status: response.status, payload };
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  return { status: response.status, ...payload, result: payload?.result };
}

let revision = '';
async function refreshRevision() {
  const info = await call('terrainInfo', {});
  revision = info.result?.revision || revision;
  return revision;
}

async function apply(label, region, block) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await call('terrainApply', { region, block, expectedRevision: revision });
    if (res.result?.success) {
      revision = res.result.newRevision || res.result.revisionAfter || revision;
      console.log(
        `${label}: ${res.result.changed}/${res.result.requested} cells, op=${res.result.operationId}, revision=${revision}`,
      );
      await sleep(350);
      return res.result;
    }
    if (res.result?.code === 'REVISION_CONFLICT') {
      console.log(`${label}: revision conflict, re-reading and retrying`);
      await refreshRevision();
      continue;
    }
    throw new Error(`${label} failed: ${JSON.stringify(res.result || res)}`);
  }
  throw new Error(`${label}: revision kept conflicting`);
}

const BLOCKS = { floor: 129, wall: 129, roof: 257, air: 0 };
const info = await call('terrainInfo', {});
const [sx, sy, sz] = info.result.shape;
await refreshRevision();
console.log(`terrain ${sx}x${sy}x${sz}, revision=${revision}`);

// Survey the whole map. A human builder walks the site before placing blocks.
const survey = await call('terrainRead', {
  region: { min: [0, 0, 0], max: [sx - 1, sy - 1, sz - 1] },
  limit: 200_000,
});
const cells = survey.result?.cells || [];
const solid = new Set();
for (const cell of cells) if (cell.b !== 0) solid.add(`${cell.x},${cell.y},${cell.z}`);
const isFree = (x0, y0, z0, w, h) => {
  for (let x = x0; x < x0 + w; x += 1) {
    for (let z = z0; z < z0 + w; z += 1) {
      if (solid.has(`${x},0,${z}`)) continue; // ground plane is expected
      for (let y = y0; y < y0 + h; y += 1) if (solid.has(`${x},${y},${z}`)) return false;
    }
  }
  return true;
};
let site;
for (let radius = 0; radius < 12 && !site; radius += 1) {
  for (const [x0, z0] of [
    [Math.floor(sx / 2) - 2 + radius, Math.floor(sz / 2) - 2],
    [Math.floor(sx / 2) - 2 - radius, Math.floor(sz / 2) - 2],
    [Math.floor(sx / 2) - 2, Math.floor(sz / 2) - 2 + radius],
    [Math.floor(sx / 2) - 2, Math.floor(sz / 2) - 2 - radius],
  ]) {
    if (x0 < 1 || z0 < 1 || x0 + 5 >= sx || z0 + 5 >= sz) continue;
    if (isFree(x0, 1, z0, 5, 5)) { site = { x0, z0 }; break; }
  }
}
if (!site) throw new Error('no empty 5x5 footprint above ground');
console.log(`site chosen: x=${site.x0}..${site.x0 + 4}, z=${site.z0}..${site.z0 + 4}, empty y=1..5`);
const S = {
  x0: site.x0, x1: site.x0 + 4, z0: site.z0, z1: site.z0 + 4,
  floor: 1, wallBase: 2, wallTop: 4, roof: 5,
};

await apply('1 floor', { min: [S.x0, S.floor, S.z0], max: [S.x1, S.floor, S.z1] }, BLOCKS.floor);

// Clear the interior volume above the floor (a human checks for props first).
await apply('1b clear interior', {
  min: [S.x0 + 1, S.wallBase, S.z0 + 1],
  max: [S.x1 - 1, S.roof, S.z1 - 1],
}, BLOCKS.air);

await apply('2 north wall', { min: [S.x0, S.wallBase, S.z0], max: [S.x1, S.wallTop, S.z0] }, BLOCKS.wall);
await apply('3 west wall', { min: [S.x0, S.wallBase, S.z0 + 1], max: [S.x0, S.wallTop, S.z1 - 1] }, BLOCKS.wall);
await apply('4 east wall', { min: [S.x1, S.wallBase, S.z0 + 1], max: [S.x1, S.wallTop, S.z1 - 1] }, BLOCKS.wall);
await apply('5 south wall', { min: [S.x0, S.wallBase, S.z1], max: [S.x1, S.wallTop, S.z1] }, BLOCKS.wall);

const southRead = await call('terrainRead', { region: { min: [S.x0, S.wallBase, S.z1], max: [S.x1, S.wallTop, S.z1] } });
const southSolid = (southRead.result?.cells || []).filter((c) => c.b !== 0).length;
console.log(`6 inspect south wall: ${southSolid}/${southRead.result?.total} solid before door`);
await apply('7 carve door', { min: [13, 2, S.z1], max: [14, 3, S.z1] }, BLOCKS.air);

// Deliberately short roof: one row missing. Read the real gap.
const shortRoof = await apply('8 roof attempt (short)', {
  min: [S.x0, S.roof, S.z0],
  max: [S.x1, S.roof, S.z1 - 1],
}, BLOCKS.roof);
const gapRead = await call('terrainRead', { region: { min: [S.x0, S.roof, S.z1], max: [S.x1, S.roof, S.z1] } });
const gapFilled = (gapRead.result?.cells || []).filter((c) => c.b !== 0).length;
console.log(`9 check missing roof row: ${gapFilled}/5 filled (0 = real gap)`);
if (gapFilled !== 0) throw new Error('roof gap check is not clean; aborting instead of faking a correction');
const revert = await call('terrainRevert', { undoToken: shortRoof.undoToken });
revision = revert.result?.newRevision || revert.result?.revisionAfter || revision;
console.log(`10 revert short roof: ${revert.result?.success ? 'ok' : 'FAILED'} op=${revert.result?.operationId} revision=${revision}`);
await sleep(350);
await apply('11 roof correct', { min: [S.x0, S.roof, S.z0], max: [S.x1, S.roof, S.z1] }, BLOCKS.roof);

const finalRead = await call('terrainRead', {
  region: { min: [S.x0 - 1, S.floor, S.z0 - 1], max: [S.x1 + 1, S.roof + 1, S.z1 + 1] },
});
const at = new Map((finalRead.result?.cells || []).map((c) => [`${c.x},${c.y},${c.z}`, c.b]));
const expect = (x, y, z) => at.get(`${x},${y},${z}`) ?? -1;
const problems = [];
for (let x = S.x0; x <= S.x1; x += 1) {
  for (let z = S.z0; z <= S.z1; z += 1) {
    if (expect(x, S.floor, z) !== BLOCKS.floor) problems.push(`floor ${x},${S.floor},${z}`);
    if (expect(x, S.roof, z) !== BLOCKS.roof) problems.push(`roof ${x},${S.roof},${z}`);
    const perimeter = x === S.x0 || x === S.x1 || z === S.z0 || z === S.z1;
    const door = z === S.z1 && (x === 13 || x === 14);
    for (let y = S.wallBase; y <= S.wallTop; y += 1) {
      const expected = perimeter && !(door && y <= 3) ? BLOCKS.wall : BLOCKS.air;
      if (expect(x, y, z) !== expected) problems.push(`cell ${x},${y},${z}=${expect(x, y, z)} expected ${expected}`);
    }
  }
}
const summary = { projectId, revision, site: S, door: { x: [13, 14], y: [2, 3], z: S.z1 }, problemCount: problems.length, problems: problems.slice(0, 20) };
fs.writeFileSync(path.join(logDir, 'hut-result.json'), JSON.stringify(summary, null, 2));
console.log(`\nFINAL revision=${revision} problems=${problems.length}`);
if (problems.length) console.log(problems.slice(0, 10));
else console.log('Structure verified: floor 5x5, 4 walls, 2x2 door, full 5x5 roof.');
