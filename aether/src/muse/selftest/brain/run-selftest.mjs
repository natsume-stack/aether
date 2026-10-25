/**
 * game-design-brain 自测：5 类型 GDD 全过校验 + fun 分数 + zone 布局 ASCII
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGDD } from '../../muse.mjs';
import { validateGDD } from '../../gdd-validate.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const CASES = [
  { genre: '像素战争', mapSize: [512, 512], seed: 20261025 },
  { genre: '起床战争', mapSize: [256, 256], seed: 7 },
  { genre: '修仙', mapSize: [256, 256], seed: 42 },
  { genre: '夺旗', mapSize: [384, 384], seed: 99 },
  { genre: '大逃杀', mapSize: [512, 512], seed: 123 },
];
let failed = false;
const summary = [];
for (const c of CASES) {
  const gdd = generateGDD(c);
  const v = validateGDD(gdd);
  fs.writeFileSync(path.join(OUT, `${gdd.id}.gdd.json`), JSON.stringify(gdd, null, 2));
  const min = Math.min(...Object.values(gdd.fun.scores));
  summary.push({ id: gdd.id, ok: v.ok, zones: v.zoneCount, pois: v.poiCount, fun: gdd.fun.scores, warnings: v.warnings });
  console.log(`\n== ${gdd.id} (${gdd.artStyle}) ==`);
  console.log(`validate: ${v.ok ? 'PASS' : 'FAIL ' + v.errors.join(';')} | zones=${v.zoneCount} pois=${v.poiCount} | fun=${JSON.stringify(gdd.fun.scores)}`);
  if (gdd.fun.notes.length) console.log('notes:', gdd.fun.notes.join('；'));
  console.log(asciiMap(gdd));
  // 验收线
  const pixelGdd = gdd.id.startsWith('像素战争');
  if (!v.ok || min < 70) failed = true;
  if (pixelGdd) {
    const kinds = new Set(gdd.ui.components.map((x) => x.kind));
    for (const need of ['hotbar', 'hearts', 'nameplate', 'scoreboard', 'killfeed', 'timer']) if (!kinds.has(need)) { console.log('缺少组件', need); failed = true; }
  }
  if (gdd.id.startsWith('大逃杀') && gdd.zones.length < 8) { console.log('大逃杀 zones 不足 8'); failed = true; }
}
fs.writeFileSync(path.join(OUT, 'brain-summary.json'), JSON.stringify(summary, null, 2));
console.log(failed ? '\nSELFTEST FAILED' : '\nSELFTEST PASSED');
process.exit(failed ? 1 : 0);

function asciiMap(gdd) {
  const [W, H] = gdd.mapSize;
  const cols = 48, rows = 24;
  const grid = Array.from({ length: rows }, () => Array(cols).fill('·'));
  const ROLE_CHAR = { spawn: 'S', hub: 'H', arena: 'A', resource: 'R', boss: 'B', shop: '$', objective: 'O', transition: 'T' };
  for (const z of gdd.zones) {
    const x = Math.min(cols - 1, Math.max(0, Math.round((z.center[0] / W) * cols)));
    const y = Math.min(rows - 1, Math.max(0, Math.round((z.center[1] / H) * rows)));
    grid[y][x] = ROLE_CHAR[z.role] || '?';
    const rr = Math.max(1, Math.round((z.radius / Math.min(W, H)) * rows));
    for (let dy = -rr; dy <= rr; dy += 1) for (let dx = -Math.round(rr * 2); dx <= Math.round(rr * 2); dx += 1) {
      const gx = x + dx, gy = y + dy;
      if (gx >= 0 && gx < cols && gy >= 0 && gy < rows && (dx / 2) ** 2 + dy ** 2 <= rr ** 2 && grid[gy][gx] === '·') grid[gy][gx] = '░';
    }
  }
  return grid.map((r) => r.join('')).join('\n');
}
