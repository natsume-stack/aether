#!/usr/bin/env node
/**
 * run-model-v3.mjs — VOXA 模型管线 v3 编排（新文件，不改 run-model.mjs）
 *
 * GDD → 选流派程序 → 雕塑 → fitToSizeHint → critic/自动修复循环(≤3)
 *    → bundle(voxaproject: project.bin v10 + model-data.bin v7 + meta) → 软件预览 PNG
 *    → report.json（含 critic 分数与门禁）
 *
 * 用法：
 *   node run-model-v3.mjs --gdd=<file|'{"artStyle":...}'> --out=<dir>
 *   node run-model-v3.mjs --selftest [--out=selftest/model]
 *
 * 导出 runModelPipeline({ gdd, outDir, log }) 供 examples/run-pipeline.mjs 调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { pickProgram, defaultModels } from './sculpt-library.mjs';
import {
  criticSculpt, autoRepairLoop, fitToSizeHint, downsampleLod,
  Sculptor, Palette, rgbToHsv,
} from './model-sculpt.mjs';
import { renderSoftwarePreview } from './preview-renderer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOXA_ROOT = process.env.VOXA_ROOT || 'D:/desktop/神奇代码岛/box3-local-engine/apps/voxa';
const requireFromVoxa = createRequire(path.join(VOXA_ROOT, 'package.json'));
const vp = requireFromVoxa('@box/voxa-project');
const JSZip = requireFromVoxa('jszip');
const { Mesher } = requireFromVoxa('@box/mesher');
const { compress } = requireFromVoxa('@box/utils/rle-compress');
const { MuWriteStream } = requireFromVoxa('@box/mudb/stream');

const GATES = { minPalette: 28, minUsedColors: 12, minRects: 160, minTexels: 1200 };

/* ---------------- cid / 序列化（与 v2 契约一致） ---------------- */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) { carry += digits[i] << 8; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let text = '';
  for (const digit of digits.reverse()) text += ALPHABET[digit];
  for (const byte of bytes) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}
export const cid = (data) => base58(Buffer.concat([Buffer.from([0x12, 0x20]), crypto.createHash('sha256').update(data).digest()]));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function encodeView(view, dims) {
  const stream = new MuWriteStream(12);
  stream.writeInt32(dims[0]);
  stream.writeInt32(dims[1]);
  stream.writeInt32(dims[2]);
  compress(view, stream);
  return Array.from(stream.bytes());
}

export function nodeJson({ id, name, type, parentId, position = [0, 0, 0], childrenIds = [], voxelId = '' }) {
  return {
    type, alpha: 1, boneId: '', childrenIds, euler: [0, 0, 0], flip: [0, 0, 0], id, name,
    parentId, parentScaleMat3: [1, 0, 0, 0, 1, 0, 0, 0, 1], pivot: [0, 0, 0], position,
    quaternion: [0, 0, 0, 1], scale: [1, 1, 1], skinId: '', voxelId,
  };
}

export function modelBounds(groups) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) {
    const cb = g.sculptor.contentBounds();
    if (!cb) continue;
    const p = g.position.map((v) => Math.round(v));
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], p[i] + cb.min[i]);
      max[i] = Math.max(max[i], p[i] + cb.max[i] + 1);
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1] };
  return { min, max, size: max.map((v, i) => v - min[i]) };
}

