/**
 * model-sculpt.mjs — VOXA 模型管线 v3 精细雕塑库 (ModelSculpt/0.3)
 *
 * 从 qingming v2 vox-sculpt.mjs 进化而来，新增：
 *  - 原语：extrudeAlong（沿路径挤出，椭圆截面）、radialArray（环形阵列）、
 *          stampGlyph（字模/位图刻印）、meanderMask/cloudMask（参数化回纹/云纹装饰带）、
 *          weathering（边缘侵蚀 + 做旧）、downsampleLod（LOD 保轮廓降采样）、
 *          resampleSculptor（nearest 重采样，用于 sizeHint 拟合）
 *  - 自评 critic（量化 JSON）：剪影可读性（正交投影占用率 + 连通域）、调色板熵、
 *          边缘噪声度、左右对称误差、悬浮体素簇
 *  - 自动修复（确定性）：悬空簇焊接/删除、熵调 ramp 合并/注入、剪影补桥、抖动色平滑
 *  - 系列一致性：SeriesPalette 跨模型共享 ramp 注册表
 *
 * 输出 VoxelView（调色板索引体素），交给 @box/mesher 生成 v7 模型。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
const VOXA_ROOT = process.env.VOXA_ROOT || 'D:/desktop/神奇代码岛/box3-local-engine/apps/voxa';
const requireFromVoxa = createRequire(path.join(VOXA_ROOT, 'package.json'));
const { allocVoxels } = requireFromVoxa('@box/utils/voxel');

export const TAU = Math.PI * 2;

/* ---------------- color ---------------- */
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function rgbToHsv([r, g, b]) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}
export function hsvToRgb([h, s, v]) {
  const c = v * s, hp = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = v - c;
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}
export function shadeRgb(rgb, mul) { return rgb.map((v) => Math.max(0, Math.min(255, v * mul))); }
export function mixRgb(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }
export function colorDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/* ---------------- palette ---------------- */
export class Palette {
  constructor() {
    this.items = []; // [{ id, name, rgb, emissive, hsv }]
    this.byName = new Map();
  }
  /** 加入一阶颜色，返回调色板索引（从 1 开始，0 = 空） */
  add(hex, { name = '', emissive = 0 } = {}) {
    const rgb = hexToRgb(typeof hex === 'string' ? hex : rgbToHex(hex));
    const id = this.items.length + 1;
    this.items.push({ id, name, rgb, emissive, hsv: rgbToHsv(rgb) });
    if (name) this.byName.set(name, id);
    return id;
  }
  /**
   * 生成一个材质色阶（明度 vRange 渐变 + 色相偏移 + 饱和度渐变）。
   * 返回取色函数 R(t, jitterZ?)，t∈[0,1]（0 暗 1 亮）。
   */
  ramp(name, hex, { steps = 7, vRange = [0.62, 1.06], hueShift = 0, satRange = null, emissive = 0, emissiveTop = 0 } = {}) {
    const base = rgbToHsv(hexToRgb(hex));
    const ids = [];
    for (let i = 0; i < steps; i += 1) {
      const t = steps === 1 ? 0.5 : i / (steps - 1);
      const v = vRange[0] + (vRange[1] - vRange[0]) * t;
      const h = base[0] + hueShift * (t - 0.5) * 2;
      const s = satRange ? satRange[0] + (satRange[1] - satRange[0]) * t : base[1];
      const em = emissive + (emissiveTop - emissive) * t;
      const rgb = hsvToRgb([h, s, v]);
      const id = this.items.length + 1;
      this.items.push({ id, name: `${name}${i}`, rgb, emissive: em, hsv: [h, s, v] });
      ids.push(id);
    }
    this.byName.set(name, ids);
    const pick = (t) => ids[Math.max(0, Math.min(steps - 1, Math.round(t * (steps - 1))))];
    pick.ids = ids;
    pick.steps = steps;
    return pick;
  }
  get size() { return this.items.length; }
}

/**
 * SeriesPalette — 系列一致性 ramp 注册表。
 * 同一 series 的同名 ramp 在整套模型中共享同一份参数（hex/steps/vRange…），
 * 保证"同一套模型同一套材质语言"。
 */
export class SeriesPalette {
  constructor() { this.specs = new Map(); }
  /** 取（或注册）一份 ramp 参数；再由 pal.ramp 应用到各模型自己的 Palette */
  spec(series, name, hex, opts = {}) {
    const key = `${series}::${name}`;
    if (!this.specs.has(key)) this.specs.set(key, { hex, opts });
    return this.specs.get(key);
  }
  /** 一步到位：把 series 注册的 ramp 应用到 pal，返回取色函数 */
  ramp(pal, series, name, hex, opts = {}) {
    const s = this.spec(series, name, hex, opts);
    return pal.ramp(name, s.hex, { ...s.opts, ...opts });
  }
}

