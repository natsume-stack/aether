#!/usr/bin/env node
/**
 * TerrainEngine 自测 — 内联两份 GDD，生成 TerrainPlan → 渲染 2×2 PNG → 打印 metrics。
 *
 * GDD ①：像素战争 512×512 archipelago，四队出生 + 中央竞技场 + 中立商店
 * GDD ②：修仙 RPG 256×256 continent，中央主峰 + 环山 + 秘境 + 坊市
 *
 * 验收线：陆地占比 0.45–0.75、POI 连通率 100%、zone 平均坡度 ≤ 0.35、
 *         每图 ≥4 个生物群系且 ≥1 条河流。产物存本目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTerrainPlan, exportPlanJson } from '../terrain-engine.mjs';
import { renderTopDown, renderIsometric } from '../terrain-render.mjs';
import { buildExecutionPlan } from '../terrain-executor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = here;

/* ---------------------------------- GDD ①：像素战争 ---------------------------------- */

const GDD_PIXEL_WAR = {
  version: 'GDD/0.1',
  id: 'pixel-war-demo',
  genre: '像素战争',
  artStyle: 'pixel',
  mapSize: [512, 512],
  heightBudget: 64,
  seed: 20261025,
  players: { count: 16, teams: 4 },
  zones: [
    { id: 'z_red', role: 'spawn', name: '红方营地', center: [86, 86], radius: 34, elevationHint: 'plateau-12', biome: '雪原', priority: 1, adjacency: ['z_mid'], gameplayNotes: '出生+商店' },
    { id: 'z_blue', role: 'spawn', name: '蓝方营地', center: [426, 86], radius: 34, elevationHint: 'plateau-12', biome: '雪原', priority: 1, adjacency: ['z_mid'], gameplayNotes: '出生' },
    { id: 'z_green', role: 'spawn', name: '绿方营地', center: [86, 426], radius: 34, elevationHint: 'plateau-11', biome: '草原', priority: 1, adjacency: ['z_mid'], gameplayNotes: '出生' },
    { id: 'z_yellow', role: 'spawn', name: '黄方营地', center: [426, 426], radius: 34, elevationHint: 'plateau-11', biome: '草原', priority: 1, adjacency: ['z_mid'], gameplayNotes: '出生' },
    { id: 'z_mid', role: 'arena', name: '中央竞技场', center: [256, 256], radius: 56, elevationHint: 'arena-6', biome: '沙漠', priority: 0, adjacency: ['z_red', 'z_blue', 'z_green', 'z_yellow'], gameplayNotes: '中央战场' },
    { id: 'z_shop', role: 'shop', name: '中立商店', center: [256, 110], radius: 20, elevationHint: 'plateau-9', biome: '森林', priority: 2, gameplayNotes: '中立交易' },
  ],
  poiGraph: {
    nodes: [
      { id: 'p_red_base', zone: 'z_red', pos: [0, 0, 0], kind: 'bed' },
      { id: 'p_blue_base', zone: 'z_blue', pos: [0, 0, 0], kind: 'bed' },
      { id: 'p_green_base', zone: 'z_green', pos: [0, 0, 0], kind: 'bed' },
      { id: 'p_yellow_base', zone: 'z_yellow', pos: [0, 0, 0], kind: 'bed' },
      { id: 'p_mid', zone: 'z_mid', pos: [0, 0, 0], kind: 'altar' },
      { id: 'p_shop', zone: 'z_shop', pos: [0, 0, 0], kind: 'shop' },
    ],
    edges: [
      { a: 'p_red_base', b: 'p_mid', kind: 'path' },
      { a: 'p_blue_base', b: 'p_mid', kind: 'path' },
      { a: 'p_green_base', b: 'p_mid', kind: 'path' },
      { a: 'p_yellow_base', b: 'p_mid', kind: 'path' },
      { a: 'p_shop', b: 'p_mid', kind: 'path' },
      { a: 'p_red_base', b: 'p_shop', kind: 'path' },
      { a: 'p_blue_base', b: 'p_shop', kind: 'path' },
    ],
  },
  terrain: {
    continentProfile: 'archipelago',
    biomePalette: [
      { biome: '雪原', blocks: { top: 'snow', sub: 'dirt', base: 'stone' }, density: 0.3 },
      { biome: '草原', blocks: { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.3 },
      { biome: '森林', blocks: { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.2 },
      { biome: '沙漠', blocks: { top: 'sand', sub: 'sandstone', base: 'stone' }, density: 0.2 },
      { biome: '山地', blocks: { top: 'stone', sub: 'stone', base: 'stone' }, density: 0.1 },
    ],
    water: { level: 8, bodies: 2 },
    rivers: 2,
    landmarkSilhouettes: ['中央火山'],
    traversal: 'walk',
  },
};

/* ---------------------------------- GDD ②：修仙 RPG ---------------------------------- */

const GDD_XIANXIA = {
  version: 'GDD/0.1',
  id: 'xianxia-rpg',
  genre: '修仙RPG',
  artStyle: 'pixel',
  mapSize: [256, 256],
  heightBudget: 64,
  seed: 20261026,
  players: { count: 1, teams: 1 },
  zones: [
    { id: 'z_sect', role: 'spawn', name: '宗门山门', center: [128, 196], radius: 24, elevationHint: 'plateau-10', biome: '灵田', priority: 1, gameplayNotes: '出生+指引' },
    { id: 'z_market', role: 'shop', name: '坊市', center: [178, 152], radius: 18, elevationHint: 'plateau-8', biome: '竹林', priority: 2, gameplayNotes: '交易' },
    { id: 'z_peak', role: 'boss', name: '主峰之巅', center: [120, 92], radius: 24, elevationHint: 'plateau-34', biome: '雪岭', priority: 0, gameplayNotes: '中央主峰Boss' },
    { id: 'z_secret', role: 'arena', name: '秘境试炼', center: [54, 66], radius: 26, elevationHint: 'arena-6', biome: '丹霞', priority: 1, gameplayNotes: '副本入口' },
  ],
  poiGraph: {
    nodes: [
      { id: 'p_gate', zone: 'z_sect', pos: [0, 0, 0], kind: 'gate' },
      { id: 'p_market', zone: 'z_market', pos: [0, 0, 0], kind: 'shop' },
      { id: 'p_peak', zone: 'z_peak', pos: [0, 0, 0], kind: 'boss' },
      { id: 'p_secret', zone: 'z_secret', pos: [0, 0, 0], kind: 'dungeon' },
    ],
    edges: [
      { a: 'p_gate', b: 'p_market', kind: 'path' },
      { a: 'p_market', b: 'p_peak', kind: 'path' },
      { a: 'p_gate', b: 'p_secret', kind: 'path' },
      { a: 'p_secret', b: 'p_peak', kind: 'path' },
    ],
  },
  terrain: {
    continentProfile: 'continent',
    biomePalette: [
      { biome: '灵田', blocks: { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.3 },
      { biome: '竹林', blocks: { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.25 },
      { biome: '雪岭', blocks: { top: 'snow', sub: 'stone', base: 'stone' }, density: 0.15 },
      { biome: '丹霞', blocks: { top: 'red_sand', sub: 'sandstone', base: 'stone' }, density: 0.15 },
      { biome: '云杉林', blocks: { top: 'grass', sub: 'dirt', base: 'stone' }, density: 0.15 },
    ],
    water: { level: 8, bodies: 1 },
    rivers: 2,
    landmarkSilhouettes: ['中央主峰', '浮岛'],
    traversal: 'walk',
  },
};

/* ---------------------------------- 跑测与输出 ---------------------------------- */

const CASES = [
  { gdd: GDD_PIXEL_WAR, tag: '1-pixel-war', scale: 2 },
  { gdd: GDD_XIANXIA, tag: '2-xianxia', scale: 3 },
];

const rows = [];
for (const c of CASES) {
  const t0 = Date.now();
  const plan = buildTerrainPlan(c.gdd);
  const ms = Date.now() - t0;
  const m = plan.metrics;
  rows.push({ tag: c.tag, m, ms, attempts: plan.attempt + 1 });

  const topPng = renderTopDown(plan, { scale: c.scale });
  const isoPng = renderIsometric(plan, { cellSize: Math.max(2, Math.round(640 / Math.max(...plan.size))) });
  fs.writeFileSync(path.join(outDir, `${c.tag}_topdown.png`), topPng);
  fs.writeFileSync(path.join(outDir, `${c.tag}_iso.png`), isoPng);
  fs.writeFileSync(path.join(outDir, `plan-${c.tag}.json`), exportPlanJson(plan));

  // 执行器 dry-run 冒烟
  const calls = buildExecutionPlan(plan);
  console.log(`[${c.tag}] executor dry-run: ${calls.length} 个调用, 上行 ~${Math.round(calls.reduce((a, x) => a + JSON.stringify(x.args).length, 0) / 1024)} KB`);

  console.log(`[${c.tag}] 生成 ${plan.size[0]}x${plan.size[1]} seed=${plan.seed} attempt=${plan.attempt + 1} 用时 ${ms}ms`);
}

console.log('\n================ metrics 汇总 ================');
console.log('指标                ①像素战争(512)   ②修仙RPG(256)   验收线');
const [a, b] = rows.map((r) => r.m);
const line = (name, va, vb, ok) => console.log(`${name.padEnd(18)}  ${String(va).padEnd(15)}  ${String(vb).padEnd(14)}  ${ok}`);
line('landRatio', a.landRatio, b.landRatio, '0.45-0.75');
line('poiConnectivity', `${(a.poiConnectivity * 100).toFixed(0)}%`, `${(b.poiConnectivity * 100).toFixed(0)}%`, '100%');
line('zoneSlopeMean', a.zoneSlopeMean, b.zoneSlopeMean, '<=0.35');
line('biomeCount(land)', a.biomeCount, b.biomeCount, '>=4');
line('biomeAdjacencyRate', a.biomeAdjacencyRate, b.biomeAdjacencyRate, '>=0.6');
line('rivers', a.rivers, b.rivers, '>=1');
line('lakes', a.lakes, b.lakes, '-');
line('landmarks', a.landmarks, b.landmarks, '-');
line('scatterCount', a.scatterCount, b.scatterCount, '-');
line('pathEdges/bridges', `${a.pathEdges}/${a.bridges}`, `${b.pathEdges}/${b.bridges}`, '-');
line('transitionWidth', JSON.stringify(a.transitionWidth), JSON.stringify(b.transitionWidth), '>0');
line('attempts/elapsed', `${rows[0].attempts}/${rows[0].ms}ms`, `${rows[1].attempts}/${rows[1].ms}ms`, '<30s');

console.log('\nelevationHistogram(8 bins):');
console.log(`  ① ${a.elevationHistogram.join(', ')}`);
console.log(`  ② ${b.elevationHistogram.join(', ')}`);
console.log('biomeCoverage ①', JSON.stringify(a.biomeCoverage));
console.log('biomeCoverage ②', JSON.stringify(b.biomeCoverage));

const checks = rows.map((r) => {
  const m = r.m;
  const ok =
    m.landRatio >= 0.45 && m.landRatio <= 0.75 &&
    m.poiConnectivity === 1 &&
    m.zoneSlopeMean <= 0.35 &&
    m.biomeCount >= 4 &&
    m.rivers >= 1;
  return { tag: r.tag, ok };
});
console.log('\n================ 验收 ================');
for (const c of checks) console.log(`${c.tag}: ${c.ok ? 'PASS' : 'FAIL'}`);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
console.log(`\n产物目录: ${outDir}`);
