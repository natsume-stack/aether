/**
 * TerrainEngine/0.1 — 大尺度、玩法驱动、种子化的地形纯计算核心。
 *
 * 只消费 game-design-brain 输出的 GDD 契约，零 HTTP / 零 npm 依赖。
 * 产出 TerrainPlan：heightmap / biomeMap / rivers / paths / scatter /
 * zoneRects / metrics，交给 terrain-render.mjs 与 terrain-executor.mjs 消费。
 *
 * 设计原则：
 * - 无固定中心：大陆重心由 GDD zones 分布或种子决定；
 * - 一切区域雕刻带 falloff 过渡，禁止矩形硬切；
 * - metrics 不达标自动换 seed 扰动重试（最多 3 轮）。
 */

const PLAN_VERSION = 'TerrainPlan/0.1';

/* ---------------------------------- 基础数学 ---------------------------------- */

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32 — 种子化 PRNG */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------- 值噪声 ---------------------------------- */

/** 2D 整数格点哈希 → [0,1) */
export function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 平滑值噪声（single octave） */
export function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);
  return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v00 - v10 - v01 + v11) * sx * sy;
}

/** 分形布朗运动：多倍频叠加，倍频间旋转降低轴向伪影 */
export function fbm(x, y, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let px = x;
  let py = y;
  const cos = Math.cos(0.63);
  const sin = Math.sin(0.63);
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise(px, py, (seed + o * 1013) | 0);
    norm += amp;
    const rx = px * cos - py * sin;
    const ry = px * sin + py * cos;
    px = rx * lacunarity + 17.17;
    py = ry * lacunarity + 9.91;
    amp *= gain;
  }
  return sum / norm;
}

/** domain-warp：两条低频 fbm 扭曲输入坐标，消除直线感 */
function warp2(x, y, seed, amount = 1.15) {
  const wx = fbm(x * 0.45 + 5.2, y * 0.45 + 1.3, (seed + 7717) | 0, 3) - 0.5;
  const wy = fbm(x * 0.45 + 9.7, y * 0.45 + 4.4, (seed + 9973) | 0, 3) - 0.5;
  return [x + wx * amount, y + wy * amount];
}

/* ---------------------------------- GDD 归一化 ---------------------------------- */

const ROLE_RADIUS_SCALE = { boss: 0.09, arena: 0.11, spawn: 0.07, shop: 0.05, village: 0.06 };
const ROLE_TARGET = { boss: 18, arena: 4, spawn: 10, shop: 9, village: 8 };
const DEFAULT_BIOME_NAMES = ['草原', '森林', '沙漠', '山地'];

export function normalizeGdd(gdd) {
  const out = JSON.parse(JSON.stringify(gdd ?? {}));
  out.version = out.version || 'GDD/0.1';
  out.id = out.id || 'terrain-unnamed';
  out.mapSize = Array.isArray(out.mapSize) && out.mapSize.length === 2 ? out.mapSize.map((v) => Math.max(32, v | 0)) : [256, 256];
  out.heightBudget = clamp((out.heightBudget ?? 64) | 0, 16, 255);
  out.seed = (out.seed ?? 20261025) >>> 0;
  const terrain = (out.terrain = out.terrain || {});
  terrain.continentProfile = terrain.continentProfile || 'continent';
  terrain.water = terrain.water || {};
  terrain.water.level = clamp(Math.round(terrain.water.level ?? Math.round(out.heightBudget * 0.12)), 2, Math.floor(out.heightBudget * 0.4));
  terrain.water.bodies = Math.max(0, (terrain.water.bodies ?? 1) | 0);
  terrain.rivers = Math.max(0, (terrain.rivers ?? gdd?.rivers ?? 2) | 0);
  if (!Array.isArray(terrain.biomePalette) || terrain.biomePalette.length === 0) {
    terrain.biomePalette = DEFAULT_BIOME_NAMES.map((biome) => ({ biome, density: 0.25 }));
  }
  terrain.biomePalette = terrain.biomePalette
    .filter((b) => b && b.biome)
    .map((b) => ({ biome: String(b.biome), blocks: b.blocks || {}, density: clamp(Number(b.density ?? 0.3), 0, 1) }));
  if (terrain.biomePalette.length === 0) terrain.biomePalette = [{ biome: '草原', density: 0.3 }];
  if (!Array.isArray(terrain.landmarkSilhouettes)) terrain.landmarkSilhouettes = [];
  out.zones = Array.isArray(out.zones) ? out.zones.filter((z) => z && z.id) : [];
  out.poiGraph = out.poiGraph || {};
  out.poiGraph.nodes = Array.isArray(out.poiGraph.nodes) ? out.poiGraph.nodes : [];
  out.poiGraph.edges = Array.isArray(out.poiGraph.edges) ? out.poiGraph.edges : [];
  return out;
}

/** 解析 elevationHint，如 "plateau-12" / "arena-6" → 相对水面高度（方块数） */
function parseElevationHint(hint, role) {
  const m = /(?:plateau|arena|boss|height)[-_]?(-?\d+)/i.exec(String(hint ?? ''));
  if (m) return Number(m[1]);
  return ROLE_TARGET[role] ?? 8;
}

/* ------------------------------ 玩法区几何规划 ------------------------------ */

/** 保证每个 zone 都有 center/radius：缺失时按环状分布 + 种子抖动规划（无固定中心） */
function planZoneGeometry(gdd, rng) {
  const [W, H] = gdd.mapSize;
  const maxDim = Math.max(W, H);
  const zones = gdd.zones;
  for (const z of zones) {
    if (Array.isArray(z.center) && z.center.length >= 2 && (z.center[0] !== 0 || z.center[1] !== 0)) {
      z._c = [clamp(z.center[0], 2, W - 3), clamp(z.center[1], 2, H - 3)];
    }
    z._r = clamp(z.radius ?? maxDim * (ROLE_RADIUS_SCALE[z.role] ?? 0.06), 10, Math.floor(maxDim * 0.2));
  }
  const missing = zones.filter((z) => !z._c);
  const baseAngle = rng() * Math.PI * 2;
  const placed = zones.filter((z) => z._c);
  for (let i = 0; i < missing.length; i += 1) {
    const z = missing[i];
    let chosen = null;
    for (let t = 0; t < 60 && !chosen; t += 1) {
      const ang = baseAngle + ((i + t * 0.137) / Math.max(1, missing.length)) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const rad = maxDim * (0.26 + rng() * 0.16);
      const cx = clamp(W / 2 + Math.cos(ang) * rad * (W / maxDim), z._r + 4, W - z._r - 5);
      const cy = clamp(H / 2 + Math.sin(ang) * rad * (H / maxDim), z._r + 4, H - z._r - 5);
      const ok = placed.every((p) => Math.hypot(p._c[0] - cx, p._c[1] - cy) > (p._r + z._r) * 1.35);
      if (ok) chosen = [cx, cy];
    }
    if (!chosen) {
      const ang = baseAngle + i * 2.39996; // 黄金角兜底
      chosen = [clamp(W / 2 + Math.cos(ang) * maxDim * 0.3, 4, W - 5), clamp(H / 2 + Math.sin(ang) * maxDim * 0.3, 4, H - 5)];
    }
    z._c = chosen;
    placed.push(z);
  }
  return zones;
}