/* ---------------- deterministic noise ---------------- */
export function hash3(x, y, z, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 974634599) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
export function valueNoise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const sm = (t) => t * t * (3 - 2 * t);
  const u = sm(xf), v = sm(yf), w = sm(zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi, seed), c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi, zi + 1, seed);
  return lerp(
    lerp(lerp(c000, c100, u), lerp(c010, c110, u), v),
    lerp(lerp(c001, c101, u), lerp(c011, c111, u), v),
    w,
  );
}
export function fbm3(x, y, z, { octaves = 3, freq = 0.12, seed = 0, gain = 0.5 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise3(x * f, y * f, z * f, seed + i * 71);
    norm += amp; amp *= gain; f *= 2.1;
  }
  return sum / norm;
}
export const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------------- SDF library ---------------- */
export const sd = {
  sphere: (px, py, pz, r) => (x, y, z) => Math.hypot(x - px, y - py, z - pz) - r,
  ell: (cx, cy, cz, rx, ry, rz) => (x, y, z) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
    return (Math.hypot(dx, dy, dz) - 1) * Math.min(rx, ry, rz);
  },
  roundBox: (cx, cy, cz, hx, hy, hz, r = 0) => (x, y, z) => {
    const dx = Math.abs(x - cx) - hx + r, dy = Math.abs(y - cy) - hy + r, dz = Math.abs(z - cz) - hz + r;
    const ax = Math.max(dx, 0), ay = Math.max(dy, 0), az = Math.max(dz, 0);
    return Math.hypot(ax, ay, az) + Math.min(Math.max(dx, Math.max(dy, dz)), 0) - r;
  },
  box: (cx, cy, cz, hx, hy, hz) => sd.roundBox(cx, cy, cz, hx, hy, hz, 0),
  capsule: (ax, ay, az, bx, by, bz, r) => (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az;
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
    return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
  },
  cylinderY: (cx, cz, y0, y1, r) => (x, y, z) => {
    const dr = Math.hypot(x - cx, z - cz) - r;
    const dy = Math.max(y0 - y, y - y1);
    const ax = Math.max(dr, 0), ay = Math.max(dy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(dr, dy), 0);
  },
  torusZ: (cx, cy, cz, R, r) => (x, y, z) => {
    const q = [Math.hypot(x - cx, y - cy) - R, z - cz];
    return Math.hypot(q[0], q[1]) - r;
  },
  torusY: (cx, cy, cz, R, r) => (x, y, z) => {
    const q = [Math.hypot(x - cx, z - cz) - R, y - cy];
    return Math.hypot(q[0], q[1]) - r;
  },
  planeY: (cy) => (x, y, z) => y - cy,
  union: (...fns) => (x, y, z) => Math.min(...fns.map((f) => f(x, y, z))),
  smoothUnion: (k) => (...fns) => (x, y, z) => {
    let d = Infinity;
    for (const f of fns) {
      const e = f(x, y, z);
      const h = Math.max(k - Math.abs(e - d), 0) / k;
      d = Math.min(e, d) - (h * h * k) * 0.25;
    }
    return d;
  },
  subtract: (a, b) => (x, y, z) => Math.max(a(x, y, z), -b(x, y, z)),
  intersect: (a, b) => (x, y, z) => Math.max(a(x, y, z), b(x, y, z)),
  invert: (a) => (x, y, z) => -a(x, y, z),
  offset: (a, k) => (x, y, z) => a(x, y, z) - k,
  /** 车削曲面：profile = [[y, r], ...] 从下到上，绕 y 轴中心 (cx,cz) */
  lathe: (cx, cz, profile) => (x, y, z) => {
    const r = Math.hypot(x - cx, z - cz);
    let best = Infinity;
    for (let i = 0; i + 1 < profile.length; i += 1) {
      const [y0, r0] = profile[i];
      const [y1, r1] = profile[i + 1];
      const seg = Math.hypot(y1 - y0, r1 - r0) || 1e-9;
      let t = ((r - r0) * (r1 - r0) + (y - y0) * (y1 - y0)) / (seg * seg);
      t = Math.max(0, Math.min(1, t));
      const py = y0 + (y1 - y0) * t, pr = r0 + (r1 - r0) * t;
      const d = Math.hypot(r - pr, y - py);
      if (d < best) best = d;
    }
    let inside = false;
    for (let i = 0, j = profile.length - 1; i < profile.length; j = i++) {
      const [yi, ri] = profile[i];
      const [yj, rj] = profile[j];
      if ((yi > y) !== (yj > y) && r < (rj - ri) * (y - yi) / (yj - yi) + ri) inside = !inside;
    }
    return inside ? -best : best;
  },
  bezier3: (p0, p1, p2, p3, segs = 24) => {
    const pts = [];
    for (let i = 0; i <= segs; i += 1) {
      const t = i / segs;
      const it = 1 - t;
      pts.push([
        it * it * it * p0[0] + 3 * it * it * t * p1[0] + 3 * it * t * t * p2[0] + t * t * t * p3[0],
        it * it * it * p0[1] + 3 * it * it * t * p1[1] + 3 * it * t * t * p2[1] + t * t * t * p3[1],
        it * it * it * p0[2] + 3 * it * it * t * p1[2] + 3 * it * t * t * p2[2] + t * t * t * p3[2],
      ]);
    }
    return pts;
  },
  /** 折线管（半径可沿 t 变化 rFn(t)） */
  polylineTube: (pts, rFn) => (x, y, z) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i], b = pts[i + 1];
      const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
      const len2 = bax * bax + bay * bay + baz * baz || 1e-9;
      const h = Math.max(0, Math.min(1, ((x - a[0]) * bax + (y - a[1]) * bay + (z - a[2]) * baz) / len2));
      const d = Math.hypot(x - a[0] - bax * h, y - a[1] - bay * h, z - a[2] - baz * h);
      const rr = rFn ? rFn((i + h) / (pts.length - 1)) : 0;
      const dd = d - rr;
      if (dd < best) best = dd;
    }
    return best;
  },
  /**
   * 沿路径挤出：profileFn(t) -> { rx, rz }（路径局部标架下的椭圆截面半径）。
   * 路径 pts: [[x,y,z], ...]；局部标架：T=切向，N=参考 up 投影，B=T×N。
   */
  extrudeAlong: (pts, profileFn) => (x, y, z) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i], b = pts[i + 1];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1e-9;
      tx /= tl; ty /= tl; tz /= tl;
      // 参考法向：与切向夹角过小时换轴
      let nx = 0, ny = 1, nz = 0;
      if (Math.abs(ty) > 0.92) { nx = 1; ny = 0; }
      const d0 = nx * tx + ny * ty + nz * tz;
      nx -= d0 * tx; ny -= d0 * ty; nz -= d0 * tz;
      const nl = Math.hypot(nx, ny, nz) || 1e-9;
      nx /= nl; ny /= nl; nz /= nl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const pax = x - a[0], pay = y - a[1], paz = z - a[2];
      const h = Math.max(0, Math.min(1, pax * tx + pay * ty + paz * tz));
      const t = (i + h) / (pts.length - 1);
      const prof = profileFn(t);
      const ox = pax - tx * h, oy = pay - ty * h, oz = paz - tz * h;
      const un = ox * nx + oy * ny + oz * nz;
      const ub = ox * bx + oy * by + oz * bz;
      const rx = Math.max(0.05, prof.rx), rz = Math.max(0.05, prof.rz);
      const e = Math.hypot(un / rx, ub / rz) - 1;
      const d = e * Math.min(rx, rz);
      if (d < best) best = d;
    }
    return best;
  },
};