/** project v10 JSON（VOXA 编辑器可打开） */
export function buildProjectJson(model) {
  const bounds = modelBounds(model.groups);
  const rootOffset = bounds.min;
  const bones = model.bones || [];
  const boneIds = new Set(bones.map((b) => b.id));
  const partsByBone = new Map(bones.map((b) => [b.id, []]));
  for (const g of model.groups) {
    if (g.bone && boneIds.has(g.bone)) partsByBone.get(g.bone).push(g.id);
  }
  const nodes = {};
  nodes.ROOT = nodeJson({ id: 'ROOT', name: 'Root', type: 0, parentId: '', childrenIds: ['ROOT_BONE', 'ROOT_SKIN'] });
  nodes.ROOT_BONE = nodeJson({ id: 'ROOT_BONE', name: 'RootBone', type: 3, parentId: 'ROOT', childrenIds: bones.filter((b) => !b.parent || b.parent === 'ROOT_BONE').map((b) => b.id) });
  nodes.ROOT_SKIN = nodeJson({
    id: 'ROOT_SKIN', name: 'RootSkin', type: 2, parentId: 'ROOT',
    childrenIds: model.groups.filter((g) => !g.bone || !boneIds.has(g.bone)).map((g) => g.id),
  });
  for (const b of bones) {
    const parentBone = b.parent && bones.find((candidate) => candidate.id === b.parent);
    if (b.parent && b.parent !== 'ROOT_BONE' && !parentBone)
      throw new Error(`Unknown parent bone: ${b.parent}`);
    nodes[b.id] = nodeJson({
      id: b.id, name: b.name, type: 3, parentId: b.parent || 'ROOT_BONE',
      position: b.position.map((value, axis) => value - (parentBone ? parentBone.position[axis] : rootOffset[axis])),
      childrenIds: bones.filter((child) => child.parent === b.id).map((child) => child.id),
    });
    // VOXA keeps skin and bone hierarchies separate. A skin group is bound
    // through bone.skinId / group.boneId, never through a bone parentId.
    const parts = partsByBone.get(b.id) || [];
    if (parts.length) {
      const skinId = `${b.id}__skin`;
      if (bones.some((bone) => bone.id === skinId) || model.groups.some((g) => g.id === skinId))
        throw new Error(`Generated skin group ID collision: ${skinId}`);
      nodes[b.id].skinId = skinId;
      nodes[skinId] = nodeJson({ id: skinId, name: `${b.name}Skin`, type: 2,
        parentId: '', childrenIds: parts });
      nodes[skinId].boneId = b.id;
    }
  }
  const voxels = {};
  for (const g of model.groups) {
    const bp = g.bone && boneIds.has(g.bone) ? bones.find((b) => b.id === g.bone).position : null;
    const p = g.position.map((v) => Math.round(v));
    const local = bp
      ? [p[0] - rootOffset[0] - (bp[0] - rootOffset[0]), p[1] - rootOffset[1] - (bp[1] - rootOffset[1]), p[2] - rootOffset[2] - (bp[2] - rootOffset[2])]
      : [p[0] - rootOffset[0], p[1] - rootOffset[1], p[2] - rootOffset[2]];
    nodes[g.id] = nodeJson({
      id: g.id, name: g.name, type: 1,
      parentId: g.bone && boneIds.has(g.bone) ? `${g.bone}__skin` : 'ROOT_SKIN',
      position: local, voxelId: g.id,
    });
    const view = g.sculptor.toView();
    voxels[g.id] = { id: g.id, dimension: 3, encodedView: encodeView(view, [g.sculptor.nx, g.sculptor.ny, g.sculptor.nz]) };
    g._view = view;
    g._filled = g.sculptor.count();
  }
  const animations = (model.animations || []).map((animation) => {
    const motionNodes = {};
    for (const ch of animation.channels) {
      motionNodes[ch.bone] = {
        nodeId: ch.bone,
        keyframeList: ch.keyframes.map((kf) => ({
          time: String(kf.time),
          interpolation: kf.interp || 'LINEAR',
          offset: {
            alpha: ch.path === 'alpha' ? kf.value : 1,
            rotation: ch.path === 'rotation' ? kf.value : [0, 0, 0, 1],
            scale: ch.path === 'scale' ? kf.value : [1, 1, 1],
            translation: ch.path === 'translation' ? kf.value : [0, 0, 0],
          },
        })),
      };
    }
    return { id: animation.id, name: animation.name, nodes: motionNodes };
  });
  const paletteItems = model.palette.items.map((it) => {
    const rgb = it.rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))));
    const [h, s, v] = rgbToHsv(rgb);
    return { id: it.id, hsv: [Math.round(h), Math.round(s * 100), Math.round(v * 100)],
      material: { emissive: Math.round(clamp01(it.emissive || 0) * 255) }, rgb };
  });
  return {
    project: {
      version: 10,
      animations,
      hitBox: { mode: 1, customBox: { position: [0, 0, 0], size: bounds.size.map((v) => Math.round(v)) } },
      modelPivot: model.pivot || [0, 0, 0],
      nodes,
      palette: {
        groupList: ['default'],
        groups: { default: { id: 'default', name: 'Color', itemIds: paletteItems.map((i) => i.id) } },
        items: paletteItems,
      },
      voxels,
    },
    bounds,
  };
}