/* ---------------------------------- 大陆掩膜 ---------------------------------- */

/** 依据 profile 与 zone 分布生成大陆 lobes（重心随 GDD/种子漂移） */
function buildLobes(gdd, zones, rng) {
  const [W, H] = gdd.mapSize;
  const maxDim = Math.max(W, H);
  const profile = gdd.terrain.continentProfile;
  const lobes = [];
  const push = (x, y, r) => lobes.push({ x, y, r });
  if (profile === 'archipelago') {
    for (const z of zones) push(z._c[0], z._c[1], Math.max(z._r * 3.4, maxDim * 0.2));
    const extra = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < extra; i += 1) {
      push(rng() * W, rng() * H, maxDim * (0.09 + rng() * 0.08));
    }
  } else if (profile === 'island-ring') {
    push(W / 2 + (rng() - 0.5) * maxDim * 0.08, H / 2 + (rng() - 0.5) * maxDim * 0.08, maxDim * 0.34);
    const n = 6 + Math.floor(rng() * 3);
    const ringR = maxDim * (0.35 + rng() * 0.05);
    const a0 = rng() * Math.PI * 2;
    for (let i = 0; i < n; i += 1) {
      const a = a0 + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.3;
      push(clamp(W / 2 + Math.cos(a) * ringR, 10, W - 11), clamp(H / 2 + Math.sin(a) * ringR, 10, H - 11), maxDim * (0.14 + rng() * 0.04));
    }
  } else if (profile === 'canyon') {
    push(W / 2 + (rng() - 0.5) * maxDim * 0.06, H / 2 + (rng() - 0.5) * maxDim * 0.06, maxDim * 0.62);
  } else {
    // continent：单一主大陆 + 少量卫星小岛
    push(W / 2 + (rng() - 0.5) * maxDim * 0.12, H / 2 + (rng() - 0.5) * maxDim * 0.12, maxDim * (0.48 + rng() * 0.06));
    for (let i = 0; i < 2 + Math.floor(rng() * 2); i += 1) {
      push(rng() * W, rng() * H, maxDim * (0.07 + rng() * 0.06));
    }
    // 保证 zone 落在陆地上：zone 附近补一个小 lobe
    for (const z of zones) {
      const far = lobes.every((l) => Math.hypot(l.x - z._c[0], l.y - z._c[1]) > l.r * 0.85);
      if (far) push(z._c[0], z._c[1], Math.max(z._r * 2.4, maxDim * 0.1));
    }
  }
  return lobes;
}

/**
 * 大陆掩膜主循环：返回 field（未阈值化）。
 * zone 中心加高斯预抬升，保证出生区在陆地内。
 */
function continentField(gdd, zones, lobes, seed) {
  const [W, H] = gdd.mapSize;
  const scale = 3.1 / Math.max(W, H); // 基准频率：整图约 3 个噪声周期
  const field = new Float32Array(W * H);
  const eCut = { archipelago: 0.27, continent: 0.15, 'island-ring': 0.2, canyon: 0.15 }[gdd.terrain.continentProfile] ?? 0.2;
  const boost = new Float32Array(W * H);
  for (const z of zones) {
    const gr = z._r * 1.7;
    const x0 = Math.max(0, Math.floor(z._c[0] - gr));
    const x1 = Math.min(W - 1, Math.ceil(z._c[0] + gr));
    const y0 = Math.max(0, Math.floor(z._c[1] - gr));
    const y1 = Math.min(H - 1, Math.ceil(z._c[1] + gr));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x - z._c[0], y - z._c[1]) / gr;
        if (d < 1) {
          const i = y * W + x;
          boost[i] = Math.max(boost[i], 0.55 * Math.exp(-d * d * 2.6));
        }
      }
    }
  }
  const coastSeed = (seed + 313) | 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const [wx, wy] = warp2(x * scale, y * scale, seed);
      let lobe = 0;
      for (const l of lobes) {
        const v = 1 - Math.hypot(x - l.x, y - l.y) / l.r;
        if (v > lobe) lobe = v;
      }
      const coast = fbm(x * scale * 2.2 + 11, y * scale * 2.2 + 7, coastSeed, 3) - 0.5;
      field[i] = lobe + coast * 0.38 + boost[i] - eCut;
    }
  }
  return field;
}

/* ---------------------------------- 生成主体 ---------------------------------- */