/**
 * radialArray — 环形阵列：把 build(angle, i) 返回的 SDF 绕 (cx,cz) 的 y 轴
 * 均匀复制 count 份取并集。build 收到的 angle 为弧度（phase 起始）。
 * 注意：build 返回的 SDF 需要自己把角度信息用于摆放（本函数只做并集）。
 */
export function radialArray(count, cx, cz, build, { phase = 0 } = {}) {
  const fns = [];
  for (let i = 0; i < count; i += 1) {
    const ang = phase + (i / count) * TAU;
    fns.push(build(ang, i, cx, cz));
  }
  return (x, y, z) => {
    let d = Infinity;
    for (const f of fns) {
      const e = f(x, y, z);
      if (e < d) d = e;
    }
    return d;
  };
}

/* ---------------- sculptor ---------------- */
export class Sculptor {
  constructor(nx, ny, nz) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = new Uint16Array(nx * ny * nz);
  }
  idx(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : 0; }
  set(x, y, z, v) { if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = v; }

  /** SDF 填充。sdf<0.5 的体素写入 paint(x,y,z,info) 返回的调色板索引 */
  fill(sdf, paint) {
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < this.nx; x += 1) {
          const px = x + 0.5, py = y + 0.5, pz = z + 0.5;
          const d = sdf(px, py, pz);
          if (d < 0.5) {
            const v = paint(x, y, z, { d, cx: Math.max(0, -d) });
            if (v) this.set(x, y, z, v);
          }
        }
      }
    }
    return this;
  }
  repaint(paint, mask = null) {
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < this.nx; x += 1) {
          if (!this.get(x, y, z)) continue;
          if (mask && !mask(x, y, z)) continue;
          const v = paint(x, y, z);
          if (v) this.set(x, y, z, v);
        }
      }
    }
    return this;
  }
  carve(sdf) {
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < this.nx; x += 1) {
          if (!this.get(x, y, z)) continue;
          if (sdf(x + 0.5, y + 0.5, z + 0.5) < 0.5) this.set(x, y, z, 0);
        }
      }
    }
    return this;
  }
  emptyNeighbors(x, y, z) {
    let n = 0;
    if (!this.get(x - 1, y, z)) n += 1;
    if (!this.get(x + 1, y, z)) n += 1;
    if (!this.get(x, y - 1, z)) n += 1;
    if (!this.get(x, y + 1, z)) n += 1;
    if (!this.get(x, y, z - 1)) n += 1;
    if (!this.get(x, y, z + 1)) n += 1;
    return n;
  }
  isSurface(x, y, z) { return this.emptyNeighbors(x, y, z) > 0; }
  mirrorX() {
    const half = Math.ceil(this.nx / 2);
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < half; x += 1) {
          const v = this.get(x, y, z);
          if (v) this.set(this.nx - 1 - x, y, z, v);
        }
      }
    }
    return this;
  }
  count() {
    let n = 0;
    for (let i = 0; i < this.data.length; i += 1) if (this.data[i]) n += 1;
    return n;
  }
  contentBounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < this.nx; x += 1) {
          if (!this.get(x, y, z)) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
    if (maxX < minX) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1] };
  }
  toView() {
    const view = allocVoxels(this.nx, this.ny, this.nz);
    for (let y = 0; y < this.ny; y += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        for (let x = 0; x < this.nx; x += 1) {
          const v = this.get(x, y, z);
          if (v) view.setVoxel(x, y, z, v);
        }
      }
    }
    return view;
  }
  sliceY(y) {
    const rows = [];
    for (let z = 0; z < this.nz; z += 1) {
      let row = '';
      for (let x = 0; x < this.nx; x += 1) {
        const v = this.get(x, y, z);
        row += v ? (v % 10).toString(36) : '.';
      }
      rows.push(row);
    }
    return rows.join('\n');
  }
}

/* ---------------- stampGlyph ---------------- */
/**
 * 字模/位图刻印：把 bitmap（字符串数组，'#'/'1'/'X' 为实）盖到 sculptor 上。
 * axis: 'z' 面向 +z（行向上），'x' 面向 +x，'y' 顶面（行向 +z）。
 * engrave=true 时只覆盖已有体素（刻字），否则直接写入（贴花）。
 * paint(px,py,pz,gc,gr) -> paletteId
 */
export function stampGlyph(sc, bitmap, { x = 0, y = 0, z = 0, axis = 'z', paint, engrave = false } = {}) {
  const isOn = (ch) => ch === '#' || ch === '1' || ch === 'X' || ch === '*';
  for (let r = 0; r < bitmap.length; r += 1) {
    const row = bitmap[r];
    for (let c = 0; c < row.length; c += 1) {
      if (!isOn(row[c])) continue;
      let px, py, pz;
      if (axis === 'z') { px = x + c; py = y - r; pz = z; }
      else if (axis === 'x') { px = x; py = y - r; pz = z + c; }
      else { px = x + c; py = y; pz = z + r; }
      if (!sc.inside(px, py, pz)) continue;
      if (engrave && !sc.get(px, py, pz)) continue;
      const v = paint ? paint(px, py, pz, c, r) : 1;
      if (v) sc.set(px, py, pz, v);
    }
  }
  return sc;
}

