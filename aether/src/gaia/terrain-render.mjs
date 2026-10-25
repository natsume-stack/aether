/**
 * TerrainRender/0.1 — TerrainPlan 可视化：俯瞰图 + 伪 3D 等距图，输出 PNG。
 *
 * 俯瞰图：高度+生物群系着色、hillshade 光照、河流/路网/zone 边界/POI 标注叠加、
 *         底部生物群系图例条。
 * 等距图：painter's algorithm 逐列投影（参考世界地图投影思路，独立实现）。
 * 仅依赖 png.mjs 与 terrain-engine.mjs 的采样工具，零 npm 依赖。
 */
import { encodePng } from './png.mjs';
import { clamp, hash2 } from './terrain-engine.mjs';

/* ---------------------------------- 生物群系配色 ---------------------------------- */

const BIOME_COLORS = {
  水域: '#2f6fb4',
  草原: '#79b356',
  森林: '#3c7a38',
  雪原: '#e8eef2',
  沙漠: '#dcc784',
  山地: '#8b8578',
  沼泽: '#6b7d4f',
  灵田: '#9fce6a',
  竹林: '#4f9464',
  雪岭: '#dde6ec',
  丹霞: '#c06a45',
  云杉林: '#2f6b52',
  熔岩地: '#5c4a44',
};

function hexToRgbLocal(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** 未登记的生物群系按名字哈希生成稳定色相 */
function fallbackColor(name) {
  const h = hash2(0, 7, [...String(name)].reduce((a, c) => a + c.codePointAt(0), 0));
  const hue = h * 360;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * clamp(0.55 - 0.35 * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))), 0, 1));
  };
  return [f(0), f(8), f(4)];
}

function legendColors(plan) {
  return plan.biomeLegend.map((b) => BIOME_COLORS[b.id] ? hexToRgbLocal(BIOME_COLORS[b.id]) : fallbackColor(b.id));
}

/* ---------------------------------- 3x5 位图字体 ---------------------------------- */

const FONT3x5 = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7], 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 3, 1, 7],
  4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 1, 1, 1], 8: [7, 5, 7, 5, 7],
  9: [7, 5, 7, 1, 7], '-': [0, 0, 7, 0, 0], '.': [0, 0, 0, 0, 2], ' ': [0, 0, 0, 0, 0],
};

function drawText(pixels, W, H, x, y, text, rgb, alpha = 1) {
  let cx = x;
  for (const chRaw of String(text).toUpperCase()) {
    const ch = FONT3x5[chRaw] ? chRaw : (FONT3x5[chRaw.replace(/[^A-Z0-9]/gi, '')] ? chRaw.replace(/[^A-Z0-9]/gi, '') : ' ');
    const glyph = FONT3x5[ch] || FONT3x5[' '];
    for (let row = 0; row < 5; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col += 1) {
        if (!(bits & (4 >> col))) continue;
        const px = cx + col;
        const py = y + row;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const i = (py * W + px) * 4;
        pixels[i] = pixels[i] * (1 - alpha) + rgb[0] * alpha;
        pixels[i + 1] = pixels[i + 1] * (1 - alpha) + rgb[1] * alpha;
        pixels[i + 2] = pixels[i + 2] * (1 - alpha) + rgb[2] * alpha;
        pixels[i + 3] = 255;
      }
    }
    cx += 4;
  }
  return cx;
}

/* ---------------------------------- 像素工具 ---------------------------------- */

function setPx(pixels, W, H, x, y, rgb, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  pixels[i] = pixels[i] * (1 - alpha) + rgb[0] * alpha;
  pixels[i + 1] = pixels[i + 1] * (1 - alpha) + rgb[1] * alpha;
  pixels[i + 2] = pixels[i + 2] * (1 - alpha) + rgb[2] * alpha;
  pixels[i + 3] = 255;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleColor(c, k) {
  return [clamp(c[0] * k, 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k, 0, 255)];
}

function rasterLine(pixels, W, H, x0, y0, x1, y1, rgb, alpha, width = 1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let s = 0; s <= steps; s += 1) {
    const x = Math.round(x0 + (dx * s) / steps);
    const y = Math.round(y0 + (dy * s) / steps);
    for (let oy = 0; oy < width; oy += 1) {
      for (let ox = 0; ox < width; ox += 1) setPx(pixels, W, H, x + ox, y + oy, rgb, alpha);
    }
  }
}

/* ---------------------------------- 俯瞰图 ---------------------------------- */

/**
 * renderTopDown(plan, options?) → PNG Buffer
 * options.scale：输出放大倍数（默认 1）；options.showLabels：POI/zone 文字标注。
 */