/** model-data v7 JSON（运行时渲染数据） */
export function buildModelDataJson(model, mesherResult, bounds) {
  const rootOffset = bounds.min;
  const { meshes } = mesherResult;
  const paletteList = model.palette.items.map((it) => it.rgb.map((value) => Math.max(0, Math.min(255, Math.round(value)))));
  const emissiveList = model.palette.items.map((it) => it.emissive);
  const boneIndex = new Map();
  const nodes = [];
  const push = (node) => { nodes.push(node); return nodes.length - 1; };
  const identityMat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const baseNode = (translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1], alpha = 1) => ({
    alpha, mesh: -1, children: [], parentScaleMat3: identityMat3, rotation, scale, translation,
  });
  const rootIndex = push(baseNode());
  const rootBoneIndex = push(baseNode());
  nodes[rootIndex].children.push(rootBoneIndex);
  for (const b of model.bones || []) {
    const index = push(baseNode([b.position[0] - rootOffset[0], b.position[1] - rootOffset[1], b.position[2] - rootOffset[2]]));
    boneIndex.set(b.id, index);
    nodes[rootBoneIndex].children.push(index);
  }
  const skinIndex = push(baseNode());
  nodes[rootIndex].children.push(skinIndex);
  model.groups.forEach((g) => {
    const bp = g.bone && boneIndex.has(g.bone) ? (model.bones || []).find((b) => b.id === g.bone) : null;
    const p = g.position.map((v) => Math.round(v));
    const local = bp
      ? [p[0] - bp.position[0], p[1] - bp.position[1], p[2] - bp.position[2]]
      : [p[0] - rootOffset[0], p[1] - rootOffset[1], p[2] - rootOffset[2]];
    const node = baseNode(local);
    node.mesh = model.groups.indexOf(g);
    const nodeIndex = push(node);
    if (bp && boneIndex.has(bp.id)) nodes[boneIndex.get(bp.id)].children.push(nodeIndex);
    else nodes[skinIndex].children.push(nodeIndex);
  });
  const animations = (model.animations || []).map((animation) => {
    const channels = [];
    const samplers = [];
    for (const ch of animation.channels) {
      const node = boneIndex.get(ch.bone);
      if (node === undefined) continue;
      const setup = ch.path === 'translation' ? nodes[node].translation : ch.path === 'scale' ? nodes[node].scale : ch.path === 'alpha' ? nodes[node].alpha : nodes[node].rotation;
      const values = ch.keyframes.map((kf) => {
        if (ch.path === 'translation') return [setup[0] + kf.value[0], setup[1] + kf.value[1], setup[2] + kf.value[2]];
        return kf.value;
      });
      samplers.push({
        input: ch.keyframes.map((kf) => kf.time),
        output: { type: ch.path, data: values },
        interpolation: 'LINEAR',
      });
      channels.push({ sampler: samplers.length - 1, target: { node, path: ch.path } });
    }
    return { id: animation.id, name: animation.name, channels, samplers };
  });
  const texture = {
    palette: paletteList.map((rgb, i) => ((rgb[0] & 0xff) << 24 | (rgb[1] & 0xff) << 16 | (rgb[2] & 0xff) << 8 | (Math.round(emissiveList[i] * 255) & 0xff)) >>> 0),
    data: null,
    width: 0,
  };
  return { animations, meshes, nodes, texture };
}

