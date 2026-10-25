/**
 * sculpt-composer.mjs — chisel v4 部件树解释器（ModelBrief/1.0 → VOXA model）
 *
 * v3 的"流派程序"是手写 JS 函数，新题材必须写代码；v4 把它上位抽象为
 * **数据驱动的部件树 spec**：部件（SDF 基元组合 + 上色配方）→ 解释执行。
 * 这是"像人一样建模"的骨架：AI 只需要写出"想造什么、由哪些部件构成"，
 * 组装、上色、骨骼、动画全部确定性完成。
 *
 * ModelBrief 部件 spec（part）：
 *   { id, role: body|attachment|detail, position:[x,y,z], size:[nx,ny,nz],
 *     mirrorX?, bone?,
 *     shape: { smoothK?, primitives:[{op,...}], carve?:[{op,...}] },
 *     paint: { hex|glowHex, steps?, vRange?, hueShift?, rampT: height|depth|depthLight,
 *              noise?, edge?: {lighten, n}, glow?: {hex, depth, emissive} } }
 *
 * primitives.op ∈ sphere|ell|roundBox|capsule|cylinderY|torusZ|torusY|lathe|tube
 * 全部坐标为部件局部坐标（与 Sculptor 网格同系）。
 */
import { Palette, Sculptor, sd, fbm3 } from './model-sculpt.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 单个基元 spec → SDF 函数（局部坐标） */
export function primitiveToSdf(p) {
  switch (p.op) {
    case 'sphere': return sd.sphere(p.center[0], p.center[1], p.center[2], p.r);
    case 'ell': return sd.ell(p.center[0], p.center[1], p.center[2], p.r[0], p.r[1], p.r[2]);
    case 'roundBox': return sd.roundBox(p.center[0], p.center[1], p.center[2], p.half[0], p.half[1], p.half[2], p.r || 0);
    case 'capsule': return sd.capsule(p.a[0], p.a[1], p.a[2], p.b[0], p.b[1], p.b[2], p.r);
    case 'cylinderY': return sd.cylinderY(p.center[0], p.center[2], p.y0, p.y1, p.r);
    case 'torusZ': return sd.torusZ(p.center[0], p.center[1], p.center[2], p.R, p.r);
    case 'torusY': return sd.torusY(p.center[0], p.center[1], p.center[2], p.R, p.r);
    case 'lathe': return sd.lathe(p.axis ? p.axis[0] : 0, p.axis ? p.axis[1] : 0, p.profile);
    case 'tube': {
      const pts = p.bezier ? sd.bezier3(p.points[0], p.points[1], p.points[2], p.points[3], p.segs || 20) : p.points;
      const rFn = p.rFrom !== undefined ? (t) => p.rFrom + (p.rTo - p.rFrom) * t : () => p.r;
      return sd.polylineTube(pts, rFn);
    }
    default: throw new Error(`未知基元 op: ${p.op}`);
  }
}

/** shape.primitives 组合：≥2 个时 soft-union，否则单基元 */
function shapeToSdf(shape) {
  const prims = (shape.primitives || []).map(primitiveToSdf);
  if (!prims.length) throw new Error('shape.primitives 为空');
  if (prims.length === 1) return prims[0];
  const k = shape.smoothK ?? 1.5;
  return sd.smoothUnion(k)(...prims);
}

/**
 * 剪影 → 车削轮廓：blockout 的"结构先于外观"真实现。
 * brief.silhouette.front（归一化 0..1 折线，y=0 底 1=顶）→ 右缘包络 →
 * lathe profile [[y, r]...]（体素单位）。part.shape 写 { fromSilhouette: 'front' }
 * 即可让剪影直接驱动几何，不再手填 profile。
 */
