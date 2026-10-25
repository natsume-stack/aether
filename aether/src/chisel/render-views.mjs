/**
 * render-views.mjs — v4 评审用多视角正交渲染（front/back/left/right + 剪影位图）。
 *
 * 与 preview-renderer（固定等距）互补：评审需要"转着看"，正交四视图是
 * 人做体素模型时核对轮廓的标准视角。输出 PNG + 每视图剪影网格（供与
 * brief.silhouette 计算 IoU，结构先于外观）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from './png.mjs';
import { ensureDir } from './common.mjs';

/** camera 在 axis 负/正方向；u 为屏幕横轴取值，flip 控制左右手性 */
const VIEW_DEFS = {
  front: { axis: 'z', dir: -1, u: (v) => v.x, flip: false },
  back: { axis: 'z', dir: 1, u: (v) => v.x, flip: true },
  left: { axis: 'x', dir: -1, u: (v) => v.z, flip: true },
  right: { axis: 'x', dir: 1, u: (v) => v.z, flip: false },
};

/** model.groups + palette → 扁平体素表（模型空间） */
export function flatten(model) {
  const voxels = [];
  for (const g of model.groups) {
    const sc = g.sculptor;
    for (let y = 0; y < sc.ny; y += 1) {
      for (let z = 0; z < sc.nz; z += 1) {
        for (let x = 0; x < sc.nx; x += 1) {
          const id = sc.get(x, y, z);
          if (!id) continue;
          voxels.push({
            x: g.position[0] + x,
            y: g.position[1] + y,
            z: g.position[2] + z,
            id,
            emptyN: sc.emptyNeighbors(x, y, z),
            surface: sc.isSurface(x, y, z),
          });
        }
      }
    }
  }
  return voxels;
}

const shadeMul = (emptyN, emissive) => {
  const f = [0.52, 0.66, 0.78, 0.9, 1.0, 1.12, 1.2][Math.min(6, emptyN)] ?? 1.0;
  return f + (emissive ? 0.25 * emissive : 0);
};

/**
 * 渲染一个视角并写 PNG。
 * 返回 { file, silhouette, grid: [w,h] }（silhouette 为体素分辨率位图，y 已翻转）。
 */
export function renderView(voxels, matById, viewName, { outFile, size = 320, background = '#10161f' }) {
  const def = VIEW_DEFS[viewName];
  const surface = voxels.filter((v) => v.surface);
  if (!surface.length) throw new Error(`render-views: ${viewName} 无可见体素`);
  const us = surface.map(def.u);
  const ys = surface.map((v) => v.y);
  const uMin = Math.min(...us) - 1;
  const uMax = Math.max(...us) + 1;
  const yMin = Math.min(...ys) - 1;
  const yMax = Math.max(...ys) + 1;
  const contentW = uMax - uMin;
  const contentH = yMax - yMin;
  const scale = Math.min((size * 0.88) / contentW, (size * 0.88) / contentH);
  const offX = size / 2 - ((uMin + uMax) / 2) * scale;
  const offY = size / 2 - ((yMin + yMax) / 2) * scale;

  const bg = /^#[0-9a-f]{6}$/i.test(background)
    ? [parseInt(background.slice(1, 3), 16), parseInt(background.slice(3, 5), 16), parseInt(background.slice(5, 7), 16)]
    : [16, 22, 31];
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255;
  }

  const put = (u, vY, rgb, mul) => {
    const x0 = Math.max(0, Math.floor(offX + (u - uMin) * scale));
    const y0 = Math.max(0, Math.floor(offY + (yMax - 1 - vY) * scale));
    const x1 = Math.min(size - 1, Math.floor(x0 + scale) - 1);
    const y1 = Math.min(size - 1, Math.floor(y0 + scale) - 1);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = (y * size + x) * 4;
        rgba[p] = Math.min(255, rgb[0] * mul);
        rgba[p + 1] = Math.min(255, rgb[1] * mul);
        rgba[p + 2] = Math.min(255, rgb[2] * mul);
        rgba[p + 3] = 255;
      }
    }
  };

  // painter：远→近（相机在 dir 方向；dir=-1 时近 = 小坐标 → 降序绘制）
  const sorted = [...surface].sort((a, b) => (b[def.axis] - a[def.axis]) * def.dir);
  for (const v of sorted) {
    const mat = matById.get(v.id);
    if (!mat) continue;
    let u = def.u(v);
    if (def.flip) u = uMin + (uMax - u);
    put(u, v.y, mat.rgb, shadeMul(v.emptyN, mat.emissive));
  }

  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, encodePng(size, size, rgba));

  // 剪影（体素分辨率）
  const sw = contentW;
  const sh = contentH;
  const silhouette = new Uint8Array(sw * sh);
  for (const v of voxels) {
    let u = def.u(v);
    if (def.flip) u = uMin + (uMax - u);
    const su = Math.round(u - uMin);
    const sv = Math.round(yMax - 1 - v.y);
    if (su >= 0 && su < sw && sv >= 0 && sv < sh) silhouette[sv * sw + su] = 1;
  }
  return { file: outFile, silhouette, grid: [sw, sh] };
}

/**
 * 渲染四视图并写 PNG。
 * @returns {Map<viewName, {file, silhouette, grid}>}
 */
export function renderOrthoViews(model, { outDir, size = 320, views = ['front', 'back', 'left', 'right'] } = {}) {
  ensureDir(outDir);
  const matById = new Map(model.palette.items.map((it) => [it.id, it]));
  const voxels = flatten(model);
  const out = new Map();
  for (const viewName of views) {
    const rendered = renderView(voxels, matById, viewName, {
      outFile: path.join(outDir, `view-${viewName}.png`),
      size,
    });
    out.set(viewName, rendered);
  }
  return out;
}

/** 剪影 IoU（brief.silhouette 归一化 0..1 折线 vs 渲染剪影；y: 0=底 1=顶） */
export function silhouetteIoU(renderedSil, grid, polyline) {
  if (!polyline || polyline.length < 3) return null;
  const [w, h] = grid;
  const poly = polyline.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
  const target = new Uint8Array(w * h);
  const minY = Math.max(0, Math.floor(Math.min(...poly.map((p) => p[1]))));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...poly.map((p) => p[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    const xs = [];
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.round(xs[i])); x <= Math.min(w - 1, Math.round(xs[i + 1])); x += 1) {
        target[y * w + x] = 1;
      }
    }
  }
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (renderedSil[i] && target[i]) inter += 1;
    if (renderedSil[i] || target[i]) uni += 1;
  }
  return uni ? inter / uni : 0;
}
