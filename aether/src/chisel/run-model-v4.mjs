#!/usr/bin/env node
/**
 * run-model-v4.mjs — chisel v4「像人一样建模」编排
 *
 * 八阶段：① 意图(ModelBrief) → ② 概念(剪影草图+部件树) → ③ blockout(结构先于外观)
 * → ④ 细雕(解释执行) → ⑤ 上色(调色板纪律) → ⑥ 评审(四视图+等距渲染, 确定性指标
 * +可选 VLM 判官) → ⑦ 打磨(autoRepair 循环) → ⑧ 沉淀(部件模板入库)。
 *
 * 与 v3 的差别：v3 每类模型一个手写程序（新题材=写代码）；v4 题材=一份
 * ModelBrief 数据（sculpt-composer 解释执行），配 silhouette IoU 结构闸。
 * v3 序列化/门禁层（bundle/gates）原样复用，验收口径不降。
 *
 * 用法：
 *   node run-model-v4.mjs --brief=<file|json> --out=<dir>
 *   node run-model-v4.mjs --selftest [--out=selftest/model-v4]
 * 环境变量：
 *   VOXA_ROOT               指向 apps/voxa（默认同 v3）
 *   BOX_VISION_JUDGE_CMD    可选：外部视觉判官命令（stdin=JSON，stdout={score,comments}）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  criticSculpt, autoRepairLoop, fitToSizeHint,
} from './model-sculpt.mjs';
import { composeModel, naturalSize } from './sculpt-composer.mjs';
import { renderOrthoViews, silhouetteIoU } from './render-views.mjs';
import { renderSoftwarePreview } from './preview-renderer.mjs';
import {
  encodeView, nodeJson, modelBounds, buildProjectJson, buildModelDataJson,
  writeBundle, statsOf, gateCheck, pseudoProject, cid,
} from './run-model-v3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOXA_ROOT = process.env.VOXA_ROOT || 'D:/desktop/神奇代码岛/box3-local-engine/apps/voxa';
const requireFromVoxa = createRequire(path.join(VOXA_ROOT, 'package.json'));
const vp = requireFromVoxa('@box/voxa-project');
const JSZip = requireFromVoxa('jszip');
const { Mesher } = requireFromVoxa('@box/mesher');

const GATES = { minPalette: 28, minUsedColors: 12, minRects: 160, minTexels: 1200 };

/* ---------------- ⑥ 评审：视觉判官钩子 ---------------- */
/**
 * 可插拔视觉判官：BOX_VISION_JUDGE_CMD 设置时，把四视图路径 + 确定性指标
 * 以 JSON 喂给外部命令（VLM/人工代理），期待 stdout JSON：
 *   { score: 0-10, comments: [{ target, action, detail }] }
 * 未设置/失败/超时 → 返回 null，管线以确定性指标继续（绝不因此中断）。
 */
