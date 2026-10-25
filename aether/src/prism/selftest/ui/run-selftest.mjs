/**
 * UI 主题套件自测：pixel-war(pixel) + 修仙(ink) 两套 HUD × 三分辨率
 * 验收：无重叠、无越界、主题一致率 ≥95%、组件齐全
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveAllResolutions } from '../../prism-layout.mjs';
import { renderLayoutSheet, consistencyAudit } from '../../prism-render.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));

const GDD_PIXEL = {
  version: 'GDD/0.1', id: 'pixel-war-demo', genre: '像素战争', artStyle: 'pixel',
  ui: {
    screens: [{ id: 'hud', purpose: '战斗主界面' }],
    density: 'medium',
    criticalInfo: ['血量', '队伍积分', '剩余时间'],
    components: [
      { kind: 'hotbar', bindings: { slots: 9, selected: 2, items: ['sword', 'block', 'block', 'pickaxe', null, null, 'potion', 'snowball', 'flame'] } },
      { kind: 'hearts', bindings: { max: 10, hp: 17 } },
      { kind: 'armorBar', bindings: { max: 10, val: 6 } },
      { kind: 'hunger', bindings: { max: 10, val: 8 } },
      { kind: 'xpBar', bindings: { level: 24, pct: 0.62 } },
      { kind: 'nameplate', bindings: { name: '红方·矿工阿豪', team: 0, hpPct: 0.85 } },
      { kind: 'bossbar', bindings: { name: '岩浆巨兽', pct: 0.45 } },
      { kind: 'killfeed', bindings: {} },
      { kind: 'minimapFrame', bindings: {} },
      { kind: 'scoreboard', bindings: {} },
      { kind: 'timer', bindings: { seconds: 245, label: '回合剩余' } },
      { kind: 'teamScore', bindings: {} },
      { kind: 'crosshair', bindings: { variant: 'plus' } },
      { kind: 'toast', bindings: {} },
      { kind: 'buffRow', bindings: {} },
      { kind: 'ammoCounter', bindings: { mag: 24, reserve: 96 } },
      { kind: 'shopGrid', bindings: {} },
    ],
  },
};
const GDD_INK = {
  version: 'GDD/0.1', id: 'qingming-hud', genre: '修仙RPG', artStyle: 'ink',
  ui: {
    density: 'airy',
    components: [
      { kind: 'hotbar', bindings: { slots: 5, selected: 0, items: ['sword', 'potion', 'potion', 'star', null] } },
      { kind: 'hearts', bindings: { max: 8, hp: 13 } },
      { kind: 'xpBar', bindings: { level: 9, pct: 0.4 } },
      { kind: 'nameplate', bindings: { name: '青冥子', team: 0, hpPct: 1 } },
      { kind: 'bossbar', bindings: { name: '心魔·问心劫', pct: 0.7 } },
      { kind: 'minimapFrame', bindings: {} },
      { kind: 'scoreboard', bindings: { teams: [{ name: '炼气', score: 3, team: 0 }, { name: '筑基', score: 2, team: 2 }] } },
      { kind: 'timer', bindings: { seconds: 372, label: '闭关剩余' } },
      { kind: 'teamScore', bindings: { teams: [{ team: 0, score: 3 }, { team: 2, score: 2 }] } },
      { kind: 'toast', bindings: { lines: ['打坐 +12 修为', '顿悟：剑意+1'] } },
      { kind: 'buffRow', bindings: { buffs: [{ icon: 'star', sec: 42 }, { icon: 'flame', sec: 8 }] } },
      { kind: 'crosshair', bindings: {} },
    ],
  },
};

const report = { suites: [] };
let failed = false;
for (const gdd of [GDD_PIXEL, GDD_INK]) {
  const layouts = solveAllResolutions({ gdd });
  const suite = { id: gdd.id, artStyle: gdd.artStyle, resolutions: [] };
  for (const [profileId, layout] of Object.entries(layouts)) {
    const shot = await renderLayoutSheet({ layout, outDir: path.join(OUT, gdd.id), name: `${gdd.id}-${profileId}`, title: `${gdd.genre} HUD · ${profileId}` });
    const audit = consistencyAudit(layout);
    suite.resolutions.push({ profileId, ...layout.metrics, consistency: audit.ratio, png: shot.pngPath });
    if (layout.metrics.overlapCount !== 0 || layout.metrics.outOfBoundsCount !== 0 || audit.ratio < 0.95) failed = true;
  }
  report.suites.push(suite);
  console.log(JSON.stringify(suite, null, 1));
}
fs.writeFileSync(path.join(OUT, 'selftest-report.json'), JSON.stringify(report, null, 2));
console.log(failed ? 'SELFTEST FAILED' : 'SELFTEST PASSED');
process.exit(failed ? 1 : 0);