export function latheProfileFromSilhouette(polyline, size, { samples = 14, rScale = 0.48 } = {}) {
  if (!polyline || polyline.length < 3) throw new Error('fromSilhouette: brief.silhouette 缺失或太短');
  const [nx, ny] = size;
  const yMin = Math.min(...polyline.map((p) => p[1]));
  const yMax = Math.max(...polyline.map((p) => p[1]));
  const profile = [];
  for (let i = 0; i < samples; i += 1) {
    const yn = yMin + ((yMax - yMin) * i) / (samples - 1);
    // 该高度上的最大 x（右缘）；折线边插值
    let xMax = 0;
    for (let j = 0; j < polyline.length; j += 1) {
      const a = polyline[j];
      const b = polyline[(j + 1) % polyline.length];
      const y0 = a[1];
      const y1 = b[1];
      if ((y0 <= yn && y1 > yn) || (y1 <= yn && y0 > yn) || yn === y0) {
        const t = y1 === y0 ? 0 : (yn - y0) / (y1 - y0);
        const x = a[0] + (b[0] - a[0]) * t;
        if (x > xMax) xMax = x;
      }
    }
    profile.push([yn * ny, Math.max(1, xMax * nx * rScale)]);
  }
  return profile;
}

/** shape 组装：支持 { fromSilhouette: 'front', primitives?... }（剪影驱动 blockout） */
function shapeToSdfWithBrief(shape, brief, part) {
  if (shape.fromSilhouette && brief.silhouette?.[shape.fromSilhouette]) {
    const profile = latheProfileFromSilhouette(brief.silhouette[shape.fromSilhouette], part.size, shape.silhouetteOpts);
    const lathe = primitiveToSdf({ op: 'lathe', profile, axis: shape.axis || [part.size[0] / 2, part.size[2] / 2] });
    const prims = (shape.primitives || []).map(primitiveToSdf);
    if (!prims.length) return lathe;
    const k = shape.smoothK ?? 1.5;
    return sd.smoothUnion(k)(lathe, ...prims);
  }
  return shapeToSdf(shape);
}

/**
 * part.paint → paint(x,y,z,info) 闭包。
 * rampT: height（底暗顶亮）/ depth（深处更暗，cx 越大越暗）/ depthLight（深处更亮，发光芯用）
 */
export function buildPaintFn(palette, part) {
  const paint = part.paint || {};
  const steps = paint.steps || 8;
  const rampName = `${part.id}_base`;
  const ramp = palette.ramp(rampName, paint.hex || '#8c6a3f', {
    steps,
    vRange: paint.vRange || [0.6, 1.08],
    hueShift: paint.hueShift || 0,
    emissive: paint.emissive || 0,
    emissiveTop: paint.emissiveTop || 0,
  });
  const glowRamp = paint.glow
    ? palette.ramp(`${part.id}_glow`, paint.glow.hex, { steps: 4, vRange: [0.9, 1.25], emissiveTop: paint.glow.emissive ?? 1 })
    : null;
  const noise = paint.noise ?? 0.16;
  const seed = paint.seed || 7;
  const edge = paint.edge || { lighten: 0.15, n: 5 };
  const ny = part.size[1];

  return (x, y, z, info) => {
    let t;
    if (paint.rampT === 'depth') t = clamp01(info.cx / Math.max(2, part.depthScale || 4));
    else if (paint.rampT === 'depthLight') t = 1 - clamp01(info.cx / Math.max(2, part.depthScale || 4));
    else t = clamp01(y / Math.max(1, ny - 1));
    t = clamp01(t + (fbm3(x, y, z, { freq: 0.35, seed }) - 0.5) * noise);
    if (glowRamp && info.cx >= (paint.glow.depth || 2)) return glowRamp(0.75);
    if (edge && info.emptyN !== undefined && info.emptyN >= edge.n) return ramp(Math.min(1, t + edge.lighten));
    return ramp(t);
  };
}

/**
 * ModelBrief → model（与 v3 run-model-v3.buildOneModel 消费的同构 model：
 * { groups:[{id,name,position,bone,sculptor}], bones, animations, palette, natural }
 */