export function visionJudge({ brief, views, deterministic, timeoutMs = 90_000 }) {
  const cmd = String(process.env.BOX_VISION_JUDGE_CMD || '').trim();
  if (!cmd) return null;
  const payload = JSON.stringify({
    subject: brief.subject, style: brief.style, intent: brief.mood || [],
    views, deterministic,
  });
  try {
    const res = spawnSync(cmd, { input: payload, timeout: timeoutMs, shell: true, encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) throw new Error(res.stderr?.slice(0, 200) || `exit ${res.status}`);
    const parsed = JSON.parse(res.stdout);
    if (typeof parsed.score !== 'number') throw new Error('score 缺失');
    return parsed;
  } catch (error) {
    return { score: null, comments: [], warning: `vision judge 不可用: ${String(error.message || error).slice(0, 160)}` };
  }
}

/* ---------------- 管线 ---------------- */
export async function buildOneBrief({ brief, outDir, log = () => {} }) {
  const t0 = Date.now();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'brief.json'), JSON.stringify(brief, null, 2));

  /* ③ blockout：先按 brief 组装（含上色，但结构闸先行——不达标不进评审） */
  let model = composeModel(brief, { log });
  const naturalBefore = naturalSize(model.groups);
  log(`composed: ${model.groups.length} parts, natural ${naturalBefore.join('x')}`);

  const sizeHint = brief.sizeHint && brief.sizeHint.length === 3 ? brief.sizeHint : naturalBefore;
  const fitted = fitToSizeHint(model, sizeHint);
  model = fitted.model || model;

  /* ③' 结构闸：剪影 IoU（brief.silhouette 提供时） */
  const viewsDir = path.join(outDir, 'views');
  const structure = { silhouetteIoU: {} };
  try {
    const rendered = renderOrthoViews(model, { outDir: viewsDir, size: 320 });
    for (const [viewName, r] of rendered) {
      const target = brief.silhouette?.[viewName === 'front' ? 'front' : viewName === 'left' ? 'side' : null];
      const iou = target ? silhouetteIoU(r.silhouette, r.grid, target) : null;
      if (iou !== null) structure.silhouetteIoU[viewName] = Number(iou.toFixed(3));
    }
  } catch (error) {
    log(`warn: 视图渲染失败 ${String(error.message || error).slice(0, 120)}`);
  }

  /* ⑦ 打磨：确定性 critic + autoRepair（≤3 轮，含悬浮簇焊接/熵平衡/口吃平滑） */
  const before = criticSculpt(model, { sizeHint });
  const repair = autoRepairLoop(model, { sizeHint, log });
  const after = repair.after;

  /* ⑥ 评审渲染：四视图 + 等距软渲染 */
  let views = {};
  try {
    const rendered = renderOrthoViews(model, { outDir: viewsDir, size: 320 });
    views = Object.fromEntries([...rendered.entries()].map(([k, v]) => [k, v.file]));
  } catch { /* 结构闸已记 warn */ }
  const isoDir = path.join(outDir, 'model');
  fs.mkdirSync(isoDir, { recursive: true });
  const isoPath = path.join(isoDir, 'model-preview.png');
  let iso = null;
  try {
    iso = await renderSoftwarePreview({ ...pseudoProject(model), outFile: isoPath, size: 384, background: '#10161f' });
    views.iso = isoPath;
  } catch (error) {
    log(`warn: 等距渲染失败 ${String(error.message || error).slice(0, 120)}`);
  }

  /* ⑤ 门禁统计（与 v3 同一口径） */
  const { project: projectJson, bounds } = buildProjectJson(model);
  const mesher = new Mesher(true, true, false);
  for (const g of model.groups) mesher.addModel(g.sculptor.toView(), 3);
  const meshes = mesher.getMeshes();
  const meshTexture = await mesher.getTexture(
    model.palette.items.map((i) => i.rgb),
    model.palette.items.map((i) => i.emissive),
  );
  const modelJson = buildModelDataJson(model, { meshes }, bounds);
  modelJson.texture = meshTexture;
  const projectSchema = vp.projectV10.ProjectDataV10Schema.fromJSON(projectJson);
  const modelSchema = vp.modelV7.ModelDataV7Schema.fromJSON(modelJson);
  const meta = {
    version: 7,
    projectName: brief.subject || 'v4-model',
    bounds: bounds.size.map((v) => Math.round(v)),
    motionList: (model.animations || []).map((a) => ({ id: a.id, name: a.name, duration: a.duration })),
    useCustomBounds: true,
    customBounds: { size: bounds.size.map((v) => Math.round(v)), offset: [0, 0, 0] },
    renderBoxOffset: [0, 0, 0],
  };
  const bundleName = (brief.subject || 'v4-model').replace(/[^\p{L}\p{N}-]+/gu, '-').toLowerCase();
  const out = await writeBundle({
    projectSchema, modelSchema, meta,
    previewPng: fs.existsSync(isoPath) ? fs.readFileSync(isoPath) : Buffer.alloc(0),
    outFile: path.join(outDir, `${bundleName}.voxaproject`),
  });

  const st = statsOf(out.dataBytes);
  const surface = 2 * (bounds.size[0] * bounds.size[1] + bounds.size[0] * bounds.size[2] + bounds.size[1] * bounds.size[2]);
  const gate = gateCheck(st, { surface, dims: bounds.size });
  // 调色板门禁按部件数缩放（与小模型 rects/texels 密度门槛同理）：每部件一族色阶，
  // 2 部件模型的理论上限到不了 28——这不是模型差，是阈值没分档。
  const partCount = Math.max(1, (brief.parts || model.groups).length);
  if (partCount <= 4) {
    const minPalette = Math.min(GATES.minPalette, 5 + 6 * partCount);
    const minUsed = Math.min(GATES.minUsedColors, 3 + 3 * partCount);
    gate.palette = st.palette >= minPalette;
    gate.usedColors = st.usedColors >= minUsed;
    gate.pass = Object.values(gate).every(Boolean);
  }
  const gatesPass = Object.values(gate).every(Boolean);
  const fill = after.hintFill || [1, 1, 1];
  const boundsOk = fill.every((r) => r >= 0.85 && r <= 1.05);
  const iouValues = Object.values(structure.silhouetteIoU);
  const iouThreshold = Number(brief.silhouetteThreshold ?? 0.5);
  const silhouetteOk = !iouValues.length || iouValues.every((v) => v >= iouThreshold);
  const animOk = !brief.animated || (model.animations || []).length >= 1;

  /* ⑥ 视觉判官（可选） */
  const judge = visionJudge({
    brief, views: Object.values(views), deterministic: { score: after.score, gates: gate, silhouetteIoU: structure.silhouetteIoU },
  });
  if (judge?.warning) log(`warn: ${judge.warning}`);

  const pass = gatesPass && boundsOk && silhouetteOk && animOk && after.pass !== false;
  const ms = Date.now() - t0;
  const report = {
    version: 'ModelReport/0.4-brief-v4',
    subject: brief.subject, style: brief.style, requested: { sizeHint, animated: Boolean(brief.animated) },
    composed: { parts: model.groups.map((g) => ({ id: g.id, filled: g.sculptor.count() })), naturalBefore },
    critic: {
      before: { score: before.score, issues: before.issues },
      after: { score: after.score, issues: after.issues, entropy: after.paletteEntropy, floating: after.floatingClusters },
      repaired: repair.changed, rounds: repair.rounds.map((r) => ({ round: r.round, actions: r.actions })),
    },
    structure: { silhouetteIoU: structure.silhouetteIoU, silhouetteOk, boundsFill: fill, boundsOk, animOk, animations: (model.animations || []).length },
    stats: st, gates: { ...gate, pass: gatesPass }, pass,
    judge,
    views,
    hashes: { project: cid(out.projectBytes), modelData: cid(out.dataBytes) },
    ms,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  log(`v4 ${brief.subject}: score ${before.score}→${after.score} gates=${gatesPass ? 'PASS' : 'FAIL'} iou=${JSON.stringify(structure.silhouetteIoU)} ${ms}ms`);
  return { report, model, pass };

  /* ⑧ 沉淀在 runBriefPipeline 末尾统一做（success 才入库） */
}