function generateOnce(gdd, seed, attempt) {
  const [W, H] = gdd.mapSize;
  const budget = gdd.heightBudget;
  const waterLevel = gdd.terrain.water.level;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const zones = planZoneGeometry(gdd, rng);
  const lobes = buildLobes(gdd, zones, rng);
  const field = continentField(gdd, zones, lobes, seed);

  const heightmap = new Float32Array(W * H);
  const reliefSeed = (seed + 4001) | 0;
  const scale = 3.1 / Math.max(W, H);
  const seaFloor = waterLevel - Math.max(4, budget * 0.09);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const [rx, ry] = warp2(x * scale + 3.7, y * scale + 8.1, reliefSeed);
      const relief = fbm(rx, ry, reliefSeed, 5);
      const h01 = Math.min(1, Math.max(0, field[i]) * (0.75 + 0.45 * relief));
      heightmap[i] = lerp(seaFloor, budget * 0.96, Math.pow(h01, 1.1));
    }
  }

  /* ---- canyon 廓形：蜿蜒深切谷 ---- */
  if (gdd.terrain.continentProfile === 'canyon') {
    const cs = (seed + 8111) | 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const v = fbm(x * scale * 1.6 + 21, y * scale * 1.6 + 33, cs, 3);
        const band = 1 - smoothstep(0.015, 0.085, Math.abs(v - 0.5));
        const land = clamp((heightmap[i] - waterLevel) / 6, 0, 1);
        heightmap[i] -= band * 16 * land;
      }
    }
  }

  /* ---- 玩法区雕刻：role → 操作选型，全部带 falloff ---- */
  const zoneCoreMask = new Uint8Array(W * H);
  const applyPlateau = (cx, cy, radius, target, coreScale = 0.75) => {
    const core = radius * coreScale;
    const outer = radius * 1.28;
    const x0 = Math.max(0, Math.floor(cx - outer));
    const x1 = Math.min(W - 1, Math.ceil(cx + outer));
    const y0 = Math.max(0, Math.floor(cy - outer));
    const y1 = Math.min(H - 1, Math.ceil(cy + outer));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > outer) continue;
        const i = y * W + x;
        const w = 1 - smoothstep(core, outer, d);
        if (w <= 0) continue;
        // 强制收敛到 target（可抬可降），核心绝对平整，边缘 falloff 过渡
        heightmap[i] = lerp(heightmap[i], target, w);
        if (d < core * 0.92) zoneCoreMask[i] = 1;
      }
    }
  };
  for (const z of zones) {
    const hint = parseElevationHint(z.elevationHint, z.role);
    const target = clamp(waterLevel + hint, waterLevel + 3, budget - 3);
    z._target = target;
    if (z.role === 'arena') {
      // 碗状：平底 + 高斯环形护坡（不做平台强制，保持环沿自然隆起）
      applyPlateau(z._c[0], z._c[1], z._r * 0.78, target, 0.7);
      const rimR = z._r;
      const rimW = Math.max(2, z._r * 0.16);
      const outer = rimR + rimW * 2;
      for (let y = Math.max(0, Math.floor(z._c[1] - outer)) | 0; y <= Math.min(H - 1, Math.ceil(z._c[1] + outer)); y += 1) {
        for (let x = Math.max(0, Math.floor(z._c[0] - outer)) | 0; x <= Math.min(W - 1, Math.ceil(z._c[0] + outer)); x += 1) {
          const d = Math.hypot(x - z._c[0], y - z._c[1]);
          const g = Math.exp(-((d - rimR) ** 2) / (2 * rimW * rimW));
          if (g < 0.02) continue;
          heightmap[y * W + x] += 8 * g; // 叠加式护坡，高处也自然隆起
        }
      }
    } else if (z.role === 'boss') {
      applyPlateau(z._c[0], z._c[1], z._r, target, 0.8); // 更陡但仍是平滑 falloff
    } else {
      applyPlateau(z._c[0], z._c[1], z._r, target);
    }
  }

  /* ---- 全局轻平滑（zone 核心除外），消硬切 ---- */
  const blurred = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      if (zoneCoreMask[i]) {
        blurred[i] = heightmap[i];
        continue;
      }
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = clamp(y + dy, 0, H - 1);
        for (let dx = -1; dx <= 1; dx += 1) {
          sum += heightmap[yy * W + clamp(x + dx, 0, W - 1)];
          n += 1;
        }
      }
      blurred[i] = sum / n;
    }
  }
  heightmap.set(blurred);
  for (const z of zones) applyPlateau(z._c[0], z._c[1], z._r, z._target); // 复原核心平整

  /* ---- 地标轮廓：参数化 heightfield patch ---- */
  const landmarks = [];
  for (const name of gdd.terrain.landmarkSilhouettes) {
    const spot = pickLandmarkSpot(heightmap, W, H, zones, waterLevel, rng, name);
    if (!spot) continue;
    const kind = /火山|volcano/i.test(name) ? 'volcano' : /塔|tower|spire/i.test(name) ? 'tower' : /浮岛|float/i.test(name) ? 'float-island' : 'peak';
    stampLandmark(heightmap, W, H, spot[0], spot[1], kind, Math.max(W, H), rng, waterLevel);
    landmarks.push({ id: `lm_${landmarks.length + 1}`, name, kind, pos: [Math.round(spot[0]), Math.round(spot[1]), Math.round(heightmap[Math.round(spot[1]) * W + Math.round(spot[0])])] });
  }

  /* ---- 内陆湖（water.bodies）---- */
  const lakes = [];
  const waterMask = new Uint8Array(W * H); // 1=河流/湖体（散布回避 + 桥梁判定）
  for (let b = 0; b < gdd.terrain.water.bodies; b += 1) {
    const spot = pickLakeSpot(heightmap, W, H, waterLevel, zones, rng);
    if (!spot) break;
    const r = 5 + rng() * Math.min(9, Math.max(W, H) * 0.03);
    stampLake(heightmap, W, H, waterMask, spot[0], spot[1], r, waterLevel);
    lakes.push({ id: `lake_${b + 1}`, pos: [Math.round(spot[0]), Math.round(spot[1])], radius: Math.round(r) });
  }

  /* ---- 水文：梯度下降追踪河流 ---- */
  // 尺寸缩放：256² 等效面积系数——大地图水系/湖/次级地标必须随面积增长，
  // 否则构成密度被稀释（MapBench terrain 柱会扣）。
  const areaFactor = clamp(Math.sqrt((W * H) / (256 * 256)), 1, 2.5);
  const riverCount = gdd.terrain.rivers + (areaFactor >= 1.5 ? 1 : 0) + (areaFactor >= 2.2 ? 1 : 0);
  const rivers = traceRivers(heightmap, W, H, waterMask, zoneCoreMask, waterLevel, riverCount, rng, (seed + 5501) | 0);
  if (areaFactor >= 1.8 && gdd.terrain.water.bodies > 0) {
    const spot = pickLakeSpot(heightmap, W, H, waterLevel, zones, rng);
    if (spot) {
      stampLake(heightmap, W, H, waterMask, spot[0], spot[1], 6 + rng() * Math.min(10, Math.max(W, H) * 0.03), waterLevel);
      lakes.push({ id: `lake_${lakes.length + 1}`, pos: [Math.round(spot[0]), Math.round(spot[1])], radius: 8, scaled: true });
    }
  }
  if (areaFactor >= 1.5 && landmarks.length >= 1) {
    const spot = pickLandmarkSpot(heightmap, W, H, zones, waterLevel, rng, '次峰');
    if (spot) {
      stampLandmark(heightmap, W, H, spot[0], spot[1], 'peak', Math.max(W, H), rng, waterLevel);
      landmarks.push({ id: `lm_${landmarks.length + 1}`, name: '次峰', kind: 'peak', scaled: true, pos: [Math.round(spot[0]), Math.round(spot[1]), Math.round(heightmap[Math.round(spot[1]) * W + Math.round(spot[0])])] });
    }
  }

  /* ---- 地貌精修（ThermalErosion-lite + 水线台地）： cliffs→碎石坡、硬岸→缓滩 ---- */
  {
    const talus = 1.8;
    for (let iter = 0; iter < 2; iter += 1) {
      const delta = new Float32Array(W * H);
      for (let y = 1; y < H - 1; y += 1) {
        for (let x = 1; x < W - 1; x += 1) {
          const i = y * W + x;
          if (zoneCoreMask[i]) continue;
          const h = heightmap[i];
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = (y + dy) * W + (x + dx);
            const diff = h - heightmap[j];
            if (diff > talus) {
              const move = (diff - talus) * 0.25;
              delta[i] -= move;
              delta[j] += move;
            }
          }
        }
      }
      for (let i = 0; i < W * H; i += 1) heightmap[i] += delta[i];
    }
    // 水线台地：临水陆地压向 waterLevel+0.6，形成可读的滩涂过渡带
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const i = y * W + x;
        if (zoneCoreMask[i]) continue;
        const h = heightmap[i];
        if (h <= waterLevel || h > waterLevel + 1.4) continue;
        const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => heightmap[(y + dy) * W + (x + dx)] <= waterLevel);
        if (nearWater) heightmap[i] = waterLevel + 0.6 + (h - waterLevel) * 0.3;
      }
    }
  }

  /* ---- 路网：代价场 A* ---- */
  const pois = resolvePois(gdd, zones, heightmap, W);
  const paths = buildPaths(gdd, pois, heightmap, W, H, waterMask, zoneCoreMask, waterLevel);

  // 路廊两侧削平肩墙，保证可行走
  for (const p of paths) {
    for (const [px, py] of p.dense) {
      const ph = heightmap[py * W + px];
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = py + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = px + dx;
          if (xx < 0 || xx >= W) continue;
          const i = yy * W + xx;
          if (heightmap[i] > ph + 1.6) heightmap[i] = ph + 1.6;
        }
      }
    }
  }
  for (const z of zones) applyPlateau(z._c[0], z._c[1], z._r, z._target);

  /* ---- 生物群系图 ---- */
  const { biomeMap, legend, anchors } = buildBiomeMap(gdd, heightmap, W, H, waterLevel, seed);

  /* ---- 散布：抖动网格（blue-noise 风格）---- */
  const pathDenseMask = new Uint8Array(W * H);
  for (const p of paths) for (const [px, py] of p.dense) pathDenseMask[py * W + px] = 1;
  const scatter = buildScatter(gdd, heightmap, biomeMap, legend, W, H, waterLevel, waterMask, pathDenseMask, zoneCoreMask, rng);

  /* ---- 输出 ---- */
  const zoneRects = zones.map((z) => ({
    id: z.id,
    role: z.role || 'generic',
    name: z.name || z.id,
    x: Math.round(clamp(z._c[0] - z._r * 1.3, 0, W - 1)),
    y: Math.round(clamp(z._c[1] - z._r * 1.3, 0, H - 1)),
    w: Math.round(clamp(z._r * 2.6, 4, W)),
    h: Math.round(clamp(z._r * 2.6, 4, H)),
    target: z._target,
  }));

  const plan = {
    version: PLAN_VERSION,
    id: gdd.id,
    seed,
    attempt,
    size: [W, H],
    heightBudget: budget,
    waterLevel,
    heightmap,
    biomeMap,
    biomeLegend: legend,
    zones: zones.map((z) => ({ id: z.id, role: z.role || 'generic', center: [Math.round(z._c[0]), Math.round(z._c[1])], radius: z._r, target: z._target })),
    zoneRects,
    pois,
    rivers,
    lakes,
    paths,
    landmarks,
    scatter,
  };
  plan.metrics = computeMetrics(plan, gdd, anchors);
  return plan;
}