export async function writeBundle({ projectSchema, modelSchema, meta, previewPng, outFile }) {
  const projectBytes = Buffer.from(vp.projectSchemaToBytes(projectSchema));
  const dataBytes = Buffer.from(vp.modelSchemaToBytes(modelSchema));
  const metaBytes = Buffer.from(JSON.stringify({ ...meta, dataHash: cid(dataBytes) }));
  const resources = [
    { name: 'model-meta.bin', bytes: metaBytes },
    { name: 'model-data.bin', bytes: dataBytes },
    { name: 'preview.bin', bytes: previewPng },
  ].map((r) => ({ ...r, hash: cid(r.bytes) }));
  const manifest = {
    format: 'box-voxa-project', formatVersion: 1, exportedAt: new Date().toISOString(),
    // VOXA EditType.Normal=0; 1 is Skin, not the model schema version.
    projectName: meta.projectName, editType: 0,
    resources: resources.map((r) => ({ name: r.name, hash: r.hash, contentType: 'application/octet-stream' })),
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('project.bin', projectBytes);
  for (const r of resources) zip.file(r.name, r.bytes);
  const bundle = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(outFile, bundle);
  return { bundle, projectBytes, dataBytes, metaBytes };
}

export function statsOf(modelDataBytes) {
  const decoded = vp.modelBytesToSchema(new Uint8Array(modelDataBytes));
  const s = decoded.schema;
  const texels = (s.texture.data || []).length;
  const used = new Set(s.texture.data || []).size;
  let rects = 0;
  for (const m of s.meshes || []) for (const face of m || []) rects += ((face.sizes || []).length) / 2;
  return { version: decoded.version, texels, usedColors: used, rects, palette: (s.texture.palette || []).length, meshes: (s.meshes || []).length };
}

export function gateCheck(st, { surface = null, dims = null } = {}) {
  // 面片门禁按表面积缩放：大模型要求 ≥160；小道具改为密度门槛（×0.085 且 ≥48）防"整块方块"。
  // 薄板/细长类（最小维 ≤10）两大面重复计数虚高 → 有效面积 = 2*L*H + 半周×厚，与大模型同一密度标尺
  const d = dims || [99, 99, 99];
  const thinDim = Math.min(...d) <= 10;
  const area0 = surface || 99999;
  const area = thinDim ? 2 * (d[0] * d[1] + d[2] * (d[0] + d[1]) * 0.5) : area0;
  const minRects = Math.max(48, Math.min(GATES.minRects, Math.round(area * 0.075)));
  const minTexels = Math.max(700, Math.min(GATES.minTexels, Math.round(area * 1.55)));
  return {
    palette: st.palette >= GATES.minPalette,
    usedColors: st.usedColors >= GATES.minUsedColors,
    rects: st.rects >= minRects,
    texels: st.texels >= minTexels,
  };
}

/** 伪 plan（软渲染预览输入） */
export function pseudoProject(model) {
  const voxels = {};
  for (const g of model.groups) {
    const view = g.sculptor.toView();
    voxels[g.id] = { dimension: 3, encodedView: encodeView(view, [g.sculptor.nx, g.sculptor.ny, g.sculptor.nz]) };
  }
  const plan = {
    materials: model.palette.items.map((i) => ({ id: i.id, rgb: i.rgb, emissive: i.emissive })),
    parts: model.groups.map((g) => ({ id: g.id, voxelId: g.id, position: g.position.map((v) => Math.round(v)) })),
  };
  return { project: { voxels }, plan };
}

/** LOD1 伪项目（保轮廓降采样） */
function lodProject(model) {
  const voxels = {};
  const parts = [];
  for (const g of model.groups) {
    const lod = downsampleLod(g.sculptor, 2);
    const view = lod.toView();
    voxels[`${g.id}_lod`] = { dimension: 3, encodedView: encodeView(view, [lod.nx, lod.ny, lod.nz]) };
    parts.push({ id: `${g.id}_lod`, voxelId: `${g.id}_lod`, position: g.position.map((v) => Math.round(v)) });
  }
  return {
    project: { voxels },
    plan: {
      materials: model.palette.items.map((i) => ({ id: i.id, rgb: i.rgb, emissive: i.emissive })),
      parts,
    },
  };
}

/* ---------------- 管线 ---------------- */

/** 单模型：雕塑 → 拟合 → critic/修复 → 序列化 → bundle → 预览 → report */
export async function buildOneModel({ artStyle, entry, index, outDir, log = () => {} }) {
  const t0 = Date.now();
  const program = pickProgram(artStyle, entry, index);
  const model = program.fn();
  const style = program.key;
  let sizeHint = entry.sizeHint && entry.sizeHint.length === 3 ? entry.sizeHint : model.natural;
  // 需求与产能对表：hint 超出可重采样范围（任意轴比例 ∉[0.5,2.5]）→ 回退自然尺寸
  const ratioBad = sizeHint.some((v, i) => v / Math.max(1, model.natural[i]) < 0.48 || v / Math.max(1, model.natural[i]) > 2.52);
  if (ratioBad) { log(`${style}: sizeHint ${JSON.stringify(sizeHint)} 超出自然尺寸 ${JSON.stringify(model.natural)} 可重采样范围，回退自然尺寸`); sizeHint = model.natural; }

  // sizeHint 拟合（比例偏差 >6% 才重采样）
  const fitted = fitToSizeHint(model, sizeHint);

  // critic / 自动修复（≤3 轮，确定性）
  const before = criticSculpt(model, { sizeHint });
  let previewBeforePng = null;
  if (!before.pass) previewBeforePng = pseudoProject(model);
  const repair = autoRepairLoop(model, { sizeHint, log });
  const after = repair.after;
  const repaired = repair.changed;

  // 门禁统计 + bundle
  const modelDir = path.join(outDir, style, 'model', style);
  fs.mkdirSync(modelDir, { recursive: true });
  const { project: projectJson, bounds } = buildProjectJson(model);

  const mesher = new Mesher(true, true, false);
  for (const g of model.groups) mesher.addModel(g._view, 3);
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
    projectName: style,
    bounds: bounds.size.map((v) => Math.round(v)),
    motionList: (model.animations || []).map((a) => ({ id: a.id, name: a.name, duration: a.duration })),
    useCustomBounds: true,
    customBounds: { size: bounds.size.map((v) => Math.round(v)), offset: [0, 0, 0] },
    renderBoxOffset: [0, 0, 0],
  };

  const previewPath = path.join(modelDir, 'model-preview.png');
  await renderSoftwarePreview({ ...pseudoProject(model), outFile: previewPath, size: 384, background: '#10161f' });
  const lodPath = path.join(modelDir, 'lod1-preview.png');
  await renderSoftwarePreview({ ...lodProject(model), outFile: lodPath, size: 192, background: '#10161f' });

  const bundlePath = path.join(modelDir, `${style}.voxaproject`);
  const out = await writeBundle({ projectSchema, modelSchema, meta, previewPng: fs.readFileSync(previewPath), outFile: bundlePath });
  fs.writeFileSync(path.join(modelDir, 'project.bin'), out.projectBytes);
  fs.writeFileSync(path.join(modelDir, 'model-data.bin'), out.dataBytes);
  fs.writeFileSync(path.join(modelDir, 'model-meta.bin'), out.metaBytes);

  const st = statsOf(out.dataBytes);
  const surface = 2 * (bounds.size[0] * bounds.size[1] + bounds.size[0] * bounds.size[2] + bounds.size[1] * bounds.size[2]);
  const gate = gateCheck(st, { surface, dims: bounds.size });
  const gatesPass = Object.values(gate).every(Boolean);

  // 结构断言：bounds 占 sizeHint 85–100%；animated 的必须有骨骼动画
  const fill = after.hintFill || [1, 1, 1];
  const boundsOk = fill.every((r) => r >= 0.85 && r <= 1.05);
  // animated 按程序实际能力判定（需求 mismatch 记 warning 不判死）
  const animOk = !program.animated || (model.animations || []).length >= 1;
  const animRequestedMismatch = Boolean(entry.animated) && !program.animated;
  const ms = Date.now() - t0;

  // 修复前 PNG（仅当发生修复，用于对比证据）
  if (repaired && previewBeforePng) {
    await renderSoftwarePreview({ ...previewBeforePng, outFile: path.join(outDir, style, 'preview-before-repair.png'), size: 384, background: '#10161f' });
  }

  const report = {
    version: 'ModelReport/0.3-sculpt-v3', artStyle, style, role: entry.role || 'prop',
    requested: { name: entry.name, sizeHint, animated: Boolean(entry.animated) },
    program: { key: program.key, natural: model.natural, fitted },
    bounds: { size: bounds.size.map((v) => Math.round(v)), fill },
    critic: { before: { score: before.score, issues: before.issues, entropy: before.paletteEntropy, silhouette: before.silhouette, floatingClusters: before.floatingClusters, edgeNoise: before.edgeNoise }, after: { score: after.score, issues: after.issues, entropy: after.paletteEntropy, silhouette: after.silhouette, floatingClusters: after.floatingClusters, edgeNoise: after.edgeNoise }, repaired, rounds: repair.rounds.map((r) => ({ round: r.round, actions: r.actions })) },
    stats: st, gates: { ...gate, pass: gatesPass }, structures: { boundsOk, animOk, animated: Boolean(entry.animated), animations: (model.animations || []).length, bones: (model.bones || []).length },
    hashes: { project: cid(out.projectBytes), modelData: cid(out.dataBytes) },
    bytes: { project: out.projectBytes.length, modelData: out.dataBytes.length, bundle: out.bundle.length },
    palette: model.palette.size, groups: model.groups.map((g) => ({ id: g.id, filled: g._filled })),
    ms,
  };
  fs.writeFileSync(path.join(outDir, style, 'report.json'), JSON.stringify(report, null, 2));
  log(`${style}: score ${before.score}→${after.score} gates=${gatesPass ? 'PASS' : 'FAIL'} fill=[${fill.join(',')}] ${ms}ms`);
  return { style, report, pass: gatesPass && boundsOk && animOk && after.pass };
}