/* ---------------- 装饰带：回纹 / 云纹 ---------------- */
/**
 * 回纹（Greek key）遮罩：u∈[0,1] 沿带方向，v∈[0,1] 沿带宽度方向。
 * 连续折线键纹，cells 控制每单元数，thick 控制线宽。
 */
export function meanderMask(u, v, { cells = 8, thick = 0.22 } = {}) {
  const cu = (((u % 1) + 1) % 1) * cells;
  const cell = Math.floor(cu);
  const fu = cu - cell;
  const t = thick;
  if (v < t && fu >= 0 && fu <= 1) return true;               // 底横笔
  if (fu < t && v <= 0.86) return true;                        // 左立笔
  if (v > 0.86 - t && fu <= 0.62) return true;                 // 顶横笔（半宽）
  if (fu > 0.62 - t && fu < 0.62 && v > 0.36 && v <= 0.86) return true; // 中竖笔
  if (v > 0.36 - t / 2 && v < 0.36 + t / 2 && fu >= 0.3 && fu < 0.62) return true; // 中横笔
  if (fu > 0.3 - t && fu < 0.3 && v >= 0.36 && v < 0.6) return true;  // 内勾
  return false;
}
/** 云纹（螺旋卷云）遮罩：u/v 归一化坐标，seed 变体 */
export function cloudMask(u, v, { seed = 3 } = {}) {
  const s = valueNoise3(u * 6, v * 6, seed, seed * 7);
  const band = Math.abs(Math.sin((u * 3 + v * 0.9) * Math.PI * 2 + s * 2.2));
  if (band < 0.3 && v > 0.12 && v < 0.88) return true;
  // 卷云小螺旋
  const swirl = Math.hypot((((u * 2) % 1) - 0.5) * 1.6, (v - 0.5) * 1.6);
  if (Math.abs(swirl - 0.32) < 0.09 && ((u * 2) % 1) < 0.5) return true;
  return false;
}

/* ---------------- weathering 侵蚀做旧 ---------------- */
/**
 * 边缘侵蚀：暴露面多的体素按 fbm 噪声概率回缩；可选 tintFn 做旧上色。
 * amount∈[0,0.3]，确定性（seed）。保护底线：整体体素数损失不超过 amount*2。
 */
export function weathering(sc, { amount = 0.1, seed = 13, tintFn = null } = {}) {
  const before = sc.count();
  const kill = [];
  for (let y = 0; y < sc.ny; y += 1) {
    for (let z = 0; z < sc.nz; z += 1) {
      for (let x = 0; x < sc.nx; x += 1) {
        if (!sc.get(x, y, z)) continue;
        const n = sc.emptyNeighbors(x, y, z);
        if (n < 3) continue;
        const p = fbm3(x, y, z, { freq: 0.17, seed, octaves: 2 });
        if (p > 1 - amount * (n / 3 + 0.6)) kill.push([x, y, z]);
      }
    }
  }
  const maxKill = Math.floor(before * amount * 1.8);
  for (let i = 0; i < Math.min(kill.length, maxKill); i += 1) {
    const [x, y, z] = kill[i];
    sc.set(x, y, z, 0);
  }
  if (tintFn) sc.repaint((x, y, z) => tintFn(x, y, z));
  return sc;
}

/* ---------------- LOD / 重采样 ---------------- */
/**
 * LOD 降采样（保轮廓去内噪）：f×f×f 块投票，占用率≥keepRatio 保留（取块内众数色）。
 * 返回新的 Sculptor（尺寸 ceil(n/f)）。
 */
export function downsampleLod(sc, f = 2, { keepRatio = 0.3 } = {}) {
  const nx2 = Math.max(1, Math.ceil(sc.nx / f));
  const ny2 = Math.max(1, Math.ceil(sc.ny / f));
  const nz2 = Math.max(1, Math.ceil(sc.nz / f));
  const out = new Sculptor(nx2, ny2, nz2);
  for (let by = 0; by < ny2; by += 1) {
    for (let bz = 0; bz < nz2; bz += 1) {
      for (let bx = 0; bx < nx2; bx += 1) {
        const hist = new Map();
        let total = 0;
        for (let dy = 0; dy < f; dy += 1) {
          for (let dz = 0; dz < f; dz += 1) {
            for (let dx = 0; dx < f; dx += 1) {
              const v = sc.get(bx * f + dx, by * f + dy, bz * f + dz);
              if (!v) continue;
              total += 1;
              hist.set(v, (hist.get(v) || 0) + 1);
            }
          }
        }
        if (!total) continue;
        const denom = f * f * f;
        if (total / denom < keepRatio) continue;
        let bestId = 0, bestN = -1;
        for (const [id, n] of hist) if (n > bestN) { bestN = n; bestId = id; }
        out.set(bx, by, bz, bestId);
      }
    }
  }
  return out;
}

/** nearest 邻重采样（sizeHint 拟合用），kx/ky/kz 为缩放系数 */
export function resampleSculptor(sc, kx, ky, kz) {
  const nx2 = Math.max(1, Math.round(sc.nx * kx));
  const ny2 = Math.max(1, Math.round(sc.ny * ky));
  const nz2 = Math.max(1, Math.round(sc.nz * kz));
  const out = new Sculptor(nx2, ny2, nz2);
  for (let y = 0; y < ny2; y += 1) {
    const sy = Math.min(sc.ny - 1, Math.floor((y + 0.5) / ky));
    for (let z = 0; z < nz2; z += 1) {
      const sz = Math.min(sc.nz - 1, Math.floor((z + 0.5) / kz));
      for (let x = 0; x < nx2; x += 1) {
        const sx = Math.min(sc.nx - 1, Math.floor((x + 0.5) / kx));
        const v = sc.get(sx, sy, sz);
        if (v) out.set(x, y, z, v);
      }
    }
  }
  return out;
}

