/**
 * map-bench.mjs — 建图等级评测器（MapBench/1.0）
 *
 * 「95 分」必须可测量。本评测器消费 run-pipeline 的产物（pipeline-report.json
 * + 各阶段文件），输出 0-100 的建图等级与逐柱明细，任何一柱瘸腿都压总分。
 * 五柱（权重）：
 *   structure  0.20  GDD 结构健康：fun 四维、POI 图连通、分区多样性
 *   terrain    0.25  地形质量：硬指标违约、陆地占比居中度、构成多样性（水/路/地标/散布）
 *   ui         0.15  UI 质量：三分辨率 0 重叠/0 越界、信息密度、移动端降级合理性
 *   models     0.25  模型质量：门禁、critic 分、调色板熵域、动画覆盖、产能（数量/种类）
 *   cohesion   0.15  全链一致性：风格贯通、模型-POI 覆盖、尺寸适配、阶段全绿
 *
 * 用法：node src/bench/map-bench.mjs --report=examples/pipeline-report.json [--out=bench-report.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const inRange = (v, [lo, hi]) => (v >= lo && v <= hi ? 1 : 0);
/** 线性落分：v 越接近 [lo,hi] 中点越高（超出区间线性衰减到 0） */
const centered = (v, lo, hi) => {
  if (v >= lo && v <= hi) {
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2;
    return 70 + 30 * (1 - Math.abs(v - mid) / half);
  }
  const dist = v < lo ? lo - v : v - hi;
  return Math.max(0, 70 - dist * 200);
};

function scoreStructure(report) {
  const brain = report.stages?.brain;
  if (!brain?.ok) return { score: 0, issues: ['GDD 阶段未通过'] };
  const fun = brain.fun || {};
  const funVals = ['clarity', 'pacing', 'balance', 'depth'].map((k) => fun[k] ?? 0);
  const funScore = (funVals.reduce((s, v) => s + v, 0) / funVals.length);
  const issues = [];
  if (Math.min(...funVals) < 75) issues.push(`fun 最短板 ${Math.min(...funVals)} < 75`);
  const zoneCount = brain.zones || 0;
  const zoneScore = centered(zoneCount, 6, 14);
  return { score: Math.round(funScore * 0.75 + zoneScore * 0.25), issues };
}

function scoreTerrain(report) {
  const t = report.stages?.terrain;
  if (!t?.ok) return { score: 0, issues: ['地形阶段未通过'] };
  const m = t.metrics || {};
  const issues = [];
  if ((m.violations || []).length) issues.push(`硬指标违约 ${m.violations.length} 项`);
  let score = 100;
  score -= (m.violations || []).length * 18;
  const land = centered(m.landRatio ?? 0.5, 0.45, 0.75) * 0.9;
  // 构成多样性：按 256² 等效面积归一（大地图要素必须随面积缩放，否则稀释扣分）
  const factor = Math.max(0.5, ((t.size?.[0] ?? 256) * (t.size?.[1] ?? 256)) / (256 * 256));
  const per = (n) => (n || 0) / factor;
  const rivers = per((m.rivers || 0) + (m.lakes || 0));
  const diversity = (
    inRange(rivers, [1, 5]) * 30 +
    inRange(per(m.pathEdges), [2, 12]) * 25 +
    inRange(per(m.landmarks), [0.6, 3]) * 25 +
    inRange(per(m.scatterCount), [60, 600]) * 20
  );
  score = score * 0.55 + land * 0.25 + diversity * 0.20;
  if (rivers < 1) issues.push('水系密度低于 256² 等效 1 条（大地图要素未随尺寸缩放）');
  if ((m.landmarks || 0) === 0) issues.push('无轮廓地标');
  return { score: Math.round(clamp(score, 0, 100)), issues };
}

function scoreUi(report) {
  const ui = report.stages?.ui || {};
  const profiles = Object.entries(ui).filter(([k]) => k !== 'review');
  if (!profiles.length) return { score: 0, issues: ['无 UI 产物'] };
  const issues = [];
  let score = 100;
  let placedTotal = 0;
  for (const [name, s] of profiles) {
    score -= (s.overlapCount || 0) * 15 + (s.outOfBoundsCount || 0) * 15;
    placedTotal += s.placed || 0;
    if (name === 'mobile' && (s.hidden || 0) > (s.placed || 0)) issues.push('移动端隐藏组件多于保留（降级失衡）');
  }
  const density = placedTotal / profiles.length;
  if (density < 6) issues.push(`平均组件数 ${density} 偏少（信息密度低）`);
  const review = ui.review;
  if (review?.scores) {
    score = score * 0.8 + ((review.scores.contrast + review.scores.alignment + review.scores.rhythm) / 3) * 0.2;
    for (const i of review.issues || []) issues.push(i);
  }
  return { score: Math.round(clamp(score, 0, 100)), issues };
}