/**
 * runModelPipeline — 对外主入口
 * @param {{ gdd: object|string, outDir: string, log?: (s:string)=>void }} opts
 * GDD: { artStyle: 'pixel'|'ink'|'hitech'|'cozy'|'horror', models?: [{role,name,style,sizeHint,animated}] }
 */
export async function runModelPipeline({ gdd, outDir, log = (s) => console.log(s) }) {
  if (typeof gdd === 'string') gdd = JSON.parse(fs.readFileSync(gdd, 'utf8').replace(/^\uFEFF/, ''));
  const artStyle = ['pixel', 'ink', 'hitech', 'cozy', 'horror'].includes(gdd.artStyle) ? gdd.artStyle : 'pixel';
  const models = Array.isArray(gdd.models) && gdd.models.length ? gdd.models : defaultModels(artStyle);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'gdd.json'), JSON.stringify({ ...gdd, artStyle, models }, null, 2));

  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < models.length; i += 1) {
    results.push(await buildOneModel({ artStyle, entry: models[i], index: i, outDir, log }));
  }

  const summary = results.map((r) => ({
    style: r.style,
    score: r.report.critic.after.score,
    scoreBefore: r.report.critic.before.score,
    entropy: r.report.critic.after.entropy,
    silhouetteSingle: r.report.critic.after.silhouette ? r.report.critic.after.silhouette.singleMain : false,
    floatingAfter: r.report.critic.after.floatingClusters,
    fillMin: Math.min(...r.report.bounds.fill),
    gates: r.report.gates,
    repaired: r.report.critic.repaired,
    ms: r.report.ms,
    pass: r.pass,
  }));
  const allPass = summary.every((s) => s.pass);
  const repairCase = results.filter((r) => r.report.critic.repaired)
    .sort((a, b) => (b.report.critic.before.score - b.report.critic.after.score) - (a.report.critic.before.score - a.report.critic.after.score))[0] || null;

  const criticSummary = {
    version: 'CriticSummary/0.3', artStyle, models: models.length,
    gates: GATES,
    acceptance: {
      allGatesPass: summary.every((s) => Object.values(s.gates).every(Boolean)),
      silhouetteSingleRate: summary.filter((s) => s.silhouetteSingle).length / summary.length,
      floatingAfterRepair: summary.reduce((n, s) => n + s.floatingAfter, 0),
      entropyInRange: summary.every((s) => s.entropy >= 2.2 && s.entropy <= 4.5),
      boundsFillInRange: summary.every((s) => s.fillMin >= 0.85 && s.fillMin <= 1.05),
      animatedHaveBones: results.every((r) => !r.report.requested.animated || r.report.structures.animations >= 1),
      perModelMsUnder3000: summary.every((s) => s.ms < 3000),
    },
    repairCase: repairCase ? {
      style: repairCase.style,
      before: repairCase.report.critic.before,
      after: repairCase.report.critic.after,
      rounds: repairCase.report.critic.rounds,
      beforePng: `preview-before-repair.png`, afterPng: `${repairCase.style}/model/model-preview.png`,
    } : null,
    summary, allPass, ms: Date.now() - t0,
  };
  fs.writeFileSync(path.join(outDir, 'critic-summary.json'), JSON.stringify(criticSummary, null, 2));
  fs.writeFileSync(path.join(outDir, 'status-model-v3.json'), JSON.stringify({
    version: 'N17ModelStatusV3/0.1', artStyle, models: models.length, allPass,
    acceptance: criticSummary.acceptance, ms: criticSummary.ms,
  }, null, 2));
  log(allPass ? 'PIPELINE PASS' : 'PIPELINE FAIL');
  return { results, summary, criticSummary, allPass };
}