/* ---------------- 全模型体素场 ---------------- */
/** 把各 group（position + sculptor）装配到统一坐标系的 Uint16 场 */
export function assembleField(model) {
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  const placed = [];
  for (const g of model.groups) {
    // 体素场是整数网格：group 位置取整（序列化仍保留原浮点值）
    if (!g._posInt) g._posInt = g.position.map((v) => Math.round(v));
    const pos = g._posInt;
    const cb = g.sculptor.contentBounds();
    if (!cb) continue;
    placed.push({ g, cb });
    for (let i = 0; i < 3; i += 1) {
      const lo = pos[i] + cb.min[i];
      const hi = pos[i] + cb.max[i] + 1;
      if (lo < mins[i]) mins[i] = lo;
      if (hi > maxs[i]) maxs[i] = hi;
    }
  }
  if (!placed.length) return null;
  for (let i = 0; i < 3; i += 1) if (mins[i] > maxs[i]) return null; // 无内容
  const [minX, minY, minZ] = mins;
  const [maxX, maxY, maxZ] = maxs;
  const dx = Math.max(1, maxX - minX), dy = Math.max(1, maxY - minY), dz = Math.max(1, maxZ - minZ);
  const field = new Uint16Array(dx * dy * dz);
  const idx = (x, y, z) => (y * dz + z) * dx + x;
  for (const { g, cb } of placed) {
    const [bx, by, bz] = g._posInt || g.position.map((v) => Math.round(v));
    for (let y = cb.min[1]; y <= cb.max[1]; y += 1) {
      for (let z = cb.min[2]; z <= cb.max[2]; z += 1) {
        for (let x = cb.min[0]; x <= cb.max[0]; x += 1) {
          const v = g.sculptor.get(x, y, z);
          if (v) field[idx(bx + x - minX, by + y - minY, bz + z - minZ)] = v;
        }
      }
    }
  }
  return { dims: [dx, dy, dz], origin: [minX, minY, minZ], field, idx };
}

/* ---------------- 3D / 2D 连通域 ---------------- */
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** 6-连通 3D 连通域，返回 [{ id, voxels:[x,y,z][], size }]（按 size 降序） */
export function components3D(fieldObj) {
  const { dims, field, idx } = fieldObj;
  const [dx, dy, dz] = dims;
  const label = new Int32Array(field.length);
  const comps = [];
  let next = 0;
  const queue = new Int32Array(field.length);
  for (let start = 0; start < field.length; start += 1) {
    if (!field[start] || label[start]) continue;
    next += 1;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = next;
    const voxels = [];
    while (head < tail) {
      const cur = queue[head++];
      const x = cur % dx;
      const z = Math.floor(cur / dx) % dz;
      const y = Math.floor(cur / (dx * dz));
      voxels.push([x, y, z]);
      for (const [ox, oy, oz] of N6) {
        const nxp = x + ox, nyp = y + oy, nzp = z + oz;
        if (nxp < 0 || nyp < 0 || nzp < 0 || nxp >= dx || nyp >= dy || nzp >= dz) continue;
        const ni = idx(nxp, nyp, nzp);
        if (!field[ni] || label[ni]) continue;
        label[ni] = next;
        queue[tail++] = ni;
      }
    }
    comps.push({ id: next, voxels, size: voxels.length });
  }
  comps.sort((a, b) => b.size - a.size);
  return comps;
}

/* ---------------- critic ---------------- */
export function entropyBits(counts) {
  let total = 0;
  for (const c of counts) total += c;
  if (!total) return 0;
  let e = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / total;
    e -= p * Math.log2(p);
  }
  return e;
}

/** 直线 3D 桥体素序列（曼哈顿步进，保证 6-连通） */
function lineVoxels(a, b) {
  const out = [[a[0], a[1], a[2]]];
  const cur = [a[0], a[1], a[2]];
  for (let axis = 0; axis < 3; axis += 1) {
    while (cur[axis] !== b[axis]) {
      cur[axis] += Math.sign(b[axis] - cur[axis]);
      out.push([cur[0], cur[1], cur[2]]);
    }
  }
  return out;
}

/**
 * criticSculpt — 量化自评。
 * 返回 { silhouette, paletteEntropy, edgeNoise, symmetryError, floatingClusters,
 *        bounds, lod, score, issues }
 */