/** ⑧ 沉淀：成功产物入库（library/<slug>.brief.json + index.json） */
function distill(brief, outDir, report) {
  const libDir = path.join(__dirname, 'library');
  fs.mkdirSync(libDir, { recursive: true });
  const slug = (brief.subject || 'model').replace(/[^\p{L}\p{N}-]+/gu, '-').toLowerCase();
  fs.writeFileSync(path.join(libDir, `${slug}.brief.json`), JSON.stringify({ ...brief, _distilledFrom: outDir, _score: report.critic.after.score }, null, 2));
  const indexPath = path.join(libDir, 'index.json');
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { /* first entry */ }
  const entry = { slug, subject: brief.subject, style: brief.style, score: report.critic.after.score, at: new Date().toISOString() };
  index = index.filter((e) => e.slug !== slug).concat(entry);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return entry;
}

export async function runBriefPipeline({ brief, outDir, log = (s) => console.log(s), distill: distillOn = true }) {
  if (typeof brief === 'string') brief = JSON.parse(fs.readFileSync(brief, 'utf8').replace(/^\uFEFF/, ''));
  if (!brief.parts?.length) throw new Error('brief.parts 为空：v4 消费 ModelBrief/1.0（见 skills/box3-voxa-modeling/reference/model-brief.md）');
  const { report, model, pass } = await buildOneBrief({ brief, outDir, log });
  let distilled = null;
  if (pass && distillOn) distilled = distill(brief, outDir, report);
  fs.writeFileSync(path.join(outDir, 'status-model-v4.json'), JSON.stringify({
    version: 'N17ModelStatusV4/0.1', subject: brief.subject, pass, score: report.critic.after.score,
    gates: report.gates, structure: report.structure, judgeScore: report.judge?.score ?? null, distilled: distilled?.slug ?? null,
  }, null, 2));
  log(pass ? 'BRIEF PASS' : 'BRIEF FAIL');
  return { report, model, pass, distilled };
}