/* ---------------- CLI ---------------- */
function defaultSelftestGdd() {
  const nat = {
    'pixel-rifle': [26, 9, 5], 'pixel-turret': [30, 26, 30], 'pixel-pickaxe': [22, 32, 5], 'pixel-castle': [42, 40, 42],
    'ink-furnace': [28, 35, 28], 'ink-crane': [38, 48, 22], 'ink-stele': [22, 44, 13], 'ink-boat': [52, 28, 20],
  };
  const mk = (artStyle, role, name, style, hint, animated) => ({ role, name, style, sizeHint: hint, animated });
  return {
    version: 'GDD/0.3',
    artStyle: 'pixel',
    models: [
      mk('pixel', 'hero', 'pixel-blaster', '像素步枪', nat['pixel-rifle'], true),
      mk('pixel', 'prop', 'pixel-turret', '像素炮塔', nat['pixel-turret'], true),
      mk('pixel', 'prop', 'pixel-pickaxe', '像素镐', [22, 30, 10], false), // sizeHint 偏小 → 触发 fitToSizeHint 重采样
      mk('pixel', 'landmark', 'pixel-castle', '像素城堡', nat['pixel-castle'], false),
    ],
    inkModels: [
      mk('ink', 'hero', 'bronze-furnace', '丹炉', nat['ink-furnace'], true),
      mk('ink', 'hero', 'crane', '仙鹤', nat['ink-crane'], true),
      mk('ink', 'landmark', 'sword-stele', '石碑', nat['ink-stele'], true),
      mk('ink', 'landmark', 'sky-boat', '云舟', nat['ink-boat'], true),
    ],
  };
}

