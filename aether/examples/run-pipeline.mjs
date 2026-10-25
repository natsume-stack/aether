/**
 * run-pipeline.mjs — 全链路集成演示：GDD 大脑 → UI 套件（→ 地形/模型，待模块就绪自动接入）
 * 用法：node selftest/integration/run-pipeline.mjs [genre] [W] [H]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGDD } from '../src/muse/muse.mjs';
import { validateGDD } from '../src/muse/gdd-validate.mjs';
import { solveAllResolutions } from '../src/prism/prism-layout.mjs';
import { renderLayoutSheet } from '../src/prism/prism-render.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const genre = process.argv[2] || '像素战争';
const W = Number(process.argv[3] || 512);
const H = Number(process.argv[4] || 512);

const report = { genre, mapSize: [W, H], stages: {} };

// 1) 大脑
const gdd = generateGDD({ genre, mapSize: [W, H], seed: 20261025 });
const v = validateGDD(gdd);
report.stages.brain = { ok: v.ok, zones: v.zoneCount, fun: gdd.fun.scores, artStyle: gdd.artStyle, uiComponents: gdd.ui.components.length, models: gdd.models.length };
fs.writeFileSync(path.join(OUT, 'demo.gdd.json'), JSON.stringify(gdd, null, 2));
if (!v.ok) { console.error('GDD invalid:', v.errors); process.exit(1); }
console.log('[brain]', JSON.stringify(report.stages.brain));

// 2) UI 套件（消费 brain 输出，真实串联）
const layouts = solveAllResolutions({ gdd });
report.stages.ui = {};
for (const [pid, layout] of Object.entries(layouts)) {
  const shot = await renderLayoutSheet({ layout, outDir: path.join(OUT, 'ui'), name: `demo-${pid}`, title: `${gdd.name} ${pid}` });
  report.stages.ui[pid] = { ...layout.metrics, png: shot.pngPath };
  console.log('[ui]', pid, JSON.stringify(layout.metrics));
}

// 3) 地形（模块就绪则接入）
try {
  const { buildTerrainPlan, exportPlanJson } = await import('../src/gaia/terrain-engine.mjs');
  const { renderTopDown, renderIsometric } = await import('../../terrain-render.mjs');
  const plan = buildTerrainPlan(gdd);
  fs.mkdirSync(path.join(OUT, 'terrain'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'terrain', 'topdown.png'), renderTopDown(plan, { scale: 1 }));
  fs.writeFileSync(path.join(OUT, 'terrain', 'iso.png'), renderIsometric(plan, { cellSize: Math.max(2, Math.round(640 / Math.max(...plan.size))) }));
  fs.writeFileSync(path.join(OUT, 'terrain', 'plan.json'), exportPlanJson(plan));
  report.stages.terrain = { ok: true, metrics: plan.metrics, size: plan.size, attempts: (plan.attempt || 0) + 1 };
  console.log('[terrain]', JSON.stringify(plan.metrics));
} catch (e) {
  report.stages.terrain = { pending: true, reason: String(e.message || e).slice(0, 120) };
  console.log('[terrain] pending:', report.stages.terrain.reason);
}

// 4) 模型（模块就绪则接入）
try {
  const { runModelPipeline } = await import('../src/chisel/run-model-v3.mjs');
  const r = await runModelPipeline({ gdd, outDir: path.join(OUT, 'models') });
  report.stages.models = { ok: r.allPass, models: r.summary.length, allPass: r.allPass, acceptance: r.criticSummary.acceptance, ms: r.criticSummary.ms };
  console.log('[models]', JSON.stringify(report.stages.models.acceptance));
} catch (e) {
  report.stages.models = { pending: true, reason: String(e.message || e).slice(0, 120) };
  console.log('[models] pending:', report.stages.models.reason);
}

fs.writeFileSync(path.join(OUT, 'pipeline-report.json'), JSON.stringify(report, null, 2));
console.log('PIPELINE DONE ->', path.join(OUT, 'pipeline-report.json'));