/* ---------------------------------- 地标/湖泊 ---------------------------------- */

function pickLandmarkSpot(heightmap, W, H, zones, waterLevel, rng, name) {
  // 取远离 spawn/shop 核心、且地势较高的点；火山/主峰允许靠近 boss/arena
  const softZones = zones.filter((z) => ['spawn', 'shop', 'village'].includes(z.role));
  let best = null;
  let bestScore = -Infinity;
  for (let t = 0; t < 400; t += 1) {
    const x = 8 + rng() * (W - 16);
    const y = 8 + rng() * (H - 16);
    const h = heightmap[Math.round(y) * W + Math.round(x)];
    if (h < waterLevel + 3) continue;
    let dMin = Infinity;
    for (const z of softZones) dMin = Math.min(dMin, Math.hypot(x - z._c[0], y - z._c[1]) - z._r);
    if (dMin < 6) continue;
    const score = h * 0.1 + dMin * 0.5 + rng() * 4;
    if (score > bestScore) {
      bestScore = score;
      best = [x, y];
    }
  }
  if (!best && zones.length === 0) best = [W / 2, H / 2];
  return best;
}

function stampLandmark(heightmap, W, H, cx, cy, kind, maxDim, rng, waterLevel) {
  const base = heightmap[Math.round(cy) * W + Math.round(cx)];
  if (kind === 'volcano') {
    const r = maxDim * (0.07 + rng() * 0.03);
    const peak = Math.min(63, base + 20 + rng() * 8);
    stampCone(heightmap, W, H, cx, cy, r, peak, 0.25, 9);
  } else if (kind === 'tower') {
    const r = maxDim * 0.035;
    const peak = Math.min(63, base + 26);
    stampTerraced(heightmap, W, H, cx, cy, r, peak, 4);
  } else if (kind === 'float-island') {
    const r = maxDim * 0.05;
    const top = Math.min(63, base + 22);
    stampMesa(heightmap, W, H, cx, cy, r, top);
  } else {
    const r = maxDim * (0.09 + rng() * 0.05);
    stampCone(heightmap, W, H, cx, cy, r, Math.min(63, Math.max(base + 22, waterLevel + 46)), 0, 0);
  }
}

/** 圆锥（火山）：peakH 为主峰高，craterFrac 内半径挖坑 craterDepth */
function stampCone(heightmap, W, H, cx, cy, r, peak, craterFrac, craterDepth) {
  const outer = r * 1.25;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const x1 = Math.min(W - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const y1 = Math.min(H - 1, Math.ceil(cy + outer));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > outer) continue;
      const i = y * W + x;
      let h = peak * Math.pow(Math.max(0, 1 - d / r), 1.55) + heightmap[i] * smoothstep(r * 0.8, outer, d);
      if (craterDepth > 0 && d < r * craterFrac) {
        h -= craterDepth * (1 - d / (r * craterFrac));
      }
      const w = 1 - smoothstep(r * 0.85, outer, d);
      heightmap[i] = Math.max(heightmap[i], lerp(heightmap[i], h, w));
    }
  }
}