/* ---------------- CLI / selftest ---------------- */
function demoBriefs() {
  return [
    {
      version: 'ModelBrief/1.0', subject: '青铜丹炉', style: 'ink', subjectType: 'prop',
      mood: ['古朴', '温润'], animated: true,
      sizeHint: [28, 35, 28],
      parts: [
        {
          id: 'furnace_body', role: 'body', position: [2, 0, 2], size: [24, 32, 24],
          shape: { primitives: [{ op: 'lathe', profile: [[0, 8], [2, 10], [6, 11], [12, 9], [18, 7], [24, 5], [27, 6]] }] },
          paint: { hex: '#8c6a3f', steps: 9, vRange: [0.55, 1.1], hueShift: 8, rampT: 'height', noise: 0.14, edge: { lighten: 0.16, n: 5 } },
        },
        {
          id: 'furnace_ear_l', role: 'attachment', position: [0, 18, 9], size: [6, 8, 6],
          shape: { primitives: [{ op: 'torusZ', center: [3, 4, 3], R: 3.4, r: 1.1 }] },
          paint: { hex: '#6f5430', steps: 6, vRange: [0.5, 1.0], rampT: 'depth', noise: 0.12, edge: { lighten: 0.2, n: 4 } },
        },
        {
          id: 'furnace_ear_r', role: 'attachment', position: [22, 18, 9], size: [6, 8, 6],
          shape: { primitives: [{ op: 'torusZ', center: [3, 4, 3], R: 3.4, r: 1.1 }] },
          paint: { hex: '#6f5430', steps: 6, vRange: [0.5, 1.0], rampT: 'depth', noise: 0.12, edge: { lighten: 0.2, n: 4 } },
        },
        {
          id: 'furnace_fire', role: 'detail', position: [8, 2, 8], size: [12, 6, 12],
          shape: { primitives: [{ op: 'ell', center: [6, 2, 6], r: [5, 2.5, 5] }] },
          paint: { hex: '#ff8c42', steps: 5, vRange: [0.9, 1.3], rampT: 'depthLight', noise: 0.2, glow: { hex: '#ffb46e', depth: 1.5, emissive: 1 } },
        },
      ],
      bones: [{ id: 'bone_body', name: 'Body', position: [14, 0, 14] }],
      animations: [{ id: 'idle_glow', type: 'float', bone: 'bone_body', amplitude: 1.5, period: 3.2 }],
    },
    {
      version: 'ModelBrief/1.0', subject: '仙鹤', style: 'ink', subjectType: 'creature',
      mood: ['清逸', '灵动'], animated: true,
      sizeHint: [38, 44, 30],
      parts: [
        {
          id: 'crane_body', role: 'body', position: [12, 16, 8], size: [16, 12, 12],
          shape: { primitives: [{ op: 'ell', center: [8, 6, 6], r: [8, 5, 5.5] }] },
          paint: { hex: '#e8e4da', steps: 7, vRange: [0.78, 1.12], rampT: 'height', noise: 0.08, edge: { lighten: 0.12, n: 5 } },
        },
        {
          id: 'crane_neck', role: 'attachment', position: [22, 24, 11], size: [12, 16, 6],
          shape: { primitives: [{ op: 'tube', bezier: true, points: [[1, 2, 3], [5, 6, 3], [9, 12, 3], [11, 15, 3]], rFrom: 2.2, rTo: 1.2 }] },
          paint: { hex: '#efece4', steps: 6, vRange: [0.8, 1.12], rampT: 'height', noise: 0.06, edge: { lighten: 0.12, n: 5 } },
        },
        {
          id: 'crane_beak', role: 'detail', position: [33, 38, 12], size: [6, 3, 3],
          shape: { primitives: [{ op: 'capsule', a: [0, 1, 1], b: [5, 1.4, 1], r: 0.9 }] },
          paint: { hex: '#c8873c', steps: 4, vRange: [0.7, 1.05], rampT: 'height', noise: 0.05 },
        },
        {
          id: 'crane_wing_l', role: 'attachment', position: [10, 24, 0], size: [14, 8, 10], bone: 'bone_wing_l',
          shape: { primitives: [{ op: 'ell', center: [7, 4, 5], r: [7, 1.6, 5] }] },
          paint: { hex: '#dcd7cb', steps: 6, vRange: [0.72, 1.06], rampT: 'height', noise: 0.1, edge: { lighten: 0.14, n: 5 } },
        },
        {
          id: 'crane_wing_r', role: 'attachment', position: [10, 24, 20], size: [14, 8, 10], bone: 'bone_wing_r',
          shape: { primitives: [{ op: 'ell', center: [7, 4, 5], r: [7, 1.6, 5] }] },
          paint: { hex: '#dcd7cb', steps: 6, vRange: [0.72, 1.06], rampT: 'height', noise: 0.1, edge: { lighten: 0.14, n: 5 } },
        },
        {
          id: 'crane_tail', role: 'attachment', position: [2, 18, 9], size: [10, 6, 8],
          shape: { primitives: [{ op: 'ell', center: [5, 3, 4], r: [5, 1.8, 3.6] }] },
          paint: { hex: '#4a4a52', steps: 5, vRange: [0.55, 0.95], rampT: 'depth', noise: 0.1 },
        },
        {
          id: 'crane_leg_l', role: 'attachment', position: [14, 2, 12], size: [3, 16, 3],
          shape: { primitives: [{ op: 'capsule', a: [1.5, 16, 1.5], b: [1.5, 0.5, 1.5], r: 0.8 }] },
          paint: { hex: '#8a7a5c', steps: 4, vRange: [0.6, 1.0], rampT: 'height', noise: 0.06 },
        },
        {
          id: 'crane_leg_r', role: 'attachment', position: [20, 2, 12], size: [3, 16, 3],
          shape: { primitives: [{ op: 'capsule', a: [1.5, 16, 1.5], b: [1.5, 0.5, 1.5], r: 0.8 }] },
          paint: { hex: '#8a7a5c', steps: 4, vRange: [0.6, 1.0], rampT: 'height', noise: 0.06 },
        },
      ],
      bones: [
        { id: 'bone_body', name: 'Body', position: [20, 20, 14] },
        { id: 'bone_wing_l', name: 'WingL', position: [16, 27, 6] },
        { id: 'bone_wing_r', name: 'WingR', position: [16, 27, 22] },
      ],
      animations: [
        { id: 'flap', type: 'sway', bone: 'bone_wing_l', amplitude: 3, period: 1.8 },
        { id: 'flap_r', type: 'sway', bone: 'bone_wing_r', amplitude: 3, period: 1.8 },
        { id: 'hover', type: 'float', bone: 'bone_body', amplitude: 2, period: 2.6 },
      ],
    },
    {
      // 剪影驱动 blockout 示例：shape 只写 fromSilhouette，轮廓由 silhouette.front 生成
      version: 'ModelBrief/1.0', subject: '雪原信标塔', style: 'pixel', subjectType: 'landmark',
      mood: ['凛冽', '指引'], animated: true,
      sizeHint: [20, 34, 20],
      silhouette: {
        front: [[0.28, 0], [0.60, 0.05], [0.50, 0.30], [0.66, 0.52], [0.48, 0.70], [0.64, 0.86], [0.72, 0.93], [0.36, 0.97], [0.70, 1.0], [0.28, 0]],
        side: [[0.28, 0], [0.60, 0.05], [0.50, 0.30], [0.66, 0.52], [0.48, 0.70], [0.64, 0.86], [0.72, 0.93], [0.36, 0.97], [0.70, 1.0], [0.28, 0]],
      },
      silhouetteThreshold: 0.2, // 概念草图闸：剪影只约束塔身体量，不做逐段轮廓锁定
      parts: [
        {
          id: 'beacon_spire', role: 'body', position: [1, 1, 1], size: [18, 32, 18],
          shape: { fromSilhouette: 'front' },
          paint: { hex: '#7f93a8', steps: 8, vRange: [0.55, 1.12], rampT: 'height', noise: 0.12, edge: { lighten: 0.18, n: 5 } },
        },
        {
          id: 'beacon_flame', role: 'detail', position: [6, 30, 6], size: [8, 5, 8],
          shape: { primitives: [{ op: 'ell', center: [4, 2, 4], r: [3.4, 2.2, 3.4] }] },
          paint: { hex: '#ffd27a', steps: 5, vRange: [0.95, 1.35], rampT: 'depthLight', noise: 0.18, glow: { hex: '#ffe9b0', depth: 1.2, emissive: 1 } },
        },
      ],
      bones: [{ id: 'bone_body', name: 'Body', position: [10, 0, 10] }],
      animations: [{ id: 'beacon_pulse', type: 'alpha', bone: 'bone_body', amplitude: 3, period: 2.2 }],
    },
  ];
}