export function composeModel(brief, { log = () => {} } = {}) {
  const palette = new Palette();
  const groups = [];
  const bones = (brief.bones || []).map((b) => ({ ...b }));
  const boneIds = new Set(bones.map((b) => b.id));

  for (const part of brief.parts) {
    const [nx, ny, nz] = part.size;
    if (!nx || !ny || !nz) throw new Error(`part ${part.id}: size 缺失`);
    const sc = new Sculptor(nx, ny, nz);
    const sdf = shapeToSdfWithBrief(part.shape || {}, brief, part);
    // 空邻居数在 fill 时无法知晓（相邻体素未定），先几何填充，再用 repaint 做边缘提亮。
    const base = buildPaintFn(palette, part);
    sc.fill(sdf, (x, y, z, info) => base(x, y, z, { ...info, emptyN: 0 }));
    for (const c of (part.shape && part.shape.carve) || []) sc.carve(primitiveToSdf(c));
    if (part.mirrorX) sc.mirrorX();
    // 边缘高光重上色（现在空邻居数有意义了）。byName 存的是 ids 数组，pick 自建。
    const edge = (part.paint && part.paint.edge) || { lighten: 0.15, n: 5 };
    const ids = palette.byName.get(`${part.id}_base`);
    if (Array.isArray(ids) && ids.length && edge && edge.lighten) {
      const pick = (t) => ids[Math.max(0, Math.min(ids.length - 1, Math.round(t * (ids.length - 1))))];
      sc.repaint((x, y, z) => (sc.emptyNeighbors(x, y, z) >= edge.n ? pick(Math.min(1, 0.92 + edge.lighten)) : 0));
    }
    if (!sc.count()) { log(`warn: part ${part.id} 雕完是空的（检查 shape/size）`); }
    groups.push({
      id: part.id,
      name: part.id,
      position: part.position || [0, 0, 0],
      bone: part.bone && boneIds.has(part.bone) ? part.bone : undefined,
      sculptor: sc,
    });
  }

  const animations = buildAnimations(brief.animations || [], boneIds);
  const natural = naturalSize(groups);
  return { groups, bones, animations, palette, natural, brief };
}

/** 组合占位尺寸（跨部件 bounds） */
export function naturalSize(groups) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const g of groups) {
    const cb = g.sculptor.contentBounds();
    if (!cb) continue;
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], g.position[i] + cb.min[i]);
      max[i] = Math.max(max[i], g.position[i] + cb.max[i] + 1);
    }
  }
  if (min[0] === Infinity) return [8, 8, 8];
  return max.map((v, i) => v - min[i]);
}

const EASE = 'EASE_IN_OUT_SINE';
/** 动画预设：float（悬浮）/ bob（点头）/ sway（摇臂）/ spin（旋转） */
export function buildAnimations(presets, boneIds) {
  const out = [];
  for (const preset of presets) {
    const bone = preset.bone && boneIds.has(preset.bone) ? preset.bone : 'ROOT_BONE';
    const period = preset.period || 2.4;
    const amp = preset.amplitude || 2;
    const ch = [];
    if (preset.type === 'float') {
      ch.push({ bone, path: 'translation', keyframes: [
        { time: 0, value: [0, 0, 0] }, { time: period / 2, value: [0, amp, 0] }, { time: period, value: [0, 0, 0] },
      ] });
    } else if (preset.type === 'bob') {
      ch.push({ bone, path: 'translation', keyframes: [
        { time: 0, value: [0, 0, 0] }, { time: period / 2, value: [0, -amp, 0] }, { time: period, value: [0, 0, 0] },
      ] });
    } else if (preset.type === 'sway') {
      const q = (deg) => { const r = (deg * Math.PI) / 360; return [0, 0, Math.sin(r), Math.cos(r)]; };
      ch.push({ bone, path: 'rotation', keyframes: [
        { time: 0, value: q(0) }, { time: period / 2, value: q(amp * 10) }, { time: period, value: q(0) },
      ] });
    } else if (preset.type === 'spin') {
      ch.push({ bone, path: 'rotation', keyframes: [
        { time: 0, value: [0, 0, 0, 1] }, { time: period / 2, value: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] }, { time: period, value: [0, 0, 0, -1] },
      ] });
    } else if (preset.type === 'alpha') {
      ch.push({ bone, path: 'alpha', keyframes: [
        { time: 0, value: 1 }, { time: period / 2, value: Math.max(0, 1 - amp / 10) }, { time: period, value: 1 },
      ] });
    } else { continue; }
    for (const c of ch) for (const kf of c.keyframes) kf.interp = EASE;
    out.push({ id: preset.id || `anim_${out.length + 1}`, name: preset.name || preset.type, duration: period, channels: ch });
  }
  return out;
}