/** 台地塔：逐层量化 */
function stampTerraced(heightmap, W, H, cx, cy, r, peak, step) {
  const outer = r * 1.35;
  for (let y = Math.max(0, cy - outer) | 0; y <= Math.min(H - 1, cy + outer); y += 1) {
    for (let x = Math.max(0, cx - outer) | 0; x <= Math.min(W - 1, cx + outer); x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > outer) continue;
      const i = y * W + x;
      const t = Math.max(0, 1 - d / r);
      let h = Math.floor((heightmap[i] + t * (peak - heightmap[i])) / step) * step;
      const w = 1 - smoothstep(r * 0.9, outer, d);
      heightmap[i] = Math.max(heightmap[i], lerp(heightmap[i], h, w));
    }
  }
}

/** 平顶mesa（浮岛的 heightfield 近似） */
function stampMesa(heightmap, W, H, cx, cy, r, top) {
  const outer = r * 1.3;
  for (let y = Math.max(0, cy - outer) | 0; y <= Math.min(H - 1, cy + outer); y += 1) {
    for (let x = Math.max(0, cx - outer) | 0; x <= Math.min(W - 1, cx + outer); x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > outer) continue;
      const i = y * W + x;
      const w = 1 - smoothstep(r * 0.55, outer, d);
      heightmap[i] = Math.max(heightmap[i], lerp(heightmap[i], top, w));
    }
  }
}

function pickLakeSpot(heightmap, W, H, waterLevel, zones, rng) {
  let best = null;
  let bestScore = -Infinity;
  for (let t = 0; t < 300; t += 1) {
    const x = 10 + Math.floor(rng() * (W - 20));
    const y = 10 + Math.floor(rng() * (H - 20));
    const h = heightmap[y * W + x];
    if (h < waterLevel + 2 || h > waterLevel + 18) continue;
    const nearZone = zones.some((z) => Math.hypot(x - z._c[0], y - z._c[1]) < z._r * 1.4);
    if (nearZone) continue;
    const score = rng() * 10 - Math.abs(h - (waterLevel + 6)) * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = [x, y];
    }
  }
  return best;
}

function stampLake(heightmap, W, H, waterMask, cx, cy, r, waterLevel) {
  const x0 = Math.max(0, Math.floor(cx - r * 1.2));
  const x1 = Math.min(W - 1, Math.ceil(cx + r * 1.2));
  const y0 = Math.max(0, Math.floor(cy - r * 1.2));
  const y1 = Math.min(H - 1, Math.ceil(cy + r * 1.2));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const i = y * W + x;
      const surface = waterLevel;
      const w = 1 - smoothstep(r * 0.6, r, d);
      heightmap[i] = Math.min(heightmap[i], lerp(heightmap[i], surface - 1.5, w));
      if (heightmap[i] < waterLevel) waterMask[i] = 1;
    }
  }
}

/* ---------------------------------- 河流 ---------------------------------- */

function traceRivers(heightmap, W, H, waterMask, zoneCoreMask, waterLevel, count, rng, noiseSeed) {
  const rivers = [];
  const candidates = [];
  const hi = waterLevel + (63 - waterLevel) * 0.5;
  for (let y = 6; y < H - 6; y += 5) {
    for (let x = 6; x < W - 6; x += 5) {
      const jx = x + ((rng() * 5) | 0);
      const jy = y + ((rng() * 5) | 0);
      if (jx >= W - 4 || jy >= H - 4) continue;
      const i = jy * W + jx;
      if (heightmap[i] > hi && !zoneCoreMask[i]) candidates.push([jx, jy, heightmap[i]]);
    }
  }
  candidates.sort((a, b) => b[2] - a[2]);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) > Math.max(W, H) * 0.12)) chosen.push(c);
  }
  for (let r = 0; r < chosen.length; r += 1) {
    const [sx, sy] = chosen[r];
    const pts = [];
    const visited = new Set();
    let cx = sx;
    let cy = sy;
    let madeLake = false;
    for (let step = 0; step < W * 2; step += 1) {
      const ci = cy * W + cx;
      visited.add(ci);
      pts.push([cx, cy]);
      if (heightmap[ci] <= waterLevel + 0.2 || waterMask[ci]) break;
      let bestN = null;
      let bestKey = Infinity;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
          const ni = ny * W + nx;
          if (visited.has(ni)) continue;
          const key = heightmap[ni] + (valueNoise(nx * 0.11, ny * 0.11, noiseSeed) - 0.5) * 1.4 + (waterMask[ni] ? -8 : 0);
          if (key < bestKey) {
            bestKey = key;
            bestN = [nx, ny, ni];
          }
        }
      }
      if (!bestN || heightmap[bestN[2]] > heightmap[ci] + 0.02) {
        // 局部洼地 → 憩成小塘
        stampLake(heightmap, W, H, waterMask, cx, cy, 4 + rng() * 4, waterLevel);
        madeLake = true;
        break;
      }
      cx = bestN[0];
      cy = bestN[1];
    }
    if (pts.length < 6) continue;
    // 河道下切：宽度随流量（沿程）增长
    const len = pts.length;
    let maxW = 1;
    for (let i = 0; i < len; i += 1) {
      const [px, py] = pts[i];
      const w = 1 + Math.min(3, Math.floor((i / len) * 4.2));
      maxW = Math.max(maxW, w);
      const bed = waterLevel - 0.7;
      for (let dy = -w; dy <= w; dy += 1) {
        const yy = py + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -w; dx <= w; dx += 1) {
          const xx = px + dx;
          if (xx < 0 || xx >= W) continue;
          const d = Math.hypot(dx, dy);
          if (d > w + 0.4) continue;
          const idx = yy * W + xx;
          heightmap[idx] = Math.min(heightmap[idx], bed + d * 0.85);
          if (d < w * 0.8) waterMask[idx] = 1;
        }
      }
    }
    const sampled = pts.filter((_, i) => i % 3 === 0 || i === len - 1);
    rivers.push({
      id: `river_${r + 1}`,
      width: maxW,
      points: sampled.map(([px, py]) => [px, py, Math.round(Math.max(1, heightmap[py * W + px]))]),
      mouth: madeLake ? 'lake' : 'sea',
    });
  }
  return rivers;
}

/* ---------------------------------- POI 与 A* 路网 ---------------------------------- */

function resolvePois(gdd, zones, heightmap, W) {
  const byZone = new Map(zones.map((z) => [z.id, z]));
  return gdd.poiGraph.nodes.map((n, idx) => {
    const z = byZone.get(n.zone);
    let x;
    let y;
    if (Array.isArray(n.pos) && n.pos.length >= 2 && (n.pos[0] !== 0 || n.pos[1] !== 0) && n.pos[0] < W && n.pos[1] < W) {
      [x, y] = n.pos;
    } else if (z) {
      x = z._c[0];
      y = z._c[1];
    } else {
      x = 0;
      y = 0;
    }
    const zz = z ? z._target : Math.round(heightmap[Math.round(y) * W + Math.round(x)] || 8);
    return { id: n.id || `poi_${idx}`, zone: n.zone || null, kind: n.kind || 'point', pos: [Math.round(x), Math.round(y), zz] };
  });
}