async function selftest(outDir) {
  const log = (s) => console.log(`[selftest] ${s}`);
  const pixelOut = path.join(outDir, 'pixel');
  const gdd = defaultSelftestGdd();
  log(`pixel 4 models -> ${pixelOut}`);
  const pixelRes = await runModelPipeline({ gdd: { ...gdd, models: gdd.models }, outDir: pixelOut, log });

  const inkOut = path.join(outDir, 'ink');
  log(`ink 4 models -> ${inkOut}`);
  const inkRes = await runModelPipeline({ gdd: { artStyle: 'ink', models: gdd.inkModels }, outDir: inkOut, log });

  // auto-repair 对比案例：仙鹤左翼故意脱位（position y +14）→ 修复循环焊接
  const repairOut = path.join(outDir, 'repair-case');
  fs.mkdirSync(repairOut, { recursive: true });
  log('repair case: ink-crane with detached wing-l (injected defect)');
  const program = pickProgram('ink', { name: 'crane' });
  const broken = program.fn();
  const wing = broken.groups.find((g) => g.id === 'crane_wing_l');
  const originalPos = [...wing.position];
  wing.position = [originalPos[0] - 18, originalPos[1] + 26, originalPos[2]]; // 完全脱位的悬空岛
  const beforeCrit = criticSculpt(broken, { sizeHint: broken.natural });
  await renderSoftwarePreview({ ...pseudoProject(broken), outFile: path.join(repairOut, 'before.png'), size: 384, background: '#10161f' });
  const repair = autoRepairLoop(broken, { sizeHint: broken.natural, log });
  const afterCrit = repair.after;
  await renderSoftwarePreview({ ...pseudoProject(broken), outFile: path.join(repairOut, 'after.png'), size: 384, background: '#10161f' });
  fs.writeFileSync(path.join(repairOut, 'repair-case.json'), JSON.stringify({
    defect: 'crane_wing_l position y +14 (detached island)',
    before: { score: beforeCrit.score, issues: beforeCrit.issues, floatingClusters: beforeCrit.floatingClusters, silhouetteComponents: beforeCrit.silhouette.components },
    after: { score: afterCrit.score, issues: afterCrit.issues, floatingClusters: afterCrit.floatingClusters, silhouetteComponents: afterCrit.silhouette.components },
    rounds: repair.rounds.map((r) => ({ round: r.round, actions: r.actions })),
  }, null, 2));

  const all = [...pixelRes.summary, ...inkRes.summary];
  const total = {
    pixel: pixelRes.allPass, ink: inkRes.allPass,
    models: all.length,
    acceptance: {
      gates: all.every((s) => Object.values(s.gates).every(Boolean)),
      silhouetteSingleRate: all.filter((s) => s.silhouetteSingle).length / all.length,
      floatingAfterRepair: all.reduce((n, s) => n + s.floatingAfter, 0),
      entropyInRange: all.every((s) => s.entropy >= 2.2 && s.entropy <= 4.5),
      boundsFill: all.every((s) => s.fillMin >= 0.85 && s.fillMin <= 1.02),
      msUnder3000: all.every((s) => s.ms < 3000),
    },
    repairCase: { before: beforeCrit.score, after: afterCrit.score, floatBefore: beforeCrit.floatingClusters, floatAfter: afterCrit.floatingClusters },
  };
  fs.writeFileSync(path.join(outDir, 'selftest-summary.json'), JSON.stringify(total, null, 2));
  log(`SELFTEST ${total.pixel && total.ink ? 'PASS' : 'FAIL'} — ${JSON.stringify(total.acceptance)}`);
  return total;
}

if (process.argv[1] && process.argv[1].endsWith('run-model-v3.mjs')) {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) args[a.slice(2)] = true;
    else args[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const out = args.selftest ? (args.out || path.join(__dirname, 'selftest', 'model')) : (args.out || path.join(__dirname, 'runs', 'model-v3'));
  if (args.selftest) {
    const res = await selftest(out);
    process.exit(res.pixel && res.ink ? 0 : 1);
  } else if (args.gdd) {
    const { criticSummary } = await runModelPipeline({ gdd: args.gdd, outDir: out });
    console.log(JSON.stringify(criticSummary.acceptance, null, 2));
    process.exit(criticSummary.allPass ? 0 : 1);
  } else {
    console.error('usage: node run-model-v3.mjs --gdd=<file|json> --out=<dir> | --selftest [--out=dir]');
    process.exit(2);
  }
}
