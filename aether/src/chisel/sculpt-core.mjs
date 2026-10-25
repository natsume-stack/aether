/**
 * vox-sculpt.mjs — 精细体素雕塑库 (ModelSculpt/0.1)
 *
 * 设计目标：让 AI 像人一样"雕刻+上色"VOXA 模型，而不是拼方块：
 *  - SDF 雕塑：车削曲面/贝塞尔管/环面/软布尔，得到有机轮廓
 *  - 材质色阶：每个材质生成 6~10 阶明暗渐变（人做模型调色板 20~256 色）
 *  - 逐体素上色：高度渐变 + 边缘高光 + 缝隙暗部 + 噪声抖动 + 纹样遮罩
 *  - 装饰/雕刻：条带、回纹、云纹、刻字、镂空、发光芯
 *
 * 输出 VoxelView（调色板索引体素），交给 @box/mesher 生成 v7 模型。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
const VOXA_ROOT = process.env.VOXA_ROOT || 'D:/desktop/神奇代码岛/box3-local-engine/apps/voxa';
const requireFromVoxa = createRequire(path.join(VOXA_ROOT, 'package.json'));
const { allocVoxels } = requireFromVoxa('@box/utils/voxel');

/* ---------------- color ---------------- */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
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

/* ---------------- palette ---------------- */
export class Palette {
  constructor() {
    this.items = []; // [{ id, name, rgb, emissive, hsv }]
    this.byName = new Map();
  }
  /**
   * 加入一阶颜色，返回调色板索引（从 1 开始，0 = 空）
   */
  add(hex, { name = '', emissive = 0 } = {}) {
    const rgb = hexToRgb(rgbToHex(typeof hex === 'string' ? hex : hex));
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
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
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

/* ---------------- SDF library ---------------- */
export const sd = {
  sphere: (px, py, pz, r) => (x, y, z) => Math.hypot(x - px, y - py, z - pz) - r,
  ellipsoid: (cx, cy, cz, rx, ry, rz) => (x, y, z) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry, dz = (z - cz) / rz;
    const k0 = Math.hypot(dx, dy, dz);
    const k1 = Math.hypot(dx * rx, dy * ry, dz * rz);
    return (k0 * (k0 - 1)) * (k1 / (k0 || 1e-9)) * 0 + ((k0 - 1) * Math.min(rx, ry, rz)); // 近似
  },
  /** 更稳定的椭球（足够做外形用） */
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
  /** 线段胶囊 a→b */
  capsule: (ax, ay, az, bx, by, bz, r) => (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az;
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
    return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
  },
  /** 圆柱（沿 y） */
  cylinderY: (cx, cz, y0, y1, r) => (x, y, z) => {
    const dr = Math.hypot(x - cx, z - cz) - r;
    const dy = Math.max(y0 - y, y - y1);
    const ax = Math.max(dr, 0), ay = Math.max(dy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(dr, dy), 0);
  },
  /** Z 轴环面，绕 z 轴，圆心 (cx,cy)，主半径 R 管半径 r；thetaLimit 可做圆弧 */
  torusZ: (cx, cy, cz, R, r) => (x, y, z) => {
    const q = [Math.hypot(x - cx, y - cy) - R, z - cz];
    return Math.hypot(q[0], q[1]) - r;
  },
  torusY: (cx, cy, cz, R, r) => (x, y, z) => {
    const q = [Math.hypot(x - cx, z - cz) - R, y - cy];
    return Math.hypot(q[0], q[1]) - r;
  },
  /** XZ 平面（法线 y），高度 hy */
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
  /** 平移/缩放包装 */
  transform: (f, { tx = 0, ty = 0, tz = 0, s = 1 }) => (x, y, z) => f((x - tx) / s, (y - ty) / s, (z - tz) / s) * s,
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
    // 内部判定：点在 profile 多边形内（r-y 平面）
    let inside = false;
    for (let i = 0, j = profile.length - 1; i < profile.length; j = i++) {
      const [yi, ri] = profile[i];
      const [yj, rj] = profile[j];
      if ((yi > y) !== (yj > y) && r < (rj - ri) * (y - yi) / (yj - yi) + ri) inside = !inside;
    }
    return inside ? -best : best;
  },
  /** 贝塞尔曲线采样为折线 */
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
};

/* ---------------- sculptor ---------------- */
export class Sculptor {
  /**
   * @param {number} nx ny nz 体素包围盒尺寸（局部坐标 0..n）
   */
  constructor(nx, ny, nz) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.data = new Uint16Array(nx * ny * nz);
  }
  idx(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x, y, z) { return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : 0; }
  set(x, y, z, v) { if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = v; }

  /**
   * SDF 填充。sdf<0 的体素写入 paint(x,y,z,info) 返回的调色板索引。
   * info: { d: sdf值, cx: 距表面深度(0=表面层) }
   * @param {Function} paint (x, y, z, info) => paletteIndex
   */
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
  /** 只重上色已存在的体素（mask 可选） */
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
  /** 雕掉 sdf<0 的部分 */
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
  /** 邻居空计数（0~6），越大越靠边缘/角落 */
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
  /** 是否表面体素（六邻至少一个空） */
  isSurface(x, y, z) { return this.emptyNeighbors(x, y, z) > 0; }
  /** X 轴镜像（把 x < nx/2 镜到右侧；两侧各自 paint） */
  mirrorX(paintLeft) {
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
  /** 实际占用包围盒 {min:[x,y,z], max:[x,y,z]}（含） */
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
  /** debug：分层打印（y 从上往下） */
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

/* ---------------- 常用上色策略 ---------------- */
/**
 * 标准手工感上色：
 *  - t = 高度比例 0..1
 *  - 底部暗、顶部亮
 *  - 边缘（空邻居多）提亮或描边色
 *  - 噪声抖动 ±1 阶
 */
export function handPaint({ ramp, edgeRamp = null, edgeN = 5, rampT = (y, h) => y / h, noise = 0.18, seed = 7 } = {}) {
  return (x, y, z, info) => {
    const cb = info.ctxBounds || null;
    const t = rampT(y, info.h || y);
    const jit = (fbm3(x, y, z, { freq: 0.35, seed }) - 0.5) * noise;
    const n = info.emptyN || 0;
    if (edgeRamp && n >= edgeN) return edgeRamp(0.85);
    return ramp(Math.max(0, Math.min(1, t + jit)));
  };
}