class MinHeap {
  constructor() {
    this.a = [];
  }

  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function astar(cost, W, H, start, goal) {
  const total = W * H;
  // g 必须用 Float64：Float32 在长路径大 g 值下精度不足，
  // 会触发海量微小松弛使堆爆炸（512 图实测 49s → Float64 后 <1s）
  const g = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const heap = new MinHeap();
  const si = start[1] * W + start[0];
  const gi = goal[1] * W + goal[0];
  g[si] = 0;
  heap.push([0, si, 0]);
  const SQRT2 = Math.SQRT2;
  while (heap.a.length) {
    const [, cur, gCur] = heap.pop();
    if (gCur > g[cur] + 1e-6) continue; // 陈旧堆项
    if (cur === gi) break;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = cy + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx;
        if (nx < 0 || nx >= W || (!dx && !dy)) continue;
        const ni = ny * W + nx;
        const dh = cost.height[ni] - cost.height[cur];
        const climb = dh > 0 ? dh * 7 : -dh * 1.5;
        const step = (dx && dy ? SQRT2 : 1) * (1 + cost.base[ni]) + climb;
        const ng = g[cur] + step;
        if (ng < g[ni] - 1e-6) {
          g[ni] = ng;
          parent[ni] = cur;
          const hEst = Math.hypot(nx - goal[0], ny - goal[1]);
          heap.push([ng + hEst * 1.05, ni, ng]);
        }
      }
    }
  }
  if (parent[gi] < 0 && gi !== si) return null;
  const dense = [];
  let cur = gi;
  while (cur >= 0) {
    dense.push([cur % W, (cur / W) | 0]);
    if (cur === si) break;
    cur = parent[cur];
  }
  dense.reverse();
  return dense;
}

/** 折线简化：保留转角（>25°）与长段（≥6 格） */
function simplifyPath(dense, minSeg = 6) {
  if (dense.length < 3) return dense.slice();
  const out = [dense[0]];
  let anchor = dense[0];
  let lastDir = null;
  for (let i = 1; i < dense.length - 1; i += 1) {
    const p = dense[i];
    const dx = p[0] - anchor[0];
    const dy = p[1] - anchor[1];
    const len = Math.hypot(dx, dy);
    const dir = [dx / (len || 1), dy / (len || 1)];
    if (lastDir && (dir[0] * lastDir[0] + dir[1] * lastDir[1] < Math.cos(Math.PI / 7.2))) {
      out.push(dense[i - 1]);
      anchor = dense[i - 1];
      lastDir = null;
      continue;
    }
    if (len >= minSeg) {
      out.push(p);
      anchor = p;
      lastDir = null;
      continue;
    }
    lastDir = dir;
  }
  out.push(dense[dense.length - 1]);
  return out;
}

function buildPaths(gdd, pois, heightmap, W, H, waterMask, zoneCoreMask, waterLevel) {
  const base = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) {
    let c = 1;
    if (heightmap[i] < waterLevel + 0.2) c += 150; // 开阔水面（倾向绕行/架桥于窄海峡）
    else if (waterMask[i]) c += 16; // 河道（浅滩可涉）
    if (zoneCoreMask[i]) c += 28; // 避穿其它据点核心
    base[i] = c;
  }
  const byId = new Map(pois.map((p) => [p.id, p]));
  const paths = [];
  for (const e of gdd.poiGraph.edges) {
    const a = byId.get(e.a);
    const b = byId.get(e.b);
    if (!a || !b) {
      paths.push({ a: e.a, b: e.b, kind: e.kind || 'path', found: false, points: [], dense: [], bridges: 0 });
      continue;
    }
    const dense = astar({ base, height: heightmap }, W, H, [a.pos[0], a.pos[1]], [b.pos[0], b.pos[1]]);
    if (!dense) {
      paths.push({ a: e.a, b: e.b, kind: e.kind || 'path', found: false, points: [], dense: [], bridges: 0 });
      continue;
    }
    let bridges = 0;
    for (const [px, py] of dense) if (heightmap[py * W + px] < waterLevel + 0.2 || waterMask[py * W + px]) bridges += 1;
    paths.push({
      a: e.a,
      b: e.b,
      kind: e.kind || 'path',
      found: true,
      points: simplifyPath(dense).map(([px, py]) => [px, py, Math.round(heightmap[py * W + px])]),
      dense,
      bridges,
    });
  }
  return paths;
}

/* ---------------------------------- 生物群系 ---------------------------------- */

function buildBiomeMap(gdd, heightmap, W, H, waterLevel, seed) {
  const palette = gdd.terrain.biomePalette;
  const n = palette.length;
  const moistSeed = (seed + 6211) | 0;
  const moistScale = 4.2 / Math.max(W, H);
  const moistField = new Float32Array(W * H);
  const landElev = [];
  const landMoist = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const [wx, wy] = warp2(x * moistScale + 31, y * moistScale + 17, moistSeed, 0.8);
      const m = fbm(wx, wy, moistSeed, 4);
      moistField[i] = m;
      if (heightmap[i] >= waterLevel) {
        landElev.push((heightmap[i] - waterLevel) / Math.max(1, 63 - waterLevel));
        landMoist.push(m);
      }
    }
  }
  landElev.sort((a, b) => a - b);
  landMoist.sort((a, b) => a - b);
  const quantileOf = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(q * arr.length)))] ?? 0.3;
  // e/m anchor 都取陆地分位数 → 每个生物群系领土面积≈均等（肉眼可辨的前提）
  const anchors = palette.map((b, i) => ({
    m: quantileOf(landMoist, (i + 0.5) / n),
    e: quantileOf(landElev, (i + 0.5) / n),
    ring: i,
  }));
  // 图例：0 号固定为 water，其后为 palette
  const legend = [{ id: 'water', name: '水域', density: 0, blocks: {} }, ...palette.map((b) => ({ id: b.biome, name: b.biome, density: b.density, blocks: b.blocks }))];
  const biomeMap = new Uint8Array(W * H);
  const dither = 0.02;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      const h = heightmap[i];
      if (h < waterLevel) {
        biomeMap[i] = 0;
        continue;
      }
      const elevN = (h - waterLevel) / Math.max(1, 63 - waterLevel);
      if (elevN > 0.78) {
        // 高海拔强制山地型生物群系
        let bi = 1;
        let be = -1;
        for (let k = 0; k < n; k += 1) {
          if (anchors[k].e > be) {
            be = anchors[k].e;
            bi = k + 1;
          }
        }
        biomeMap[i] = bi;
        continue;
      }
      const m = moistField[i];
      let bestI = 1;
      let bestD = Infinity;
      let secondD = Infinity;
      for (let k = 0; k < n; k += 1) {
        const dm = m - anchors[k].m;
        const de = elevN - anchors[k].e;
        const d = dm * dm + de * de * 2.6;
        if (d < bestD) {
          secondD = bestD;
          bestD = d;
          bestI = k + 1;
        } else if (d < secondD) {
          secondD = d;
        }
      }
      // 边缘 dither：两种候选几乎打平时按格点哈希 50/50 抖动
      if (secondD - bestD < dither && hash2(x, y, (seed + 77) | 0) < 0.45) {
        let bi = 1;
        let bd = Infinity;
        for (let k = 0; k < n; k += 1) {
          const dm = m - anchors[k].m;
          const de = elevN - anchors[k].e;
          const d = dm * dm + de * de * 2.6;
          if (d < bd && d > bestD - 1e-9) {
            bd = d;
            bi = k + 1;
          }
        }
        if (bi !== bestI && bd < secondD + 1e-9) bestI = bi;
      }
      biomeMap[i] = bestI;
    }
  }
  return { biomeMap, legend, anchors };
}