export function renderTopDown(plan, options = {}) {
  const [W, H] = plan.size;
  const scale = Math.max(1, options.scale ?? 1);
  const legendH = 16 + plan.biomeLegend.length * 11;
  const outW = W * scale;
  const outH = H * scale + legendH;
  const pixels = new Uint8ClampedArray(outW * outH * 4);
  const colors = legendColors(plan);
  const hm = plan.heightmap;
  const waterLevel = plan.waterLevel;

  // 底色：生物群系 × 高度明暗 × hillshade
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const h = hm[i];
      const biomeIdx = plan.biomeMap[i];
      let rgb;
      if (h < waterLevel) {
        const depth = clamp((waterLevel - h) / 6, 0, 1);
        rgb = mix(hexToRgbLocal('#4f93c8'), hexToRgbLocal('#173a66'), depth);
      } else {
        rgb = colors[biomeIdx] || [128, 128, 128];
        const shade = clamp(0.72 + (h / plan.heightBudget) * 0.55, 0.55, 1.25);
        rgb = scaleColor(rgb, shade);
        const hl = hm[Math.max(0, y - 1) * W + Math.max(0, x - 1)];
        rgb = scaleColor(rgb, clamp(1 + (hl - h) * 0.06, 0.7, 1.3));
        // 海岸线浅滩
        let coast = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && hm[ny * W + nx] < waterLevel) coast = true;
        }
        if (coast) rgb = mix(rgb, [222, 214, 168], 0.35);
      }
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const pi = ((y * scale + sy) * outW + x * scale + sx) * 4;
          pixels[pi] = rgb[0];
          pixels[pi + 1] = rgb[1];
          pixels[pi + 2] = rgb[2];
          pixels[pi + 3] = 255;
        }
      }
    }
  }

  const P = (x, y, rgb, alpha, w = 1) => {
    for (let oy = 0; oy < w; oy += 1) for (let ox = 0; ox < w; ox += 1) setPx(pixels, outW, outH, x * scale + ox, y * scale + oy, rgb, alpha);
  };
  const L = (x0, y0, x1, y1, rgb, alpha, w = 1) => rasterLine(pixels, outW, outH, x0 * scale, y0 * scale, x1 * scale, y1 * scale, rgb, alpha, w * scale);

  // 路网（土黄）
  for (const p of plan.paths) {
    if (!p.found) continue;
    const pts = p.dense || p.points;
    for (let i = 1; i < pts.length; i += 1) {
      L(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], [181, 138, 90], 0.75, 1);
    }
  }

  // zone 边界（白圈虚线）
  for (const z of plan.zones) {
    const steps = Math.max(48, Math.round(z.radius * 3));
    for (let s = 0; s < steps; s += 1) {
      if (s % 3 === 2) continue; // 虚线
      const a0 = (s / steps) * Math.PI * 2;
      const a1 = ((s + 1) / steps) * Math.PI * 2;
      L(z.center[0] + Math.cos(a0) * z.radius, z.center[1] + Math.sin(a0) * z.radius,
        z.center[0] + Math.cos(a1) * z.radius, z.center[1] + Math.sin(a1) * z.radius, [255, 255, 255], 0.65, 1);
    }
  }

  // POI 标注：菱形标记 + 文字（带描边）
  if (options.showLabels !== false) {
    for (const poi of plan.pois) {
      const [x, y] = poi.pos;
      const rgb = [255, 208, 84];
      P(x, y - 1, rgb, 1, 1);
      P(x - 1, y, rgb, 1, 1);
      P(x + 1, y, rgb, 1, 1);
      P(x, y + 1, rgb, 1, 1);
      P(x, y, [40, 30, 10], 1, 1);
      const label = poi.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'POI';
      drawText(pixels, outW, outH, x * scale - label.length * 2 + 1, (y - 4) * scale, label, [20, 16, 8], 0.85);
      drawText(pixels, outW, outH, x * scale - label.length * 2, (y - 4) * scale - 1, label, [255, 240, 200], 0.95);
    }
  }

  // 图例条
  drawText(pixels, outW, outH, 6, H * scale + 4, `PLAN ${plan.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)} SEED ${plan.seed}`, [30, 30, 30], 0.9);
  plan.biomeLegend.forEach((b, idx) => {
    const ly = H * scale + 12 + idx * 11;
    const rgb = colors[idx];
    for (let oy = 0; oy < 9; oy += 1) {
      for (let ox = 0; ox < 9; ox += 1) setPx(pixels, outW, outH, 6 + ox, ly + oy, rgb, 1);
    }
    drawText(pixels, outW, outH, 18, ly + 2, `${idx} ${String(b.id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)}`, [30, 30, 30], 0.9);
  });

  return encodePng(outW, outH, Buffer.from(pixels.buffer, 0, pixels.length));
}