async function selftest(outDir) {
  const log = (s) => console.log(`[selftest] ${s}`);
  const results = [];
  for (const [i, brief] of demoBriefs().entries()) {
    const dir = path.join(outDir, (brief.subject || `b${i}`).replace(/[^\p{L}\p{N}-]+/gu, '-'));
    log(`brief: ${brief.subject} -> ${dir}`);
    results.push({ subject: brief.subject, ...(await runBriefPipeline({ brief, outDir: dir, log, distill: true })) });
  }
  const allPass = results.every((r) => r.pass);
  fs.writeFileSync(path.join(outDir, 'selftest-summary-v4.json'), JSON.stringify({
    version: 'SelftestV4/0.1', models: results.length, allPass,
    scores: results.map((r) => ({ subject: r.subject, score: r.report.critic.after.score, iou: r.report.structure.silhouetteIoU })),
  }, null, 2));
  log(`SELFTEST ${allPass ? 'PASS' : 'FAIL'}`);
  return allPass;
}

if (process.argv[1] && process.argv[1].endsWith('run-model-v4.mjs')) {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) args[a.slice(2)] = true;
    else args[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const out = args.selftest ? (args.out || path.join(__dirname, 'selftest', 'model-v4')) : (args.out || path.join(__dirname, 'runs', 'model-v4'));
  if (args.selftest) {
    const ok = await selftest(out);
    process.exit(ok ? 0 : 1);
  } else if (args.brief) {
    const { report } = await runBriefPipeline({ brief: args.brief, outDir: out });
    console.log(JSON.stringify({ pass: report.pass, score: report.critic.after.score, gates: report.gates }, null, 2));
    process.exit(report.pass ? 0 : 1);
  } else {
    console.error('usage: node run-model-v4.mjs --brief=<file|json> --out=<dir> | --selftest [--out=dir]');
    process.exit(2);
  }
}