/* ---------------------------------- 散布 ---------------------------------- */

function buildScatter(gdd, heightmap, biomeMap, legend, W, H, waterLevel, waterMask, pathMask, zoneCoreMask, rng) {
  const items = [];
  const step = clamp(Math.round(Math.max(W, H) / 110), 3, 6);
  const cap = Math.max(W, H) >= 512 ? 8000 : 3000;
  for (let gy = 1; gy * step < H - 1; gy += 1) {
    for (let gx = 1; gx * step < W - 1; gx += 1) {
      const x = Math.round(gx * step + (rng() - 0.5) * step * 0.9);
      const y = Math.round(gy * step + (rng() - 0.5) * step * 0.9);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const i = y * W + x;
      if (heightmap[i] < waterLevel + 0.5 || waterMask[i] || pathMask[i] || zoneCoreMask[i]) continue;
      if (nearMask(waterMask, W, H, x, y, 1) || nearMask(pathMask, W, H, x, y, 1)) continue;
      const b = legend[biomeMap[i]];
      if (!b) continue;
      const density = b.density ?? 0.3;
      if (rng() > density * 0.55) continue;
      const r = rng();
      const elevN = (heightmap[i] - waterLevel) / Math.max(1, 63 - waterLevel);
      let kind;
      if (elevN > 0.62) kind = 'rock';
      else if (r < 0.55) kind = 'tree';
      else if (r < 0.82) kind = 'bush';
      else kind = 'rock';
      items.push({
        x,
        y,
        z: Math.round(heightmap[i]),
        kind,
        biome: b.id,
      });
      if (items.length >= cap) return items;
    }
  }
  return items;
}

function nearMask(mask, W, H, x, y, r) {
  for (let dy = -r; dy <= r; dy += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -r; dx <= r; dx += 1) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      if (mask[yy * W + xx]) return true;
    }
  }
  return false;
}

/* ---------------------------------- metrics 与重试 ---------------------------------- */

function computeMetrics(plan, gdd, anchors) {
  const [W, H] = plan.size;
  const total = W * H;
  const hm = plan.heightmap;
  const waterLevel = plan.waterLevel;
  const budget = plan.heightBudget;

  let land = 0;
  const hist = new Array(8).fill(0);
  for (let i = 0; i < total; i += 1) {
    if (hm[i] > waterLevel) land += 1;
    hist[clamp(Math.floor((hm[i] / budget) * 8), 0, 7)] += 1;
  }
  const landRatio = land / total;

  // 生物群系覆盖与邻接合法率
  const coverage = {};
  const legend = plan.biomeLegend;
  let pairs = 0;
  let legal = 0;
  const n = anchors.length;
  // 合法性：环形 anchor 序上相邻（含首尾相接）的生物群系才允许接壤；水域一律合法（海岸）
  const isLegal = (a, b) => {
    if (a === 0 || b === 0) return true;
    const diff = Math.abs(a - b);
    return diff === 1 || diff === n - 1;
  };
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const a = plan.biomeMap[y * W + x];
      coverage[legend[a].id] = (coverage[legend[a].id] || 0) + 1;
      if (x + 1 < W) {
        const b = plan.biomeMap[y * W + x + 1];
        if (a !== b) {
          pairs += 1;
          if (isLegal(a, b)) legal += 1;
        }
      }
      if (y + 1 < H) {
        const b = plan.biomeMap[(y + 1) * W + x];
        if (a !== b) {
          pairs += 1;
          if (isLegal(a, b)) legal += 1;
        }
      }
    }
  }
  const biomeCount = Object.keys(coverage).filter((k) => k !== 'water').length;

  // POI 连通率
  const found = plan.paths.filter((p) => p.found).length;
  const connectivity = plan.paths.length ? found / plan.paths.length : 1;

  // zone 平整度（核心区平均坡度）与过渡带宽度
  const zoneSlopes = {};
  let slopeSum = 0;
  let slopeN = 0;
  const transitions = [];
  for (const z of plan.zones) {
    let s = 0;
    let cnt = 0;
    const core = z.radius * 0.85; // 采样到过渡带，真实反映可走性（核心强制平坦，只测 0.85r 内）
    for (let dy = -core; dy <= core; dy += 2) {
      for (let dx = -core; dx <= core; dx += 2) {
        if (dx * dx + dy * dy > core * core) continue;
        const x = clamp(Math.round(z.center[0] + dx), 1, W - 2);
        const y = clamp(Math.round(z.center[1] + dy), 1, H - 2);
        const gx = hm[y * W + x + 1] - hm[y * W + x - 1];
        const gy = hm[(y + 1) * W + x] - hm[(y - 1) * W + x];
        s += Math.hypot(gx, gy) / 2;
        cnt += 1;
      }
    }
    const mean = cnt ? s / cnt : 0;
    zoneSlopes[z.id] = Math.round(mean * 1000) / 1000;
    slopeSum += mean;
    slopeN += 1;
    // 过渡带宽度：从核心边缘向外走到高度接近周边（偏离 target > 2）为止
    const widths = [];
    for (let k = 0; k < 8; k += 1) {
      const ang = (k / 8) * Math.PI * 2;
      let width = 0;
      for (let d = z.radius * 0.78; d < z.radius * 1.8; d += 1) {
        const x = clamp(Math.round(z.center[0] + Math.cos(ang) * d), 0, W - 1);
        const y = clamp(Math.round(z.center[1] + Math.sin(ang) * d), 0, H - 1);
        if (Math.abs(hm[y * W + x] - z.target) > 2.2) break;
        width = d - z.radius * 0.78;
      }
      widths.push(width);
    }
    transitions.push(widths.reduce((a, b) => a + b, 0) / widths.length);
  }
  const zoneSlopeMean = slopeN ? slopeSum / slopeN : 0;
  const transitionWidth = {
    min: Math.round(Math.min(...transitions) * 10) / 10,
    mean: Math.round((transitions.reduce((a, b) => a + b, 0) / Math.max(1, transitions.length)) * 10) / 10,
    max: Math.round(Math.max(...transitions) * 10) / 10,
  };

  const thresholds = {
    landRatio: [0.45, 0.75],
    poiConnectivity: 1,
    zoneSlopeMean: 0.35,
    biomeCount: 4,
    biomeAdjacencyRate: 0.6,
  };
  const violations = [];
  if (landRatio < thresholds.landRatio[0] || landRatio > thresholds.landRatio[1]) violations.push(`landRatio=${landRatio.toFixed(2)}`);
  if (connectivity < thresholds.poiConnectivity) violations.push(`connectivity=${connectivity.toFixed(2)}`);
  if (zoneSlopeMean > thresholds.zoneSlopeMean) violations.push(`zoneSlope=${zoneSlopeMean.toFixed(3)}`);
  if (biomeCount < thresholds.biomeCount) violations.push(`biomes=${biomeCount}`);
  const adjacencyRate = pairs ? legal / pairs : 1;
  if (adjacencyRate < thresholds.biomeAdjacencyRate) violations.push(`adjacency=${adjacencyRate.toFixed(2)}`);

  return {
    landRatio: Math.round(landRatio * 1000) / 1000,
    elevationHistogram: hist,
    biomeCount,
    biomeCoverage: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000])),
    biomeAdjacencyRate: Math.round(adjacencyRate * 1000) / 1000,
    biomeBoundaryPairs: pairs,
    poiConnectivity: connectivity,
    pathEdges: plan.paths.length,
    bridges: plan.paths.reduce((a, p) => a + p.bridges, 0),
    zoneSlopeMean: Math.round(zoneSlopeMean * 1000) / 1000,
    zoneSlopes,
    transitionWidth,
    rivers: plan.rivers.length,
    lakes: plan.lakes.length,
    landmarks: plan.landmarks.length,
    scatterCount: plan.scatter.length,
    thresholds,
    violations,
    passed: violations.length === 0,
  };
}