export function criticSculpt(model, { sizeHint = null } = {}) {
  const F = assembleField(model);
  if (!F) {
    return { score: 0, pass: false, issues: ['empty-model'], silhouette: null, paletteEntropy: 0, edgeNoise: 1, symmetryError: 1, floatingClusters: 0, bounds: null, lod: null };
  }
  const { dims, field, idx, origin } = F;
  const [dx, dy, dz] = dims;
  const issues = [];

  /* --- 剪影：XY 正交投影（沿 z 取任意） --- */
  const proj = new Uint8Array(dx * dy);
  for (let y = 0; y < dy; y += 1) {
    for (let x = 0; x < dx; x += 1) {
      for (let z = 0; z < dz; z += 1) {
        if (field[idx(x, y, z)]) { proj[y * dx + x] = 1; break; }
      }
    }
  }
  // 投影 bbox + 占用率
  let pminX = dx, pminY = dy, pmaxX = -1, pmaxY = -1, pCount = 0;
  for (let y = 0; y < dy; y += 1) {
    for (let x = 0; x < dx; x += 1) {
      if (!proj[y * dx + x]) continue;
      pCount += 1;
      if (x < pminX) pminX = x; if (x > pmaxX) pmaxX = x;
      if (y < pminY) pminY = y; if (y > pmaxY) pmaxY = y;
    }
  }
  const bw = pmaxX - pminX + 1, bh = pmaxY - pminY + 1;
  const occupancy = pCount / (bw * bh);
  // 8-连通剪影连通域
  const seen = new Uint8Array(dx * dy);
  const silComps = [];
  for (let s = 0; s < proj.length; s += 1) {
    if (!proj[s] || seen[s]) continue;
    let stack = [s];
    seen[s] = 1;
    let area = 0;
    while (stack.length) {
      const cur = stack.pop();
      area += 1;
      const cx2 = cur % dx, cy2 = Math.floor(cur / dx);
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue;
          const nxp = cx2 + ox, nyp = cy2 + oy;
          if (nxp < 0 || nyp < 0 || nxp >= dx || nyp >= dy) continue;
          const ni = nyp * dx + nxp;
          if (proj[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
    }
    silComps.push(area);
  }
  silComps.sort((a, b) => b - a);
  const mainRatio = pCount ? silComps[0] / pCount : 0;
  const singleMain = silComps.length === 1 || (silComps.length > 1 && silComps[1] / silComps[0] < 0.02);
  if (!singleMain) issues.push(`silhouette-fragments(${silComps.length})`);

  /* --- 调色板熵 --- */
  const usage = new Map();
  for (let i = 0; i < field.length; i += 1) {
    const v = field[i];
    if (v) usage.set(v, (usage.get(v) || 0) + 1);
  }
  const entropy = entropyBits([...usage.values()]);
  if (entropy < 2.2) issues.push(`entropy-low(${entropy.toFixed(2)})`);
  if (entropy > 4.5) issues.push(`entropy-high(${entropy.toFixed(2)})`);

  /* --- 边缘噪声度：表面体素邻域色散 --- */
  let surfN = 0, chatN = 0;
  for (let y = 0; y < dy; y += 1) {
    for (let z = 0; z < dz; z += 1) {
      for (let x = 0; x < dx; x += 1) {
        const v = field[idx(x, y, z)];
        if (!v) continue;
        const ids = new Map();
        let empty = 0;
        for (const [ox, oy, oz] of N6) {
          const nxp = x + ox, nyp = y + oy, nzp = z + oz;
          const nv = (nxp < 0 || nyp < 0 || nzp < 0 || nxp >= dx || nyp >= dy || nzp >= dz) ? 0 : field[idx(nxp, nyp, nzp)];
          if (!nv) { empty += 1; continue; }
          ids.set(nv, (ids.get(nv) || 0) + 1);
        }
        if (!empty) continue;
        surfN += 1;
        let modeN = 0;
        for (const n of ids.values()) if (n > modeN) modeN = n;
        if (ids.size >= 3 && modeN <= 2) chatN += 1;
      }
    }
  }
  const edgeNoise = surfN ? chatN / surfN : 0;
  if (edgeNoise > 0.5) issues.push(`edge-noise(${edgeNoise.toFixed(2)})`);

  /* --- 左右对称误差（占用 mask 镜像 XOR） --- */
  let symBad = 0, symTot = 0;
  for (let y = 0; y < dy; y += 1) {
    for (let z = 0; z < dz; z += 1) {
      for (let x = 0; x < Math.floor(dx / 2); x += 1) {
        const a = field[idx(x, y, z)] ? 1 : 0;
        const b = field[idx(dx - 1 - x, y, z)] ? 1 : 0;
        symTot += 1;
        if (a !== b) symBad += 1;
      }
    }
  }
  const symmetryError = symTot ? symBad / symTot : 0;

  /* --- 悬浮簇：3D 连通域（最大者为主体，其余为悬浮候选） --- */
  const comps = components3D(F);
  const floating = comps.slice(1);
  if (comps.length > 1) issues.push(`floating-clusters(${comps.length - 1})`);

  /* --- bounds / sizeHint --- */
  const bounds = { origin, size: dims };
  let hintFill = null;
  if (sizeHint) {
    const ratios = [0, 1, 2].map((i) => dims[i] / Math.max(1, sizeHint[i]));
    hintFill = ratios.map((r) => Number(r.toFixed(3)));
    for (const r of ratios) {
      if (r < 0.85) { issues.push(`bounds-shrink(${r.toFixed(2)})`); break; }
      if (r > 1.02) { issues.push(`bounds-overflow(${r.toFixed(2)})`); break; }
    }
  }

  /* --- LOD 统计（f=2 保轮廓率） --- */
  const lod = downsampleLod(refield(F), 2);
  let lodKeep = null;
  if (lod) {
    let lodCount = 0;
    for (let i = 0; i < lod.data.length; i += 1) if (lod.data[i]) lodCount += 1;
    const fullCount = comps.reduce((s, c) => s + c.size, 0);
    lodKeep = Number((lodCount * 8 / Math.max(1, fullCount)).toFixed(3));
  }

  /* --- 评分 --- */
  let score = 10;
  score -= floating.length * 1.5;
  if (!singleMain) score -= 3;
  if (entropy < 2.2 || entropy > 4.5) score -= 2;
  if (edgeNoise > 0.5) score -= 1;
  if (symmetryError > 0.35) score -= 0.5;
  if (hintFill) {
    for (const r of hintFill) {
      if (r < 0.85 || r > 1.02) { score -= 1.5; break; }
    }
  }
  score = Math.max(0, Number(score.toFixed(2)));

  return {
    score,
    pass: issues.length === 0,
    issues,
    silhouette: {
      occupancy: Number(occupancy.toFixed(3)),
      bbox: [bw, bh],
      components: silComps.length,
      componentsArea: silComps.slice(0, 4),
      mainRatio: Number(mainRatio.toFixed(3)),
      singleMain,
    },
    paletteEntropy: Number(entropy.toFixed(3)),
    usedColors: usage.size,
    edgeNoise: Number(edgeNoise.toFixed(3)),
    symmetryError: Number(symmetryError.toFixed(3)),
    floatingClusters: floating.length,
    floatingSizes: floating.map((c) => c.size),
    components: comps.length,
    bounds,
    hintFill,
    lodKeep,
    voxelCount: comps.reduce((s, c) => s + c.size, 0),
  };
}

/** 由装配场重建一个 Sculptor（critic 内部用） */
function refield(F) {
  const [dx, dy, dz] = F.dims;
  const sc = new Sculptor(dx, dy, dz);
  sc.data.set(F.field);
  return sc;
}

/* ---------------- 自动修复（确定性） ---------------- */
/** 把 idMap 应用到所有 group 的体素 */
export function remapPalette(model, idMap) {
  for (const g of model.groups) {
    const d = g.sculptor.data;
    for (let i = 0; i < d.length; i += 1) {
      const nv = idMap[d[i]];
      if (nv) d[i] = nv;
    }
  }
}

/** 焊接悬浮簇：大簇加桥，≤2 体素碎屑直接删除。返回 { bridged, removed } */
export function weldFloating(model) {
  const F = assembleField(model);
  if (!F) return { bridged: 0, removed: 0 };
  const comps = components3D(F);
  if (comps.length <= 1) return { bridged: 0, removed: 0 };
  const { dims, origin, field, idx } = F;
  const [dx, dy, dz] = dims;
  const main = comps[0];
  const mainSet = new Set(main.voxels.map(([x, y, z]) => idx(x, y, z)));
  let bridged = 0, removed = 0;
  for (let ci = 1; ci < comps.length; ci += 1) {
    const comp = comps[ci];
    if (comp.size <= 2) {
      // 碎屑：直接从属主 group 里删掉
      for (const [x, y, z] of comp.voxels) {
        const wx = x + origin[0], wy = y + origin[1], wz = z + origin[2];
        for (const g of model.groups) {
          const lx = wx - g.position[0], ly = wy - g.position[1], lz = wz - g.position[2];
          if (g.sculptor.get(lx, ly, lz)) { g.sculptor.set(lx, ly, lz, 0); break; }
        }
      }
      removed += comp.size;
      continue;
    }
    // 最近体素对
    let bestD = Infinity, bestPair = null;
    const step = comp.size > 400 ? 2 : 1;
    for (let i = 0; i < comp.voxels.length; i += step) {
      const a = comp.voxels[i];
      for (let j = 0; j < main.voxels.length; j += step) {
        const b = main.voxels[j];
        const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        if (d < bestD) { bestD = d; bestPair = [a, b]; }
      }
    }
    if (!bestPair) continue;
    // 桥用主簇邻接色（视觉延续）
    const bridgeId = field[idx(bestPair[1][0], bestPair[1][1], bestPair[1][2])] || 1;
    const voxels = lineVoxels(bestPair[0], bestPair[1]);
    addBridgeGroup(model, voxels, bridgeId, origin);
    bridged += 1;
  }
  return { bridged, removed };
}

function addBridgeGroup(model, voxels, id, origin = [0, 0, 0]) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of voxels) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // voxels 是装配场坐标（0 基），加上 origin 变回模型世界坐标
  const sc = new Sculptor(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1);
  for (const [x, y, z] of voxels) sc.set(x - minX, y - minY, z - minZ, id);
  model.groups.push({
    id: `weld_${model.groups.length}_${minX + origin[0]}_${minY + origin[1]}`,
    name: '焊桥', position: [minX + origin[0], minY + origin[1], minZ + origin[2]], sculptor: sc, weld: true,
  });
}