function scoreModels(report) {
  const models = report.stages?.models;
  if (!models?.ok) return { score: 0, issues: ['模型阶段未通过'] };
  const issues = [];
  let score = 100;
  const detail = models.details || models.summary || [];
  const list = Array.isArray(detail) ? detail : [];
  if (!models.allGatesPass && !models.acceptance?.allGatesPass) { score -= 25; issues.push('存在未过门禁的模型'); }
  const scores = list.map((s) => s.score ?? 10);
  const avg = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : 10;
  score = score * 0.7 + (avg / 10) * 100 * 0.3;
  if ((models.models || list.length) < 4) { score -= 10; issues.push('模型数量 <4（场景空旷）'); }
  const acc = models.acceptance || {};
  if (!acc.entropyInRange) { score -= 8; issues.push('调色板熵越域'); }
  if (!acc.silhouetteSingleRate === false) { /* noop */ }
  if (acc.floatingAfterRepair > 0) { score -= 6; issues.push(`悬浮簇 ${acc.floatingAfterRepair} 未清零`); }
  if ((acc.silhouetteSingleRate ?? 1) < 1) { score -= 5; issues.push('存在多主体剪影'); }
  return { score: Math.round(clamp(score, 0, 100)), issues };
}

function scoreCohesion(report) {
  const stages = report.stages || {};
  const issues = [];
  let score = 100;
  const allOk = ['brain', 'terrain', 'models'].every((k) => stages[k]?.ok);
  if (!allOk) { score -= 40; issues.push('存在未过闸的阶段'); }
  // 模型-POI 覆盖：GDD 系统需要的模型是否都被产能覆盖（brain.models 数 vs models 产能）
  const needed = (stages.brain?.models || 0) + (stages.brain?.uiComponents ? 0 : 0);
  const produced = stages.models?.models || 0;
  if (needed && produced < needed) { score -= 12; issues.push(`模型产能 ${produced} < GDD 需求 ${needed}`); }
  // 尺寸适配：地形尺寸与 UI 分辨率阶段齐备
  if (!stages.ui || !Object.keys(stages.ui).length) { score -= 20; issues.push('UI 阶段缺失'); }
  const t = stages.terrain?.metrics || {};
  if ((t.transitionWidth?.mean ?? 0) < 4) { score -= 8; issues.push('生物群系过渡带过窄（色块生硬）'); }
  return { score: Math.round(clamp(score, 0, 100)), issues };
}

const PILLARS = [
  ['structure', 0.20, scoreStructure],
  ['terrain', 0.25, scoreTerrain],
  ['ui', 0.15, scoreUi],
  ['models', 0.25, scoreModels],
  ['cohesion', 0.15, scoreCohesion],
];

export function grade(report) {
  const pillars = {};
  let total = 0;
  for (const [name, weight, fn] of PILLARS) {
    const { score, issues } = fn(report);
    pillars[name] = { score, weight, issues };
    total += score * weight;
  }
  const gradeValue = Math.round(total * 10) / 10;
  const letter = gradeValue >= 95 ? 'S' : gradeValue >= 90 ? 'A' : gradeValue >= 80 ? 'B' : gradeValue >= 70 ? 'C' : 'D';
  return {
    version: 'MapBench/1.0', grade: gradeValue, letter,
    verdict: gradeValue >= 95 ? '顶尖' : gradeValue >= 90 ? '优秀' : gradeValue >= 80 ? '良好' : '及格线附近',
    pillars, blockers: PILLARS.flatMap(([name]) => (pillars[name].issues || []).map((i) => `[${name}] ${i}`)),
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) args[a.slice(2)] = true;
    else args[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const reportPath = args.report || 'examples/pipeline-report.json';
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, ''));
  const result = grade(report);
  const out = args.out || path.join(path.dirname(reportPath), 'bench-report.json');
  fs.writeFileSync(out, JSON.stringify({ ...result, source: reportPath, at: new Date().toISOString() }, null, 2));
  console.log(`MapBench 等级: ${result.grade} (${result.letter} · ${result.verdict})`);
  for (const [name, p] of Object.entries(result.pillars)) {
    console.log(`  ${name.padEnd(10)} ${String(p.score).padStart(3)}  (权重 ${p.weight})${p.issues.length ? `  ← ${p.issues.join('; ')}` : ''}`);
  }
  if (result.blockers.length) console.log(`拉分项:\n  - ${result.blockers.join('\n  - ')}`);
  console.log(`报告: ${out}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