/* ---------------------------------- 伪 3D 等距图 ---------------------------------- */

/**
 * renderIsometric(plan, options?) → PNG Buffer
 * options.cellSize：每格像素步长（默认 2）；options.zStep：每格高度像素系数。
 */
export function renderIsometric(plan, options = {}) {
  const [W, H] = plan.size;
  const step = Math.max(1, options.cellSize ?? 2);
  const zStep = options.zStep ?? 0.45;
  const outW = Math.ceil((W + H) * step) + 8;
  const outH = Math.ceil(((W + H) * step) / 2 + plan.heightBudget * zStep) + 24;
  const pixels = new Uint8ClampedArray(outW * outH * 4);
  const colors = legendColors(plan);
  const hm = plan.heightmap;
  const waterLevel = plan.waterLevel;
  const ox = H * step + 4;
  const oy = 16 + 4;

  // painter's algorithm：按 (x+y) 对角序、行序绘制（后画者在前）
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const h = hm[i];
      const isWater = h < waterLevel;
      const colH = isWater ? waterLevel : h;
      const sx = (x - y) * step + ox;
      const sy = ((x + y) * step) / 2 - colH * zStep + oy;
      const biomeIdx = plan.biomeMap[i];
      let top;
      if (isWater) {
        const depth = clamp((waterLevel - h) / 6, 0, 1);
        top = mix(hexToRgbLocal('#4f93c8'), hexToRgbLocal('#173a66'), depth);
      } else {
        top = scaleColor(colors[biomeIdx] || [128, 128, 128], clamp(0.8 + (h / plan.heightBudget) * 0.45, 0.7, 1.2));
      }
      // 顶面菱形
      for (let dy = 0; dy < step; dy += 1) {
        const half = dy <= step / 2 ? dy + 1 : step - dy;
        for (let dx = -half + 1; dx <= half - 1; dx += 1) {
          setPx(pixels, outW, outH, Math.round(sx + dx), Math.round(sy + dy), top, 1);
        }
      }
      // 侧面：与后侧/左侧邻格的高度差决定可见壁面
      const left = hm[y * W + Math.max(0, x - 1)];
      const up = hm[Math.max(0, y - 1) * W + x];
      const sideFront = Math.max(0, colH - Math.max(up, waterLevel));
      const sideRight = Math.max(0, colH - Math.max(left, waterLevel));
      const drawSide = (height, rgb) => {
        for (let k = 0; k < height * zStep; k += 1) {
          for (let dx = -step / 2 + 1; dx <= step / 2 - 1; dx += 1) {
            setPx(pixels, outW, outH, Math.round(sx + dx), Math.round(sy + step + k), rgb, 1);
          }
        }
      };
      const baseDark = isWater ? mix(top, [10, 24, 48], 0.4) : scaleColor(colors[biomeIdx] || [128, 128, 128], 0.55);
      if (sideFront > 0.5) drawSide(Math.min(sideFront, 12), baseDark);
      if (sideRight > 0.5) {
        const rgb2 = isWater ? mix(top, [10, 24, 48], 0.25) : scaleColor(colors[biomeIdx] || [128, 128, 128], 0.72);
        for (let k = 0; k < Math.min(sideRight, 12) * zStep; k += 1) {
          setPx(pixels, outW, outH, Math.round(sx + step / 2), Math.round(sy + step / 2 + k), rgb2, 1);
          setPx(pixels, outW, outH, Math.round(sx + step / 2) + 1, Math.round(sy + step / 2 + k), rgb2, 1);
        }
      }
    }
  }

  // POI 标记（金色立柱）
  for (const poi of plan.pois) {
    const [x, y] = poi.pos;
    const h = Math.max(hm[Math.round(y) * W + Math.round(x)] ?? 0, waterLevel);
    const sx = (x - y) * step + ox;
    const sy = ((x + y) * step) / 2 - h * zStep + oy;
    for (let k = 0; k < 7; k += 1) {
      setPx(pixels, outW, outH, Math.round(sx), Math.round(sy - k), [255, 208, 84], 1);
    }
    setPx(pixels, outW, outH, Math.round(sx), Math.round(sy - 8), [255, 240, 180], 1);
  }

  drawText(pixels, outW, outH, 6, 4, `ISO ${plan.id.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)} SEED ${plan.seed}`, [30, 30, 30], 0.9);
  return encodePng(outW, outH, Buffer.from(pixels.buffer, 0, pixels.length));
}