/* ---------------------------------- 对外主入口 ---------------------------------- */

/**
 * buildTerrainPlan(gdd, options?) → TerrainPlan
 * options.maxAttempts：metrics 不达标时换 seed 扰动重试的轮数上限（默认 3）。
 */
/**
 * 复合质量分（无违约时也分高下，best-of-N 选优用）：
 * 陆地占比越靠近 [0.45,0.75] 中点越好、zone 坡度越小越好、POI 连通率加权最高。
 */
function planQualityScore(plan) {
  const m = plan.metrics;
  const land = m.landRatio ?? 0.5;
  const landScore = 100 - Math.abs(land - 0.6) * 250; // 0.6 为区间中点
  const slopeScore = 100 - (m.zoneSlopeMean ?? 0) * 200;
  const connScore = (m.poiConnectivity ?? 0) * 100;
  const biomeScore = Math.min(100, (m.biomeCount ?? 0) * 25);
  const adjacencyScore = Math.min(100, (m.biomeAdjacencyRate ?? 0) * 100);
  return landScore * 0.3 + slopeScore * 0.2 + connScore * 0.3 + biomeScore * 0.1 + adjacencyScore * 0.1;
}

export function buildTerrainPlan(gddInput, options = {}) {
  const t0 = Date.now();
  const gdd = normalizeGdd(gddInput);
  const maxAttempts = clamp(options.maxAttempts ?? 3, 1, 5);
  let best = null;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const seed = (gdd.seed + attempt * 7919) >>> 0;
    const plan = generateOnce(gdd, seed, attempt);
    // 选优：先比违约数（硬闸），同分比复合质量分（软指标）——
    // 全达标时也能挑出"更居中"的地形，而不是停在第一个侥幸达标者。
    const score = plan.metrics.violations.length * 1000 + planQualityScore(plan);
    if (!best || score > bestScore) {
      best = plan;
      bestScore = score;
    }
    if (plan.metrics.passed) break;
  }
  best.metrics.elapsedMs = Date.now() - t0;
  best.version = PLAN_VERSION;
  return best;
}

/** 双线性高度采样（供渲染/执行器贴地） */
export function sampleHeight(plan, x, y) {
  const [W, H] = plan.size;
  const fx = clamp(x, 0, W - 1.001);
  const fy = clamp(y, 0, H - 1.001);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = plan.heightmap[y0 * W + x0];
  const h10 = plan.heightmap[y0 * W + x0 + 1];
  const h01 = plan.heightmap[(y0 + 1) * W + x0];
  const h11 = plan.heightmap[(y0 + 1) * W + x0 + 1];
  return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), ty);
}

/* ------------------------- 紧凑序列化（供执行器 / 落盘） ------------------------- */

function toB64(u8) {
  return Buffer.from(u8).toString('base64');
}

function fromB64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** 压缩导出：heightmap 量化为 Uint8（0..255 ↔ 0..heightBudget），biomeMap 原样 */
export function exportPlanJson(plan) {
  const [W, H] = plan.size;
  const q = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) q[i] = clamp(Math.round((plan.heightmap[i] / plan.heightBudget) * 255), 0, 255);
  const light = { ...plan };
  delete light.heightmap;
  delete light.biomeMap;
  delete light.paths;
  const slimPaths = plan.paths.map((p) => ({ a: p.a, b: p.b, kind: p.kind, found: p.found, points: p.points, bridges: p.bridges }));
  return JSON.stringify({
    ...JSON.parse(JSON.stringify(light, (k, v) => (v instanceof Float32Array ? Array.from(v) : v))),
    heightmapQ: toB64(q),
    biomeMapQ: toB64(plan.biomeMap),
    paths: slimPaths,
  });
}

export function importPlanJson(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  const [W, H] = raw.size;
  const q = fromB64(raw.heightmapQ);
  const heightmap = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) heightmap[i] = (q[i] / 255) * raw.heightBudget;
  const plan = { ...raw, heightmap, biomeMap: fromB64(raw.biomeMapQ), paths: raw.paths };
  delete plan.heightmapQ;
  delete plan.biomeMapQ;
  return plan;
}