/**
 * 熵过高：把用量最少的调色板 id 并入最近色的较高用量 id，直到熵 ≤4.5（或只剩 8 色）。
 * 熵过低（<2.2）：injectAccent 注入点缀色。
 */
export function balanceEntropy(model, target = [2.2, 4.5]) {
  const F = assembleField(model);
  if (!F) return { merged: 0, injected: false };
  const { field, idx, dims, origin } = F;
  const counts = new Map();
  for (let i = 0; i < field.length; i += 1) {
    const v = field[i];
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  let merged = 0;
  let guard = 64;
  while (entropyBits([...counts.values()]) > target[1] && counts.size > 8 && guard-- > 0) {
    // 用量最少的 id
    let loId = 0, loN = Infinity;
    for (const [id, n] of counts) if (n < loN) { loN = n; loId = id; }
    // 最近色（RGB）且用量更高
    const rgbLo = model.palette.items.find((it) => it.id === loId)?.rgb || [128, 128, 128];
    let bestId = 0, bestD = Infinity;
    for (const [id, n] of counts) {
      if (id === loId || n <= loN) continue;
      const rgb = model.palette.items.find((it) => it.id === id)?.rgb || [0, 0, 0];
      const d = colorDist(rgb, rgbLo);
      if (d < bestD) { bestD = d; bestId = id; }
    }
    if (!bestId) break;
    remapPalette(model, new Map([[loId, bestId]]));
    counts.set(bestId, (counts.get(bestId) || 0) + loN);
    counts.delete(loId);
    merged += 1;
  }
  let injected = false;
  if (entropyBits([...counts.values()]) < target[0]) {
    injected = injectAccent(model) > 0;
  }
  return { merged, injected };
}

/** 熵过低：注入互补点缀 ramp，重涂确定性选中的表面体素。返回重涂数量 */
export function injectAccent(model, { ratio = 0.07, seed = 91 } = {}) {
  const F = assembleField(model);
  if (!F) return 0;
  // 主色调
  const counts = new Map();
  for (let i = 0; i < F.field.length; i += 1) {
    const v = F.field[i];
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  let domId = 1, domN = 0, totN = 0;
  for (const [id, n] of counts) { totN += n; if (n > domN) { domN = n; domId = id; } }
  const domRgb = model.palette.items.find((it) => it.id === domId)?.rgb || [128, 128, 128];
  const [h, s, v] = rgbToHsv(domRgb);
  if (model.palette.byName.has('accent')) return 0; // 幂等：accent ramp 只注入一次
  const accentHex = rgbToHex(hsvToRgb([(h + 180) % 360, Math.max(0.55, Math.min(0.9, s + 0.25)), Math.min(1, v + 0.15)]));
  const accent = model.palette.ramp('accent', accentHex, { steps: 5, vRange: [0.6, 1.12] });
  let painted = 0;
  for (const g of model.groups) {
    g.sculptor.repaint((x, y, z) => {
      const n = g.sculptor.emptyNeighbors(x, y, z);
      if (n < 2) return 0; // 只点表面
      if (hash3(x + g.position[0], y + g.position[1], z + g.position[2], seed) > ratio) return 0;
      painted += 1;
      return accent(0.4 + hash3(x, y, z, seed + 1) * 0.55);
    });
  }
  return painted;
}

/** 抖动色平滑：表面体素若邻域众数色（≥4）非己色则改色。返回改动数 */
export function smoothChatter(model) {
  let changed = 0;
  for (const g of model.groups) {
    const sc = g.sculptor;
    const edits = [];
    for (let y = 0; y < sc.ny; y += 1) {
      for (let z = 0; z < sc.nz; z += 1) {
        for (let x = 0; x < sc.nx; x += 1) {
          const v = sc.get(x, y, z);
          if (!v) continue;
          if (sc.emptyNeighbors(x, y, z) === 0) continue;
          const ids = new Map();
          for (const [ox, oy, oz] of N6) {
            const nv = sc.get(x + ox, y + oy, z + oz);
            if (nv) ids.set(nv, (ids.get(nv) || 0) + 1);
          }
          let modeId = 0, modeN = 0;
          for (const [id, n] of ids) if (n > modeN) { modeN = n; modeId = id; }
          if (modeId && modeId !== v && modeN >= 4) edits.push([x, y, z, modeId]);
        }
      }
    }
    for (const [x, y, z, id] of edits) { sc.set(x, y, z, id); changed += 1; }
  }
  return changed;
}

/**
 * autoRepairLoop — critic 发现问题 → 确定性修复 → 重评，≤maxRounds 轮。
 * 返回 { before, after, rounds: [{round, critique, actions}], changed }
 */
export function autoRepairLoop(model, { sizeHint = null, maxRounds = 3, log = () => {} } = {}) {
  const before = criticSculpt(model, { sizeHint });
  const rounds = [];
  let critique = before;
  for (let r = 1; r <= maxRounds; r += 1) {
    if (critique.pass) break;
    const actions = [];
    if (critique.floatingClusters > 0) {
      const res = weldFloating(model);
      if (res.bridged || res.removed) actions.push(`weld(bridged=${res.bridged},removed=${res.removed})`);
    }
    if (critique.paletteEntropy > 4.5 || critique.paletteEntropy < 2.2) {
      const res = balanceEntropy(model);
      if (res.merged) actions.push(`entropy-merge(${res.merged})`);
      if (res.injected) actions.push('accent-inject');
    }
    if (critique.edgeNoise > 0.5) {
      const n = smoothChatter(model);
      if (n) actions.push(`smooth-chatter(${n})`);
    }
    critique = criticSculpt(model, { sizeHint });
    rounds.push({ round: r, actions, critique });
    log(`repair round ${r}: [${actions.join(', ')}] score ${before.score} -> ${critique.score}`);
    if (!actions.length) break; // 无可用修复，避免空转
  }
  return { before, after: critique, rounds, changed: rounds.length > 0 };
}

/** sizeHint 拟合：整模重采样到 hint（每轴比例 clamp [0.5, 2.5]）。返回是否改动 */
export function fitToSizeHint(model, sizeHint) {
  if (!sizeHint || sizeHint.length !== 3) return false;
  const F = assembleField(model);
  if (!F) return false;
  const nat = F.dims;
  const ks = [0, 1, 2].map((i) => Math.max(0.5, Math.min(2.5, sizeHint[i] / Math.max(1, nat[i]))));
  if (ks.every((k) => Math.abs(k - 1) < 0.06)) return false;
  for (const g of model.groups) {
    const cb = g.sculptor.contentBounds();
    if (!cb) continue;
    // 以 group 内容中心为锚缩放位置，保证整体不跑出 hint
    g.position = [
      Math.round(g.position[0] * ks[0]),
      Math.round(g.position[1] * ks[1]),
      Math.round(g.position[2] * ks[2]),
    ];
    g.sculptor = resampleSculptor(g.sculptor, ks[0], ks[1], ks[2]);
  }
  for (const b of model.bones || []) {
    b.position = [Math.round(b.position[0] * ks[0]), Math.round(b.position[1] * ks[1]), Math.round(b.position[2] * ks[2])];
  }
  if (model.pivot) model.pivot = model.pivot.map((v, i) => Math.round(v * ks[i]));
  for (const anim of model.animations || []) {
    for (const ch of anim.channels) {
      if (ch.path !== 'translation') continue;
      for (const kf of ch.keyframes) kf.value = kf.value.map((v, i) => v * ks[i]);
    }
  }
  return true;
}

/* ---------------- 常用上色策略 ---------------- */
export function handPaint({ ramp, edgeRamp = null, edgeN = 5, rampT = (y, h) => y / h, noise = 0.18, seed = 7 } = {}) {
  return (x, y, z, info) => {
    const t = rampT(y, info.h || y);
    const jit = (fbm3(x, y, z, { freq: 0.35, seed }) - 0.5) * noise;
    const n = info.emptyN || 0;
    if (edgeRamp && n >= edgeN) return edgeRamp(0.85);
    return ramp(Math.max(0, Math.min(1, t + jit)));
  };
}
