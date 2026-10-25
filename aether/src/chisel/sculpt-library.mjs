/**
 * sculpt-library.mjs — VOXA v3 流派模型程序库 (SculptLibrary/0.3)
 *
 * 5 个 artStyle × 每流派 4 个程序化模型，全部用 model-sculpt.mjs 的 SDF/装饰/
 * critic API 雕出来。每个程序是 gddEntry -> sculptModel：
 *   { style, natural:[nx,ny,nz], palette, groups, bones, animations, pivot }
 *
 * 流派与模型：
 *  - pixel : pixel-rifle / pixel-pickaxe / pixel-turret / pixel-castle
 *  - ink   : ink-furnace / ink-crane / ink-stele / ink-boat（v2 移植 + critic 再调）
 *  - hitech: hitech-pylon / hitech-hoverbike / hitech-drone / hitech-station
 *  - cozy  : cozy-cottage / cozy-well / cozy-campfire / cozy-stall
 *  - horror: horror-deadtree / horror-grave / horror-altar / horror-hut
 *
 * 系列一致性：同一 artStyle 内通过 SeriesPalette 共享 ramp 注册表。
 */
import {
  Palette, SeriesPalette, Sculptor, sd, fbm3, valueNoise3, hash3, clamp01,
  radialArray, stampGlyph, meanderMask, cloudMask, weathering, TAU,
} from './model-sculpt.mjs';

/* ============================== 通用小件 ============================== */

/** 像素抖动（棋盘 + 噪声），返回 0/1 */
function dither(x, y, z, seed = 3) {
  return ((x + y + z) % 2 === 0 ? 0.12 : 0) + (hash3(x, y, z, seed) - 0.5) * 0.1;
}

/** 条件雕刻：把 sdf<0 区域按 hash 概率零星抠掉（破旧/镂空感） */
function speckleCarve(sc, sdf, { seed = 17, keep = 0.45 } = {}) {
  sc.carve((x, y, z) => (sdf(x + 0.5, y + 0.5, z + 0.5) < 0 && hash3(x, y, z, seed) > keep ? -1 : 1));
}

/* ============================== PIXEL ============================== */

const spPixel = new SeriesPalette();

/** 像素步枪（hero）：26×10×8，待机后坐 + 能量匣发光 */
export function pixelRifle() {
  const pal = new Palette();
  const steel = spPixel.ramp(pal, 'pixel', 'steel', '#9aa7b4', { steps: 7, vRange: [0.55, 1.1], hueShift: -5 });
  const steelD = spPixel.ramp(pal, 'pixel', 'steelD', '#525d68', { steps: 5, vRange: [0.6, 1.0] });
  const wood = spPixel.ramp(pal, 'pixel', 'wood', '#8a5a32', { steps: 6, vRange: [0.55, 1.08] });
  const gold = spPixel.ramp(pal, 'pixel', 'gold', '#d9a441', { steps: 4, vRange: [0.6, 1.12] });
  const cell = spPixel.ramp(pal, 'pixel', 'cell', '#48e0c8', { steps: 5, vRange: [0.6, 1.15], emissive: 0.55, emissiveTop: 1 });
  const gripD = spPixel.ramp(pal, 'pixel', 'gripD', '#2e3338', { steps: 4, vRange: [0.6, 1.0] });

  const W = 26, H = 10, D = 8;
  const body = new Sculptor(W, H, D);
  const paintSteel = (x, y, z) => steel(clamp01(0.35 + y / 10 + dither(x, y, z, 5)));
  const paintWood = (x, y, z) => wood(clamp01(0.4 + y / 8 + dither(x, y, z, 9)));

  // 机匣（主体）
  body.fill(sd.roundBox(12.5, 5, 4, 6.5, 1.7, 1.7), paintSteel);
  // 枪管 + 消焰器
  body.fill(sd.roundBox(20.5, 5, 4, 4.2, 0.75, 0.75), paintSteel);
  body.fill(sd.roundBox(24.6, 5, 4, 1.0, 1.05, 1.05), (x, y, z) => steelD(0.7));
  body.carve(sd.roundBox(25.6, 5, 4, 0.4, 0.5, 0.5)); // 枪口
  // 导气管（下挂）
  body.fill(sd.roundBox(18.5, 3.6, 4, 2.6, 0.45, 0.45), (x, y, z) => gold(0.6));
  // 枪托（木）
  body.fill(sd.roundBox(3.2, 4.6, 4, 3.0, 1.6, 1.4), paintWood);
  body.fill(sd.roundBox(5.6, 5.8, 4, 1.2, 1.2, 1.2), paintWood);
  // 握把（竖直）
  body.fill(sd.roundBox(9.4, 2.4, 4, 1.15, 2.3, 1.05), (x, y, z) => gripD(clamp01(0.5 + (y - 1) / 5)));
  // 弹匣（能量匣，发光芯）
  body.fill(sd.roundBox(13.4, 2.8, 4, 1.05, 2.2, 1.15), (x, y, z) => steelD(0.62 + dither(x, y, z, 11)));
  body.fill(sd.roundBox(13.4, 3.0, 4, 0.5, 1.4, 0.6), (x, y, z) => cell(0.5 + (y - 1) / 5));
  // 瞄具：导轨 + 镜体 + 发光镜头
  body.fill(sd.roundBox(13.5, 7.0, 4, 3.6, 0.35, 0.6), (x, y, z) => steelD(0.66));
  body.fill(sd.capsule(16.2, 7.4, 4, 11.6, 7.4, 4, 1.0), (x, y, z) => steel(0.55 + dither(x, y, z, 13)));
  body.fill(sd.ell(11.6, 7.4, 4, 0.7, 0.7, 0.7), () => cell(0.95));
  body.fill(sd.ell(16.2, 7.4, 4, 0.6, 0.6, 0.6), () => cell(0.75));
  // 侧身散热条纹（左右对称：只刻 x<13.5 再镜像）
  body.repaint(
    (x, y, z) => (Math.abs(z - 4) > 1.7 && x % 3 === 0 ? steelD(0.5) : 0),
    (x, y, z) => x >= 8 && x <= 17 && y >= 3.6 && y <= 6.4 && Math.abs(z - 4) > 1.7 && body.get(x, y, z),
  );

  return {
    style: 'pixel-rifle', natural: [W, H, D], palette: pal,
    groups: [{ id: 'rifle_body', name: '枪身', position: [0, 0, 0], sculptor: body, bone: 'bone-rifle' }],
    bones: [{ id: 'bone-rifle', name: 'RifleRoot', parent: 'ROOT_BONE', position: [12, 5, 4] }],
    animations: [{
      id: 'recoil', name: 'Recoil Idle', duration: 2.0, loop: true, channels: [
        { bone: 'bone-rifle', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 0.4, value: [-0.7, 0.1, 0] }, { time: 0.8, value: [0, 0, 0] }, { time: 2.0, value: [0, 0, 0] },
        ] },
        { bone: 'bone-rifle', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.4, value: [1.03, 0.98, 1.02] }, { time: 0.8, value: [1, 1, 1] }, { time: 2.0, value: [1, 1, 1] },
        ] },
      ],
    }],
    pivot: [12, 5, 4],
  };
}

/** 像素镐（工具）：22×30×12，竖持，弧形镐头 */
export function pixelPickaxe() {
  const pal = new Palette();
  const metal = spPixel.ramp(pal, 'pixel', 'metal', '#b8c4cc', { steps: 7, vRange: [0.55, 1.1] });
  const metalD = spPixel.ramp(pal, 'pixel', 'metalD', '#5e6a72', { steps: 5, vRange: [0.6, 1.0] });
  const wood = spPixel.ramp(pal, 'pixel', 'handle', '#8a5a32', { steps: 6, vRange: [0.55, 1.06] });
  const cord = spPixel.ramp(pal, 'pixel', 'cord', '#a83c34', { steps: 4, vRange: [0.6, 1.1] });
  const gem = spPixel.ramp(pal, 'pixel', 'gem', '#63e0d0', { steps: 4, vRange: [0.6, 1.15], emissive: 0.5, emissiveTop: 0.95 });
  const leather = spPixel.ramp(pal, 'pixel', 'leather', '#6e4a2a', { steps: 4, vRange: [0.6, 1.05] });

  const W = 22, H = 30, D = 12, cx = 11, cz = 6;
  const main = new Sculptor(W, H, D);
  // 手柄（竖直）+ 缠绳握把
  main.fill(sd.cylinderY(cx, cz, 1, 24, 1.25), (x, y, z) => wood(clamp01(0.42 + y / 26 + dither(x, y, z, 3))));
  main.fill(sd.cylinderY(cx, cz, 4.5, 9.5, 1.45), (x, y, z) => ((y % 1.2) < 0.6 ? cord(0.7) : cord(0.45)));
  // 弧形镐头（extrudeAlong 沿弧线，两端尖）
  const headPts = sd.bezier3([2.5, 26, cz], [5.5, 30.5, cz], [16.5, 30.5, cz], [19.5, 26, cz], 22);
  main.fill(sd.extrudeAlong(headPts, (t) => ({ rx: 1.9 - Math.abs(t - 0.5) * 0.7, rz: 1.35 - Math.abs(t - 0.5) * 0.5 })),
    (x, y, z) => {
      const t = clamp01((30.5 - y) / 5);
      const n = dither(x, y, z, 7);
      if (t > 0.75) return metalD(0.6 + n); // 背脊
      return metal(clamp01(0.45 + t * 0.5 + n));
    });
  // 两端镐尖加长
  for (const side of [-1, 1]) {
    main.fill(sd.polylineTube([[cx + side * 8.4, 26.2, cz], [cx + side * 10.4, 25.0, cz]], (t) => 1.15 - t * 0.75),
      (x, y, z) => metal(0.7));
  }
  // 头柄交接金箍 + 镶晶
  main.fill(sd.cylinderY(cx, cz, 22.4, 23.8, 1.6), (x, y, z) => metalD(0.75));
  main.fill(sd.ell(cx, 25.2, cz, 1.5, 1.5, 1.5), (x, y, z) => gem(0.55 + (y - 24) / 3));
  // 尾端皮环
  main.fill(sd.cylinderY(cx, cz, 1.2, 2.6, 1.5), (x, y, z) => leather(0.6));
  weathering(main, { amount: 0.08, seed: 23 });

  return {
    style: 'pixel-pickaxe', natural: [W, H, D], palette: pal,
    groups: [{ id: 'pickaxe_body', name: '镐', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/** 像素炮塔（防御）：30×26×30，底座 + 双管 + 雷达，头部旋转 */
export function pixelTurret() {
  const pal = new Palette();
  const armor = spPixel.ramp(pal, 'pixel', 'armor', '#7d8a7a', { steps: 8, vRange: [0.52, 1.08], hueShift: 4 });
  const armorD = spPixel.ramp(pal, 'pixel', 'armorD', '#454e48', { steps: 5, vRange: [0.6, 1.0] });
  const gun = spPixel.ramp(pal, 'pixel', 'gun', '#5a6470', { steps: 5, vRange: [0.58, 1.05] });
  const amber = spPixel.ramp(pal, 'pixel', 'amber', '#ff8c3a', { steps: 4, vRange: [0.7, 1.15], emissive: 0.7, emissiveTop: 1 });
  const hazard = spPixel.ramp(pal, 'pixel', 'hazard', '#d9a441', { steps: 4, vRange: [0.6, 1.1] });
  const radar = spPixel.ramp(pal, 'pixel', 'radar', '#c8d2d8', { steps: 4, vRange: [0.6, 1.08] });

  const W = 30, H = 26, D = 30, cx = 15, cz = 15;
  const base = new Sculptor(W, H, D);
  // 底座三层
  base.fill(sd.cylinderY(cx, cz, 0, 3.2, 13.2), (x, y, z) => armorD(clamp01(0.45 + y / 5 + dither(x, y, z, 3))));
  base.fill(sd.cylinderY(cx, cz, 3.2, 5.0, 11.4), (x, y, z) => {
    const ang = Math.atan2(z + 0.5 - cz, x + 0.5 - cx);
    if (Math.floor(ang / (TAU / 16)) % 2 === 0) return hazard(0.7); // 警示条
    return armor(0.55);
  });
  // 螺栓点缀（环形阵列凸点）
  const bolts = radialArray(8, cx, cz, (ang) => sd.sphere(cx + Math.cos(ang) * 9.8, 4.6, cz + Math.sin(ang) * 9.8, 0.75));
  base.fill(bolts, () => gun(0.85));

  const head = new Sculptor(W, H, D);
  // 炮塔本体（半球 + 收腰）
  head.fill(sd.smoothUnion(1.6)(
    sd.ell(cx, 9.2, cz, 7.0, 4.6, 7.0),
    sd.cylinderY(cx, cz, 5.0, 7.6, 6.4),
  ), (x, y, z) => {
    const n = dither(x, y, z, 7);
    if (y > 12.2) return armor(0.8 + n);
    return armor(clamp01(0.4 + (y - 5) / 10 + n));
  });
  // 双管（朝 +x）
  for (const side of [-1, 1]) {
    head.fill(sd.capsule(cx + 2, 9.6, cz + side * 1.7, cx + 13.2, 9.6, cz + side * 1.7, 0.95),
      (x, y, z) => gun(clamp01(0.5 + (x - 10) / 12 + dither(x, y, z, 9))));
    head.fill(sd.cylinderY(cx + 12.6, cz + side * 1.7, 8.4, 10.8, 1.15), () => gun(0.8)); // 制退器
    head.carve(sd.cylinderY(cx + 13.6, cz + side * 1.7, 8.6, 10.6, 0.55));
  }
  // 装弹药鼓（两侧）
  for (const side of [-1, 1]) {
    head.fill(sd.roundBox(cx + 0.5, 8.6, cz + side * 4.7, 2.0, 1.8, 1.6, 0.4), (x, y, z) => armorD(0.66 + dither(x, y, z, 11)));
    head.fill(sd.roundBox(cx + 0.5, 8.6, cz + side * 4.7, 1.2, 0.9, 0.6, 0.3), () => amber(0.9));
  }
  // 雷达 + 天线
  head.fill(sd.capsule(cx, 13.4, cz, cx, 17.0, cz, 0.55), () => gun(0.7));
  head.fill(sd.ell(cx, 16.6, cz, 2.6, 0.5, 2.6), (x, y, z) => radar(clamp01(0.6 + (y - 16) / 2)));
  head.fill(sd.ell(cx, 17.4, cz, 0.7, 0.9, 0.7), () => amber(1.0));

  return {
    style: 'pixel-turret', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'turret_base', name: '基座', position: [0, 0, 0], sculptor: base },
      { id: 'turret_head', name: '炮塔头', position: [0, 0, 0], sculptor: head, bone: 'bone-turret-head' },
    ],
    bones: [{ id: 'bone-turret-head', name: 'TurretHead', parent: 'ROOT_BONE', position: [cx, 5, cz] }],
    animations: [{
      id: 'sweep', name: 'Radar Sweep', duration: 6.0, loop: true, channels: [
        { bone: 'bone-turret-head', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 3.0, value: [0, 1, 0, 0] }, { time: 6.0, value: [0, 0, 0, 1] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 像素城堡（landmark）：42×40×42，四角塔 + 主堡 + 大门 */
export function pixelCastle() {
  const pal = new Palette();
  const stone = spPixel.ramp(pal, 'pixel', 'stone', '#8d949c', { steps: 9, vRange: [0.5, 1.08], hueShift: -4 });
  const stoneD = spPixel.ramp(pal, 'pixel', 'stoneDark', '#4a5058', { steps: 5, vRange: [0.6, 1.0] });
  const slate = spPixel.ramp(pal, 'pixel', 'slate', '#4a6a8a', { steps: 6, vRange: [0.55, 1.05] });
  const wood = spPixel.ramp(pal, 'pixel', 'timber', '#7c5836', { steps: 5, vRange: [0.55, 1.05] });
  const banner = spPixel.ramp(pal, 'pixel', 'banner', '#a63b32', { steps: 4, vRange: [0.55, 1.1] });
  const gold = spPixel.ramp(pal, 'pixel', 'gilding', '#d9a441', { steps: 4, vRange: [0.6, 1.12] });
  const moss = spPixel.ramp(pal, 'pixel', 'moss', '#5c7a52', { steps: 4, vRange: [0.55, 1.0] });
  const winGlow = spPixel.ramp(pal, 'pixel', 'winGlow', '#ffb03a', { steps: 4, vRange: [0.7, 1.1], emissive: 0.75, emissiveTop: 1 });

  const W = 42, H = 40, D = 42, cx = 21, cz = 21;
  const main = new Sculptor(W, H, D);
  const paintStone = (x, y, z) => {
    const n = dither(x, y, z, 5);
    const brick = (Math.floor(y / 2) + Math.floor(x / 4)) % 2 === 0 ? 0.04 : -0.04;
    const m = fbm3(x, y, z, { freq: 0.09, seed: 9 });
    if (m > 0.66 && y < 12) return moss(clamp01(0.4 + (m - 0.66) * 3 + n));
    return stone(clamp01(0.36 + y / 44 + brick + n));
  };

  // 四角塔（r=5.5，h=27）+ 垛口 + 塔顶锥顶
  const towers = [[7, 7], [35, 7], [7, 35], [35, 35]];
  for (const [tx, tz] of towers) {
    main.fill(sd.cylinderY(tx, tz, 0, 27, 5.5), paintStone);
    // 垛口：环形阵列方块间掏空
    main.carve(radialArray(8, tx, tz, (ang, i) => sd.roundBox(
      tx + Math.cos(ang) * 5.2, 27.8, tz + Math.sin(ang) * 5.2, 1.2, 1.2, 1.2,
    )));
    // 锥顶 + 旗
    main.fill((x, y, z) => {
      const r = Math.hypot(x + 0.5 - tx, z + 0.5 - tz);
      return r / 5.2 + (y - 28) / 6 - 1;
    }, (x, y, z) => {
      const t = (y - 28) / 7;
      return slate(clamp01(0.45 + t * 0.5 + dither(x, y, z, 7)));
    });
    main.fill(sd.cylinderY(tx, tz, 33.4, 36.2, 0.4), () => wood(0.6));
    main.fill(sd.roundBox(tx, 35.4, tz + 0.7, 0.15, 0.9, 1.2), () => banner(0.72));
  }

  // 环墙（连接四塔，h=14）+ 垛口
  const wallSdf = (x, y, z) => {
    const inWall = Math.min(
      Math.abs(x - cx) - 14.4, Math.abs(z - cz) - 14.4, // 外圈
    );
    const inner = Math.min(Math.abs(x - cx), Math.abs(z - cz)) - 11.2;
    const horiz = Math.max(Math.abs(x - cx), Math.abs(z - cz));
    if (horiz > 15 && horiz < 17.2) return -1; // 近似环带
    return 1;
  };
  main.fill((x, y, z) => {
    const hx = Math.abs(x + 0.5 - cx), hz = Math.abs(z + 0.5 - cz);
    const ring = Math.max(hx, hz);
    const yOk = y >= 0 && y <= 14;
    return ring < 16.4 && ring > 13.6 && yOk ? -1 : 1;
  }, paintStone);
  main.carve((x, y, z) => {
    if (y < 13 || y > 15.6) return 1;
    const hx = Math.abs(x + 0.5 - cx), hz = Math.abs(z + 0.5 - cz);
    const ring = Math.max(hx, hz);
    return (Math.floor((hx > hz ? x + 0.5 : z + 0.5) / 2.6) % 2 === 0 && ring < 16.4) ? -1 : 1;
  });

  // 主堡（中央 keep）+ 垛口 + 大门拱
  main.fill(sd.roundBox(cx, 9, cz, 8.2, 9, 8.2, 0.4), paintStone);
  main.carve(sd.roundBox(cx, 17.2, cz, 7.6, 1.2, 7.6)); // 垛口环槽
  main.fill(sd.roundBox(cx, 17.6, cz, 8.2, 1.4, 8.2, 0.4), paintStone);
  main.carve((x, y, z) => {
    if (y < 16.6 || y > 19) return 1;
    const hx = Math.abs(x + 0.5 - cx), hz = Math.abs(z + 0.5 - cz);
    return (Math.floor((hx > hz ? x + 0.5 : z + 0.5) / 2.8) % 2 === 0) ? -1 : 1;
  });
  // 大门（拱门 + 木门 + 门环）
  main.carve(sd.roundBox(cx, 4.4, cz - 15.0, 2.6, 4.2, 1.6, 1.4));
  main.fill(sd.roundBox(cx, 3.6, cz - 15.0, 2.2, 3.4, 0.7, 0.4), (x, y, z) => wood(clamp01(0.42 + y / 8 + dither(x, y, z, 13))));
  main.fill(sd.ell(cx - 1.4, 4.2, cz - 15.8, 0.45, 0.45, 0.45), () => gold(0.85));
  // 窗（发光）
  for (const side of [-1, 1]) {
    main.fill(sd.roundBox(cx + side * 8.2, 12.5, cz, 0.4, 1.4, 1.4), () => winGlow(0.85));
    main.fill(sd.roundBox(cx, 12.5, cz + side * 8.2, 1.4, 1.4, 0.4), () => winGlow(0.85));
  }
  // 城墙内侧走道木梁
  main.fill(sd.roundBox(cx, 12.4, cz - 15.0, 12.5, 0.4, 0.9), () => wood(0.5));
  main.fill(sd.roundBox(cx, 12.4, cz + 15.0, 12.5, 0.4, 0.9), () => wood(0.5));
  weathering(main, { amount: 0.06, seed: 31 });

  return {
    style: 'pixel-castle', natural: [W, H, D], palette: pal,
    groups: [{ id: 'castle_body', name: '城堡', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/* ============================== INK（v2 移植） ============================== */

const spInk = new SeriesPalette();

/** 青铜丹炉（v2 rev2 移植：竖环双耳/地火/角向回纹由 meanderMask 重做） */
export function inkFurnace() {
  const pal = new Palette();
  const bronze = spInk.ramp(pal, 'ink', 'bronze', '#8a6430', { steps: 9, vRange: [0.5, 1.12], hueShift: -6 });
  const bronzeD = spInk.ramp(pal, 'ink', 'bronzeDark', '#4f3d22', { steps: 5, vRange: [0.6, 1.0] });
  const gold = spInk.ramp(pal, 'ink', 'gold', '#d9a441', { steps: 6, vRange: [0.55, 1.15], hueShift: 4 });
  const patina = spInk.ramp(pal, 'ink', 'patina', '#4d7a68', { steps: 4, vRange: [0.6, 1.05] });
  const ember = spInk.ramp(pal, 'ink', 'ember', '#e2481d', { steps: 6, vRange: [0.45, 1.2], emissive: 0.55, emissiveTop: 1.0 });
  const emberCore = spInk.ramp(pal, 'ink', 'emberCore', '#ffb347', { steps: 4, vRange: [0.8, 1.2], emissive: 0.9, emissiveTop: 1.0 });
  const jade = spInk.ramp(pal, 'ink', 'jade', '#5fbe8f', { steps: 4, vRange: [0.6, 1.05], emissive: 0.12, emissiveTop: 0.3 });

  const W = 28, H = 35, D = 28, cx = 14, cz = 14;
  const body = new Sculptor(W, H, D);

  // 三足
  const legAngle = [-Math.PI / 2, -Math.PI / 2 + TAU / 3, -Math.PI / 2 + (2 * TAU) / 3];
  for (const ang of legAngle) {
    const rOut = 8.6;
    const ax = cx + Math.cos(ang) * rOut, az = cz + Math.sin(ang) * rOut;
    const midX = cx + Math.cos(ang) * 10.0, midZ = cz + Math.sin(ang) * 10.0;
    const topX = cx + Math.cos(ang) * 6.6, topZ = cz + Math.sin(ang) * 6.6;
    const legSdf = sd.polylineTube([[ax, 0.6, az], [midX, 4.4, midZ], [topX, 8.8, topZ]], (t) => 2.5 - t * 0.95);
    body.fill(legSdf, (x, y, z) => {
      const t = y / 9;
      const n = (fbm3(x, y, z, { freq: 0.3, seed: 11 }) - 0.5) * 0.22;
      return y < 2.4 ? bronzeD(0.55 + t * 0.35 + n) : bronze(0.34 + t * 0.5 + n);
    });
    body.fill(sd.ell(ax, 1.7, az, 2.7, 1.6, 2.7), (x, y, z) => bronzeD(0.4 + (hash3(x, 2, z, 5) - 0.5) * 0.2));
  }

  // 炉身（车削，壁厚 2.2）
  const profile = [
    [8.0, 6.8], [9.0, 8.6], [11.0, 9.8], [13.5, 10.2], [16.0, 9.8],
    [18.5, 8.8], [20.0, 7.8], [20.6, 7.4], [21.4, 8.2], [22.0, 8.6],
  ];
  const bellySdf = sd.lathe(cx, cz, profile);
  const innerSdf = sd.lathe(cx, cz, profile.map(([y, r]) => [y, r - 2.2]));
  body.fill(sd.subtract(bellySdf, innerSdf), (x, y, z) => {
    const r = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
    const t = (y - 8) / 14;
    const n = (fbm3(x, y, z, { freq: 0.22, seed: 21 }) - 0.5) * 0.28;
    const pat = fbm3(x, y, z, { freq: 0.09, seed: 33 });
    if (pat > 0.68 && y < 14 && r > 7.4) return patina(clamp01((pat - 0.68) * 4 + 0.35 + n * 0.3));
    if ((y >= 10 && y <= 10.9) || (y >= 21 && y <= 22)) return gold(0.62 + t * 0.3 + n * 0.2);
    // 饕餮装饰带（参数化回纹）
    if (y >= 13 && y <= 16.6) {
      const ang = Math.atan2(z + 0.5 - cz, x + 0.5 - cx);
      const u = ((ang / TAU) % 1 + 1) % 1;
      const v = (y - 13) / 3.6;
      if (meanderMask(u, v, { cells: 10, thick: 0.3 })) return bronzeD(0.52 + n * 0.3);
      return bronze(0.56 + t * 0.32 + n * 0.22);
    }
    return bronze(0.32 + t * 0.54 + n * 0.22);
  });

  // 双耳（竖环，嵌入炉壁）
  for (const side of [-1, 1]) {
    body.fill(sd.torusZ(cx + side * 9.4, 19.6, cz, 2.4, 1.05), (x, y, z) => {
      const n = (fbm3(x, y, z, { freq: 0.4, seed: 55 }) - 0.5) * 0.22;
      return gold(clamp01(0.5 + (y - 17.4) / 5 + n));
    });
  }

  // 炉盖（穹顶 + 镂空 + 玉珠）
  const lidProfile = [[22.6, 8.0], [24.0, 7.5], [25.8, 6.1], [27.4, 4.3], [28.6, 2.5], [29.4, 1.3]];
  const lidSdf = sd.lathe(cx, cz, lidProfile);
  const lidInner = sd.lathe(cx, cz, lidProfile.map(([y, r]) => [y, r - 1.8]));
  body.fill(sd.subtract(lidSdf, lidInner), (x, y, z) => {
    const t = (y - 22.5) / 7;
    const n = (fbm3(x, y, z, { freq: 0.25, seed: 66 }) - 0.5) * 0.24;
    if (y >= 28.8) return gold(0.7 + t * 0.25);
    return bronze(0.44 + t * 0.5 + n);
  });
  body.carve((x, y, z) => {
    if (y < 24.2 || y > 26.2) return 1;
    const r = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
    if (r < 5.0 || r > 6.7) return 1;
    const ang = Math.atan2(z + 0.5 - cz, x + 0.5 - cx);
    const a = ((ang / TAU) % 1 + 1) % 1;
    return hash3(Math.floor(a * 8), Math.floor(y - 24.2), 8, 9) > 0.5 ? -1 : 1;
  });
  body.fill(sd.ell(cx, 31.4, cz, 2.0, 2.0, 2.0), (x, y, z) => jade(clamp01(0.4 + (y - 29.6) / 3.4 + (fbm3(x, y, z, { freq: 0.5, seed: 77 }) - 0.5) * 0.2)));
  body.fill(sd.cylinderY(cx, cz, 29.4, 30.2, 1.0), () => gold(0.6));

  // 地火（独立组，bone 动画）
  const flame = new Sculptor(W, 13, D);
  flame.fill((x, y, z) => {
    const r = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
    const ny = (y - 0.5) / 3.2;
    return r / 7.4 + ny * ny - 1;
  }, (x, y, z) => {
    const t = y / 3.2;
    return ember(0.25 + t * 0.5 + (fbm3(x, y, z, { freq: 0.5, seed: 3 }) - 0.5) * 0.25);
  });
  const tongues = [
    { off: [0, 0], h: 11.5, r0: 2.6, seed: 88 },
    { off: [-3.4, 2.4], h: 8.2, r0: 2.0, seed: 89 },
    { off: [3.2, -2.6], h: 8.6, r0: 2.0, seed: 90 },
  ];
  for (const tg of tongues) {
    const fSdf = (x, y, z) => {
      const t = clamp01((y - 2.5) / tg.h);
      const sway = Math.sin(t * 2.4) * 1.3;
      const rr = tg.r0 * (1 - t * 0.72) + 0.5;
      const d = sd.ell(cx + tg.off[0] + sway, 2.5 + t * tg.h, cz + tg.off[1], rr, tg.h * 0.52, rr)(x, y, z);
      return d + (fbm3(x, y, z, { freq: 0.32, seed: tg.seed, octaves: 3 }) - 0.5) * 1.15 * (1 - t * 0.5);
    };
    flame.fill(fSdf, (x, y, z) => {
      const t = clamp01((y - 2.5) / tg.h);
      const r = Math.hypot(x + 0.5 - cx - tg.off[0], z + 0.5 - cz - tg.off[1]);
      const core = r < tg.r0 * 0.55 && t < 0.7;
      const n = (fbm3(x, y, z, { freq: 0.5, seed: 99 }) - 0.5) * 0.3;
      return core ? emberCore(clamp01(0.35 + t * 0.7 + n)) : ember(clamp01(0.15 + t * 0.8 + n));
    });
  }

  return {
    style: 'ink-furnace', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'furnace_body', name: '炉身', position: [0, 0, 0], sculptor: body },
      { id: 'furnace_flame', name: '地火', position: [0, 0, 0], sculptor: flame, bone: 'bone-flame' },
    ],
    bones: [{ id: 'bone-flame', name: 'FlameCore', parent: 'ROOT_BONE', position: [cx, 6, cz] }],
    animations: [{
      id: 'ember', name: 'Ember Flicker', duration: 2.4, loop: true, channels: [
        { bone: 'bone-flame', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 0.6, value: [0, 0.5, 0] }, { time: 1.2, value: [0.22, 0.12, 0] },
          { time: 1.8, value: [0, 0.45, 0.18] }, { time: 2.4, value: [0, 0, 0] },
        ] },
        { bone: 'bone-flame', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.6, value: [1.05, 1.1, 1.05] }, { time: 1.2, value: [0.96, 0.94, 0.96] },
          { time: 1.8, value: [1.04, 1.08, 1.04] }, { time: 2.4, value: [1, 1, 1] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 仙鹤（v2 rev2 移植：贴身大翼/露腿/丹顶） */
export function inkCrane() {
  const pal = new Palette();
  const feather = spInk.ramp(pal, 'ink', 'feather', '#f4f0e4', { steps: 8, vRange: [0.66, 1.06], hueShift: 4 });
  const featherSh = spInk.ramp(pal, 'ink', 'featherShade', '#aeb6ba', { steps: 6, vRange: [0.6, 1.05] });
  const ink = spInk.ramp(pal, 'ink', 'ink', '#252a30', { steps: 6, vRange: [0.55, 1.05] });
  const crown = spInk.ramp(pal, 'ink', 'crown', '#c2352a', { steps: 4, vRange: [0.6, 1.12], emissive: 0.18, emissiveTop: 0.42 });
  const beak = spInk.ramp(pal, 'ink', 'beak', '#d8a03c', { steps: 5, vRange: [0.55, 1.1] });
  const legC = spInk.ramp(pal, 'ink', 'leg', '#3a4046', { steps: 4, vRange: [0.6, 1.05] });

  const W = 38, H = 48, D = 22;
  const main = new Sculptor(W, H, D);

  const bodySdf = sd.smoothUnion(1.8)(
    sd.ell(17, 28, 11, 8.8, 4.9, 5.3),
    sd.ell(9.5, 29.5, 11, 5.6, 3.3, 3.5),
  );
  main.fill(bodySdf, (x, y, z) => {
    const t = (y - 24) / 9;
    const n = (fbm3(x, y, z, { freq: 0.32, seed: 3 }) - 0.5) * 0.2;
    const belly = y < 26.5 && Math.abs(x - 17) < 6 ? -0.16 : 0;
    return feather(clamp01(0.4 + t * 0.52 + n + belly));
  });
  for (let i = 0; i < 3; i += 1) {
    const zy = 11 + (i - 1) * 2.3;
    main.fill(sd.polylineTube([[8.5, 29.2, zy], [2.4 + i * 0.5, 30.6 + i * 0.5, zy]], (t) => 1.8 - t * 0.6), (x, y, z) => {
      const t = (x - 2.4) / 6.4;
      return ink(clamp01(0.32 + t * 0.55 + (fbm3(x, y, z, { freq: 0.4, seed: 12 + i }) - 0.5) * 0.18));
    });
  }

  const neckPts = sd.bezier3([22, 29, 11], [28.5, 30.5, 11], [29.5, 40, 11], [25.5, 43.5, 11], 26);
  main.fill(sd.polylineTube(neckPts, (t) => 1.8 - t * 0.5), (x, y, z) => {
    const t = (y - 28) / 16;
    return feather(clamp01(0.44 + t * 0.5 + (fbm3(x, y, z, { freq: 0.4, seed: 31 }) - 0.5) * 0.16));
  });

  main.fill(sd.ell(24.6, 43.6, 11, 2.9, 2.7, 2.5), (x, y, z) => {
    const up = (y - 41.2) / 4.8;
    const toward = (x - 22) / 5.2;
    if (up + toward * 0.55 > 0.98) return crown(clamp01(0.62 + up * 0.35));
    return feather(clamp01(0.52 + up * 0.42));
  });
  for (const side of [-1, 1]) {
    main.fill(sd.ell(24.4, 44.1, 11 + side * 2.2, 0.8, 0.8, 0.8), () => ink(0.8));
  }
  main.fill(sd.polylineTube([[22.6, 43.2, 11], [19.4, 43.5, 11], [15.8, 43.9, 11]], (t) => 1.1 - t * 0.75), (x, y, z) => {
    const t = (22.6 - x) / 6.8;
    return beak(clamp01(0.78 - t * 0.5));
  });

  for (const side of [-1, 1]) {
    const lx = 16 + side * 2.6, lz = 11 + side * 1.6;
    main.fill(sd.polylineTube([[lx, 24, lz], [lx, 15.5, lz], [lx + side * 0.5, 7, lz]], (t) => 0.9 - t * 0.15), () => legC(0.7));
    main.fill(sd.ell(lx, 15.5, lz, 1.3, 1.1, 1.3), () => featherSh(0.4));
    for (const toe of [-1, 0, 1]) {
      const tx = lx + toe * 1.8 + (toe === 0 ? 1.5 : 0.3), tz = lz + Math.abs(toe) * 0.8;
      main.fill(sd.polylineTube([[lx, 6.6, lz], [tx, 5.4, tz]], (t) => 0.75 - t * 0.3), () => legC(0.78));
    }
  }

  const wingL = new Sculptor(24, 20, 7);
  const wingR = new Sculptor(24, 20, 7);
  const buildWing = (sc) => {
    for (let layer = 0; layer < 3; layer += 1) {
      const lz = 1.4 + layer * 2.4;
      const drop = layer * 1.6;
      const span = 19 - layer * 1.2;
      const a = [21, 17 - layer * 0.5, lz];
      const b = [21 - span * 0.5, 15.5 - drop * 0.5, lz];
      const c = [21 - span, 10.5 - drop, lz];
      const pts = sd.bezier3(a, b, c, [c[0] - 1.4, c[1] - 2.0, lz], 16);
      sc.fill(sd.polylineTube(pts, (t) => 3.2 - layer * 0.55 - t * (1.7 - layer * 0.2)), (x, y, z) => {
        const t = (21 - x) / span;
        if (t > 0.78) return ink(clamp01(0.35 + (t - 0.78) * 2.2));
        const rampL = layer === 0 ? feather : featherSh;
        return rampL(clamp01(0.66 - t * 0.3 + (fbm3(x, y, z, { freq: 0.45, seed: layer * 7 + 5 }) - 0.5) * 0.2));
      });
    }
    sc.repaint((x, y, z) => ((z - 1.4) % 2.4 < 0.9 && x < 18 ? featherSh(0.32) : 0), (x, y, z) => y < 16);
  };
  buildWing(wingL); buildWing(wingR);

  return {
    style: 'ink-crane', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'crane_body', name: '鹤身', position: [0, 0, 0], sculptor: main },
      { id: 'crane_wing_l', name: '左翼', position: [1, 13, 3.2], sculptor: wingL, bone: 'bone-wing-l' },
      { id: 'crane_wing_r', name: '右翼', position: [1, 13, 12.4], sculptor: wingR, bone: 'bone-wing-r' },
    ],
    bones: [
      { id: 'bone-wing-l', name: 'WingL', parent: 'ROOT_BONE', position: [22, 30, 6] },
      { id: 'bone-wing-r', name: 'WingR', parent: 'ROOT_BONE', position: [22, 30, 16] },
    ],
    animations: [{
      id: 'flap', name: 'Wing Flap', duration: 2.6, loop: true, channels: [
        { bone: 'bone-wing-l', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 0.65, value: [0, 0, 0.28, 0.96], interp: 'EASE_IN_OUT_SINE' },
          { time: 1.3, value: [0, 0, 0, 1] }, { time: 1.95, value: [0, 0, -0.14, 0.99], interp: 'EASE_IN_OUT_SINE' }, { time: 2.6, value: [0, 0, 0, 1] },
        ] },
        { bone: 'bone-wing-r', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 0.65, value: [0, 0, -0.28, 0.96], interp: 'EASE_IN_OUT_SINE' },
          { time: 1.3, value: [0, 0, 0, 1] }, { time: 1.95, value: [0, 0, 0.14, 0.99], interp: 'EASE_IN_OUT_SINE' }, { time: 2.6, value: [0, 0, 0, 1] },
        ] },
      ],
    }],
    pivot: [17, 0, 11],
  };
}

/** 剑冢石碑（v2 rev2 移植：悬浮飞剑自动焊接演示位） */
export function inkStele() {
  const pal = new Palette();
  const stone = spInk.ramp(pal, 'ink', 'steleStone', '#6a7178', { steps: 9, vRange: [0.52, 1.08], hueShift: -4 });
  const stoneD = spInk.ramp(pal, 'ink', 'steleStoneDark', '#3e4349', { steps: 5, vRange: [0.6, 1.05] });
  const moss = spInk.ramp(pal, 'ink', 'steleMoss', '#5c7a52', { steps: 4, vRange: [0.55, 1.0] });
  const gold = spInk.ramp(pal, 'ink', 'gold', '#d9a441', { steps: 6, vRange: [0.55, 1.15] });
  const blade = spInk.ramp(pal, 'ink', 'blade', '#cfdce6', { steps: 6, vRange: [0.62, 1.1], emissive: 0.05, emissiveTop: 0.18 });
  const rune = spInk.ramp(pal, 'ink', 'rune', '#63e0d0', { steps: 4, vRange: [0.6, 1.1], emissive: 0.5, emissiveTop: 0.95 });
  const jade = spInk.ramp(pal, 'ink', 'jade', '#5fbe8f', { steps: 4, vRange: [0.6, 1.05], emissive: 0.25, emissiveTop: 0.5 });
  const cord = spInk.ramp(pal, 'ink', 'cord', '#a83c34', { steps: 4, vRange: [0.6, 1.1] });

  const W = 22, H = 44, D = 13;
  const main = new Sculptor(W, H, D);

  main.fill(sd.roundBox(11, 1.4, 6.5, 9.5, 1.4, 5.5, 0.6), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 2 }) - 0.5) * 0.24;
    if (fbm3(x, y, z, { freq: 0.13, seed: 6 }) > 0.6 && y < 3) return moss(clamp01(0.5 + n));
    return stone(clamp01(0.2 + (y / 5) * 0.3 + n));
  });
  main.fill(sd.roundBox(11, 3.6, 6.5, 7.5, 1.1, 4.4, 0.5), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 2 }) - 0.5) * 0.24;
    if (fbm3(x, y, z, { freq: 0.13, seed: 6 }) > 0.62 && y < 3.4) return moss(clamp01(0.5 + n));
    return stone(clamp01(0.45 + (y / 5) * 0.3 + n));
  });

  const steleSdf = (x, y, z) => {
    const t = clamp01((y - 5) / 26);
    const hw = 3.6 - t * 1.15, hd = 1.9 - t * 0.4;
    const dx = Math.abs(x - 11) - hw, dz = Math.abs(z - 6.5) - hd, dy = 5 - y;
    return Math.hypot(Math.max(dx, 0), Math.max(dz, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, Math.max(dz, dy)), 0);
  };
  main.fill(steleSdf, (x, y, z) => {
    const t = (y - 5) / 26;
    const n = (fbm3(x, y, z, { freq: 0.25, seed: 13 }) - 0.5) * 0.24;
    const m = fbm3(x, y, z, { freq: 0.1, seed: 17 });
    if (m > 0.64 && (y < 13 || m > 0.74)) return moss(clamp01(0.35 + (m - 0.6) * 3 + n));
    return stone(clamp01(0.32 + t * 0.54 + n));
  });
  main.fill(sd.roundBox(11, 32.5, 6.5, 4.3, 1.5, 2.6, 0.7), (x, y, z) => stone(clamp01(0.55 + (y - 31) / 6 + (fbm3(x, y, z, { freq: 0.3, seed: 23 }) - 0.5) * 0.2)));
  main.fill(sd.roundBox(11, 34.6, 6.5, 2.6, 0.9, 1.9, 0.6), () => stoneD(0.6));
  for (const side of [-1, 1]) {
    main.fill(sd.polylineTube([[11 + side * 4.0, 32.6, 6.5], [11 + side * 5.2, 35.0, 6.5]], (t) => 1.15 - t * 0.35), () => stoneD(0.7));
  }

  // 碑面刻字（金框描边）
  main.repaint((x, y, z) => {
    const col = x < 11 ? 0 : 1;
    const cxp = col === 0 ? 8.6 : 13.4;
    const rowIdx = Math.floor((28.4 - y) / 3.4);
    if (rowIdx < 0 || rowIdx > 4) return 0;
    if (Math.abs(x - cxp) > 2.1) return 0;
    const cellSeed = col * 31 + rowIdx * 7 + 3;
    const lx = x - (cxp - 2.1), ly = (28.4 - y) - rowIdx * 3.4;
    const strokeV = valueNoise3(lx * 0.9, ly * 0.9, cellSeed, cellSeed * 13);
    const frame = Math.abs(lx - 2.1) < 0.7 || Math.abs(ly - 1.7) < 0.7;
    if (frame) return stoneD(0.5);
    return strokeV > 0.52 ? gold(0.55 + strokeV * 0.35) : 0;
  }, (x, y, z) => z >= 8 && y > 11.5 && y < 29.5 && steleSdf(x + 0.5, y + 0.5, z + 0.5) < 0.5);

  // 悬浮飞剑（独立组，动画浮动）
  const sword = new Sculptor(9, 30, 7);
  sword.fill(sd.polylineTube([[4.5, 5.4, 3.5], [3.3, 3.4, 3.3], [4.4, 0.9, 3.6]], (t) => 0.95 - t * 0.45),
    (x, y, z) => cord(clamp01(0.5 + (hash3(x, y, z, 9) - 0.5) * 0.4)));
  sword.fill(sd.torusY(4.5, 5.8, 3.5, 1.15, 0.5), () => jade(0.6));
  sword.fill(sd.cylinderY(4.5, 3.5, 6.6, 9.4, 1.0), (x, y, z) => ((y % 1.6) < 0.8 ? cord(0.7) : cord(0.4)));
  sword.fill(sd.roundBox(4.5, 9.9, 3.5, 3.0, 0.7, 1.0, 0.35), (x, y, z) => gold(clamp01(0.6 + (fbm3(x, y, z, { freq: 0.5, seed: 41 }) - 0.5) * 0.2)));
  const bladeSdf = (x, y, z) => {
    const t = (y - 10.6) / 14;
    const hw = 1.35 - t * 0.5;
    const mid = Math.abs(x - 4.5) - hw, dz = Math.abs(z - 3.5) - 0.55;
    const d = Math.hypot(Math.max(mid, 0), Math.max(dz, 0)) + Math.min(Math.max(mid, dz), 0);
    return Math.min(d, sd.ell(4.5, 25.8, 3.5, 1.1, 2.4, 0.6)(x, y, z));
  };
  sword.fill(bladeSdf, (x, y, z) => {
    const edge = Math.abs(x - 4.5) > 0.75 || Math.abs(z - 3.5) > 0.35;
    const t = (y - 10.6) / 14;
    const n = (fbm3(x, y, z, { freq: 0.5, seed: 51 }) - 0.5) * 0.18;
    if (edge) return blade(clamp01(0.9 + n * 0.5));
    if (Math.abs(x - 4.5) < 0.5) return blade(0.44 + t * 0.2);
    return blade(clamp01(0.64 + t * 0.3 + n));
  });

  // 碑侧剑气符文（发光，独立组）
  const runes = new Sculptor(W, 30, D);
  for (const side of [-1, 1]) {
    const rx = 11 + side * 4.0;
    for (let i = 0; i < 5; i += 1) {
      const y0 = 8 + i * 4.2;
      if (hash3(i, side, 1, 77) < 0.25) continue;
      runes.fill(sd.polylineTube(
        [[rx + side * (i % 2) * 0.9, y0, 6.5], [rx + side * ((i + 1) % 2) * 0.9, y0 + 2.6, 6.5]],
        (t) => 0.62 - t * 0.3,
      ), (x, y, z) => rune(clamp01(0.4 + (y - y0) / 5 + (fbm3(x, y, z, { freq: 0.6, seed: 3 }) - 0.5) * 0.3)));
    }
  }

  return {
    style: 'ink-stele', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'stele_body', name: '石碑', position: [0, 0, 0], sculptor: main },
      { id: 'stele_sword', name: '飞剑', position: [6.5, 7.5, 3.0], sculptor: sword, bone: 'bone-sword' },
      { id: 'stele_runes', name: '剑气', position: [0, 0, 0], sculptor: runes, bone: 'bone-runes' },
    ],
    bones: [
      { id: 'bone-sword', name: 'FlyingSword', parent: 'ROOT_BONE', position: [11, 7.5, 6.5] },
      { id: 'bone-runes', name: 'SwordQi', parent: 'ROOT_BONE', position: [11, 0, 6.5] },
    ],
    animations: [{
      id: 'float', name: 'Sword Float', duration: 3.6, loop: true, channels: [
        { bone: 'bone-sword', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 1.8, value: [0, 1.1, 0], interp: 'EASE_IN_OUT_SINE' }, { time: 3.6, value: [0, 0, 0] },
        ] },
        { bone: 'bone-sword', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 1.8, value: [0, 0, 0.08, 0.997] }, { time: 3.6, value: [0, 0, 0, 1] },
        ] },
        { bone: 'bone-runes', path: 'alpha', keyframes: [
          { time: 0, value: 1 }, { time: 0.9, value: 0.45 }, { time: 1.8, value: 1 }, { time: 2.7, value: 0.5 }, { time: 3.6, value: 1 },
        ] },
      ],
    }],
    pivot: [11, 0, 6.5],
  };
}

/** 云海飞舟（v2 rev2 移植：云座嵌船底/冲角/花窗对齐） */
export function inkBoat() {
  const pal = new Palette();
  const wood = spInk.ramp(pal, 'ink', 'boatWood', '#7c5836', { steps: 8, vRange: [0.5, 1.1], hueShift: -5 });
  const woodD = spInk.ramp(pal, 'ink', 'boatWoodDark', '#4e3a24', { steps: 5, vRange: [0.55, 1.0] });
  const redC = spInk.ramp(pal, 'ink', 'boatRed', '#a63b32', { steps: 6, vRange: [0.5, 1.1] });
  const gold = spInk.ramp(pal, 'ink', 'gold', '#d9a441', { steps: 5, vRange: [0.55, 1.12] });
  const canvas = spInk.ramp(pal, 'ink', 'canvas', '#ece5d3', { steps: 7, vRange: [0.62, 1.06], hueShift: 5 });
  const cloud = spInk.ramp(pal, 'ink', 'cloud', '#e8edf2', { steps: 6, vRange: [0.55, 1.05] });
  const lanternGlow = spInk.ramp(pal, 'ink', 'lantern', '#ffb03a', { steps: 4, vRange: [0.7, 1.1], emissive: 0.75, emissiveTop: 1.0 });

  const W = 52, H = 28, D = 20, cz = 10;
  const hull = new Sculptor(W, H, D);

  const riseAt = (x) => Math.max(0, (Math.abs(x - 25) - 15) / 8.5) ** 1.6 * 5.2;
  const beamAt = (x) => 5.6 * Math.sqrt(Math.max(0, 1 - ((x - 25) / 24) ** 2)) + 1.1;
  const keelY = (x, z) => {
    const t = Math.abs(z - cz) / beamAt(x);
    return 9.5 + riseAt(x) - 3.4 * Math.sqrt(Math.max(0, 1 - t * t));
  };
  hull.fill((x, y, z) => {
    const bx = x - 0.5, bz = z - 0.5;
    if (bx < 3 || bx > W - 3.5) return 1;
    if (Math.abs(bz - cz) > beamAt(bx) - 0.6) return 1;
    return (y - 0.5 > keelY(bx, bz) && y - 0.5 < 14.5 + riseAt(bx)) ? -1 : 1;
  }, (x, y, z) => {
    const t = (y - 8) / 8;
    const plank = ((Math.floor((x - 2) / 3.2) + Math.floor(y)) % 2) === 0 ? 0.06 : -0.04;
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 5 }) - 0.5) * 0.18;
    if (y >= 13 && y <= 14) return redC(clamp01(0.55 + n));
    if (y >= 12.2 && y < 13) return gold(0.66 + n);
    if (y < 11) return woodD(clamp01(0.5 + n));
    return wood(clamp01(0.42 + t * 0.4 + plank + n));
  });
  hull.carve((x, y, z) => {
    const bx = x - 0.5, bz = z - 0.5;
    if (bx < 6 || bx > W - 6 || y < 10.5 || y > 12.6) return 1;
    if (Math.abs(bz - cz) > beamAt(bx) - 2.4) return 1;
    return -1;
  });
  // 船首冲角 + 船尾舵
  hull.fill(sd.polylineTube([[47.0, 16.0, cz], [50.8, 18.9, cz]], (t) => 2.0 - t * 1.15), (x, y, z) => gold(clamp01(0.6 + (y - 16) / 5)));
  for (let i = 0; i < 3; i += 1) {
    hull.fill(sd.roundBox(4.6, 15.5, cz + (i - 1) * 1.7, 0.9, 1.7, 0.75, 0.3), () => woodD(0.6));
  }

  // 船楼 + 花窗 + 歇山顶
  hull.fill(sd.roundBox(17, 18.2, cz, 8.5, 3.2, 5.2, 0.4), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.32, seed: 15 }) - 0.5) * 0.18;
    if (Math.abs(x % 3.4 - 1.7) < 0.55) return woodD(clamp01(0.55 + n));
    return redC(clamp01(0.5 + (y - 15) / 7 + n));
  });
  for (let i = 0; i < 3; i += 1) {
    for (const side of [-1, 1]) {
      hull.fill(sd.roundBox(12.6 + i * 4.4, 18.4, cz + side * 5.3, 1.15, 1.5, 0.55, 0.5), (x, y, z) => {
        const r = Math.hypot(x - (12.6 + i * 4.4), y - 18.4);
        return r > 0.85 ? gold(0.7) : woodD(0.35);
      });
    }
  }
  const roofBase = 21.4;
  hull.fill((x, y, z) => {
    const rx = x - 0.5, ry = y - 0.5, rz = z - 0.5;
    if (rx < 7.5 || rx > 26.5) return 1;
    const yy = roofBase + 2.6 * (1 - Math.abs(rz - cz) / 5.9);
    return (ry > yy - 1.5 && ry < yy + 0.6) ? -1 : 1;
  }, (x, y, z) => {
    const dz = Math.abs(z - cz);
    const alt = Math.floor(dz * 1.35) % 2 === 0 ? 0.05 : -0.05;
    const n = (fbm3(x, y, z, { freq: 0.35, seed: 25 }) - 0.5) * 0.14;
    return redC(clamp01(0.44 + (1 - dz / 6) * 0.4 + alt + n));
  });
  hull.fill(sd.roundBox(17, roofBase + 2.75, cz, 9.6, 0.55, 0.75, 0.25), () => gold(0.7));
  for (const side of [-1, 1]) {
    hull.fill(sd.polylineTube([[17 + side * 9.8, roofBase + 2.2, cz], [17 + side * 10.9, roofBase + 4.1, cz]], (t) => 0.85 - t * 0.25), () => redC(0.75));
  }
  // 桅杆 + 灯笼
  hull.fill(sd.cylinderY(35.5, cz, 14, 26.5, 1.0), (x, y, z) => (Math.floor(y / 2.6) % 2 ? wood(0.55) : wood(0.4)));
  for (const [lx, ly] of [[45.5, 18.4], [5.6, 18.8], [28.5, roofBase + 3.6]]) {
    hull.fill(sd.ell(lx, ly, cz, 1.4, 1.6, 1.4), (x, y, z) => {
      const r = Math.hypot(x - lx, (y - ly) * 0.85, z - cz);
      return r < 0.95 ? lanternGlow(0.95) : lanternGlow(0.5);
    });
    hull.fill(sd.cylinderY(lx, cz, ly + 1.7, ly + 2.6, 0.4), () => woodD(0.6));
  }

  // 云帆（鼓风曲面 + 云纹装饰带）
  const sail = new Sculptor(16, 16, 6);
  sail.fill((x, y, z) => {
    if (x < 1.5 || x > 14.5 || y < 1.5 || y > 14.5) return 1;
    const billow = 1.9 * Math.sin(((x - 1.5) / 13) * Math.PI) * Math.sin(((y - 1.5) / 13) * Math.PI);
    return Math.abs(z - 3 - billow) < 0.85 ? -1 : 1;
  }, (x, y, z) => {
    const t = (y - 1) / 13;
    const n = (fbm3(x, y, z, { freq: 0.4, seed: 35 }) - 0.5) * 0.16;
    if (cloudMask((x - 1.5) / 13, (y - 1.5) / 13, { seed: 5 }) && x > 3 && x < 13) return canvas(clamp01(0.34 + n * 0.4));
    const rib = Math.floor(x / 3.2) % 2 === 0 ? 0.04 : 0;
    return canvas(clamp01(0.55 + t * 0.35 + rib + n));
  });

  // 踏云云座
  const cloudbase = new Sculptor(46, 13, 18);
  cloudbase.fill((x, y, z) => {
    const nx = (x - 23) / 20, nz = (z - 9) / 7.5, ny = (y - 4.2) / 6.0;
    return nx * nx + nz * nz + ny * ny - 1 + (fbm3(x, y, z, { freq: 0.14, seed: 45 }) - 0.5) * 0.9;
  }, (x, y, z) => cloud(clamp01(0.35 + (y / 10) * 0.6 + (fbm3(x, y, z, { freq: 0.3, seed: 46 }) - 0.5) * 0.2)));
  for (let i = 0; i < 3; i += 1) {
    cloudbase.fill(sd.polylineTube(
      [[8 + i * 3, 5.2, 9 + (i - 1) * 3], [3 + i * 2, 3.8, 9 + (i - 1) * 3.5], [-2 + i, 5.6, 9 + (i - 1) * 4]],
      (t) => 1.5 - t * 1.0,
    ), () => cloud(0.55));
  }

  return {
    style: 'ink-boat', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'boat_hull', name: '船身', position: [0, 0, 0], sculptor: hull },
      { id: 'boat_sail', name: '云帆', position: [27, 14.5, 8], sculptor: sail, bone: 'bone-sail' },
      { id: 'boat_cloud', name: '踏云', position: [3, 0, 1], sculptor: cloudbase, bone: 'bone-cloud' },
    ],
    bones: [
      { id: 'bone-sail', name: 'CloudSail', parent: 'ROOT_BONE', position: [35.5, 14.5, 10] },
      { id: 'bone-cloud', name: 'CloudBase', parent: 'ROOT_BONE', position: [26, 0, 10] },
    ],
    animations: [{
      id: 'bob', name: 'Cloud Bob', duration: 4.0, loop: true, channels: [
        { bone: 'bone-cloud', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 2.0, value: [0.4, 0.8, 0], interp: 'EASE_IN_OUT_SINE' }, { time: 4.0, value: [0, 0, 0] },
        ] },
        { bone: 'bone-cloud', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 2.0, value: [0, 0, 0.035, 0.9994] }, { time: 4.0, value: [0, 0, 0, 1] },
        ] },
        { bone: 'bone-sail', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 1.0, value: [1.06, 0.97, 1.06] }, { time: 2.0, value: [0.97, 1.04, 1.02] },
          { time: 3.0, value: [1.05, 0.98, 1.05] }, { time: 4.0, value: [1, 1, 1] },
        ] },
      ],
    }],
    pivot: [25, 0, 10],
  };
}

/* ============================== HITECH ============================== */

const spHitech = new SeriesPalette();

/** 能量塔：22×46×22，三角格构塔身 + 发光芯柱，核心脉动 */
export function hitechPylon() {
  const pal = new Palette();
  const hull = spHitech.ramp(pal, 'hitech', 'hull', '#8a97a4', { steps: 7, vRange: [0.55, 1.1], hueShift: -4 });
  const hullD = spHitech.ramp(pal, 'hitech', 'hullDark', '#3f4a54', { steps: 5, vRange: [0.6, 1.0] });
  const energy = spHitech.ramp(pal, 'hitech', 'energy', '#48e0ff', { steps: 6, vRange: [0.6, 1.2], emissive: 0.7, emissiveTop: 1.0 });
  const metal = spHitech.ramp(pal, 'hitech', 'trim', '#d9a441', { steps: 5, vRange: [0.6, 1.1] });
  const panel = spHitech.ramp(pal, 'hitech', 'panel', '#2a5a78', { steps: 4, vRange: [0.55, 1.0] });
  const light = spHitech.ramp(pal, 'hitech', 'beacon', '#ff5a3a', { steps: 3, vRange: [0.75, 1.1], emissive: 0.9, emissiveTop: 1.0 });

  const W = 22, H = 46, D = 22, cx = 11, cz = 11;
  const frame = new Sculptor(W, H, D);
  // 底座
  frame.fill(sd.cylinderY(cx, cz, 0, 4.2, 8.6), (x, y, z) => hullD(clamp01(0.45 + y / 8 + (hash3(x, y, z, 3) - 0.5) * 0.14)));
  frame.fill(sd.cylinderY(cx, cz, 4.2, 5.4, 6.8), (x, y, z) => metal(0.6));
  // 三根格构立柱（向中收拢）
  for (let i = 0; i < 3; i += 1) {
    const ang = (i / 3) * TAU + 0.4;
    const bx = cx + Math.cos(ang) * 6.2, bz = cz + Math.sin(ang) * 6.2;
    const tx = cx + Math.cos(ang) * 1.6, tz = cz + Math.sin(ang) * 1.6;
    frame.fill(sd.polylineTube([[bx, 5, bz], [(bx + tx) / 2, 21, (bz + tz) / 2], [tx, 37, tz]], (t) => 1.5 - t * 0.6),
      (x, y, z) => hull(clamp01(0.4 + y / 44 + dither(x, y, z, 5))));
  }
  // 水平撑杆（环形阵列）
  for (const [y, r] of [[12, 5.4], [20, 4.2], [28, 3.0]]) {
    const ring = radialArray(3, cx, cz, (ang, i) => sd.capsule(
      cx + Math.cos(ang) * r, y, cz + Math.sin(ang) * r,
      cx + Math.cos(ang + TAU / 3) * r, y, cz + Math.sin(ang + TAU / 3) * r, 0.6,
    ), { phase: 0.4 });
    frame.fill(ring, (x, y2, z) => hullD(0.66));
  }
  // 中央脊柱（锚定能量芯）
  frame.fill(sd.cylinderY(cx, cz, 5, 37, 1.2), (x, y, z) => hullD(0.62));
  // 顶帆板（两片，panel 色）
  for (const side of [-1, 1]) {
    frame.fill(sd.roundBox(cx, 40.2, cz + side * 3.4, 2.6, 2.4, 2.2, 0.3), (x, y, z) => panel(clamp01(0.5 + (y - 38) / 5)));
  }
  frame.fill(sd.capsule(cx, 42.8, cz, cx, 45.4, cz, 0.5), () => metal(0.8));
  frame.fill(sd.ell(cx, 45.6, cz, 0.8, 0.8, 0.8), () => light(1.0));
  // 检修平台
  frame.fill(sd.cylinderY(cx, cz, 18.4, 19.4, 4.4), (x, y, z) => hullD(0.7));

  const core = new Sculptor(10, 34, 10);
  core.fill(sd.cylinderY(5, 5, 0, 30, 2.1), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.4, seed: 15 }) - 0.5) * 0.3;
    return energy(clamp01(0.45 + (y / 30) * 0.5 + n));
  });
  core.fill(sd.ell(5, 30.8, 5, 2.4, 2.4, 2.4), (x, y, z) => energy(0.95));
  // 能量环（三道）
  for (const y of [6, 15, 24]) {
    core.fill(sd.torusY(5, y, 5, 3.0, 0.7), (x, y2, z) => energy(0.8));
  }

  return {
    style: 'hitech-pylon', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'pylon_frame', name: '塔架', position: [0, 0, 0], sculptor: frame },
      { id: 'pylon_core', name: '能量芯', position: [cx - 5, 7, cz - 5], sculptor: core, bone: 'bone-core' },
    ],
    bones: [{ id: 'bone-core', name: 'EnergyCore', parent: 'ROOT_BONE', position: [cx, 7, cz] }],
    animations: [{
      id: 'pulse', name: 'Core Pulse', duration: 2.8, loop: true, channels: [
        { bone: 'bone-core', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.7, value: [1.08, 1.04, 1.08] }, { time: 1.4, value: [0.96, 0.98, 0.96] }, { time: 2.8, value: [1, 1, 1] },
        ] },
        { bone: 'bone-core', path: 'alpha', keyframes: [
          { time: 0, value: 1 }, { time: 1.4, value: 0.75 }, { time: 2.8, value: 1 },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 悬浮摩托：30×12×12，悬浮环 + 尾鳍，上下浮动 */
export function hitechHoverbike() {
  const pal = new Palette();
  const shell = spHitech.ramp(pal, 'hitech', 'shell', '#c8542e', { steps: 7, vRange: [0.5, 1.1], hueShift: 5 });
  const shellD = spHitech.ramp(pal, 'hitech', 'shellDark', '#5a2a20', { steps: 5, vRange: [0.6, 1.0] });
  const seat = spHitech.ramp(pal, 'hitech', 'seat', '#2e3338', { steps: 4, vRange: [0.6, 1.0] });
  const glow = spHitech.ramp(pal, 'hitech', 'glow', '#48e0ff', { steps: 5, vRange: [0.6, 1.2], emissive: 0.8, emissiveTop: 1.0 });
  const chrome = spHitech.ramp(pal, 'hitech', 'chrome', '#c8d2da', { steps: 5, vRange: [0.6, 1.1] });
  const trim = spHitech.ramp(pal, 'hitech', 'accent', '#d9a441', { steps: 4, vRange: [0.6, 1.1] });

  const W = 30, H = 12, D = 12, cy = 7, cz = 6;
  const main = new Sculptor(W, H, D);
  // 主艇身（前尖后宽）
  main.fill(sd.smoothUnion(1.4)(
    sd.ell(13, cy, cz, 9.6, 2.5, 3.1),
    sd.ell(21.5, cy + 0.4, cz, 4.6, 1.7, 2.1),
    sd.roundBox(7.5, cy + 0.2, cz, 4.2, 1.8, 2.6, 0.8),
  ), (x, y, z) => {
    const t = clamp01((y - 4.4) / 5.2);
    const n = dither(x, y, z, 5);
    if (y < 5.6) return shellD(clamp01(0.5 + t + n));
    return shell(clamp01(0.42 + t * 0.55 + n));
  });
  // 座舱凹槽 + 座垫
  main.fill(sd.roundBox(11.5, cy + 1.6, cz, 3.6, 0.7, 1.9, 0.5), (x, y, z) => seat(0.55 + dither(x, y, z, 7)));
  // 把手（前伸上翘）
  main.fill(sd.polylineTube([[21.8, cy + 1.2, cz], [25.6, cy + 2.6, cz]], (t) => 0.7), () => chrome(0.75));
  for (const side of [-1, 1]) {
    main.fill(sd.polylineTube([[25.6, cy + 2.6, cz], [26.8, cy + 2.2, cz + side * 2.6]], (t) => 0.6), (x, y, z) => grip(0.7));
  }
  function grip() { return trim(0.75); } // 简单把手色
  // 尾鳍
  main.fill((x, y, z) => {
    const t = clamp01((7.5 - x) / 9);
    const dy = Math.abs(y - (cy + 1.5 + t * 2.6));
    return Math.max(Math.abs(x - 5.5) - 3.6, dy - (1.9 - t * 1.1), Math.abs(z - cz) - 0.55);
  }, (x, y, z) => {
    const t = clamp01((7.5 - x) / 9);
    return shell(clamp01(0.55 + t * 0.4));
  });
  // 尾喷口（发光）
  main.fill(sd.cylinderY(3.4, cz, cy - 0.8, cy + 1.2, 1.3), (x, y, z) => glow(0.85));
  main.fill(sd.ell(2.9, cy + 0.2, cz, 0.9, 1.1, 1.1), () => glow(1.0));
  // 两侧导流槽（金饰条）
  for (const side of [-1, 1]) {
    main.fill(sd.polylineTube([[6, cy + 1.4, cz + side * 3.0], [19, cy + 1.0, cz + side * 3.1]], (t) => 0.45), () => trim(0.8));
  }
  // 悬浮环（前后两个，发光，独立组）
  const pads = new Sculptor(W, 6, D);
  for (const px of [8.5, 21]) {
    pads.fill(sd.torusY(px, 1.6, cz, 3.0, 0.9), (x, y, z) => glow(clamp01(0.55 + (1.6 - y) * 0.2)));
  }

  return {
    style: 'hitech-hoverbike', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'bike_body', name: '艇身', position: [0, 0, 0], sculptor: main, bone: 'bone-bike' },
      { id: 'bike_pads', name: '悬浮环', position: [0, 2.2, 0], sculptor: pads, bone: 'bone-bike' },
    ],
    bones: [{ id: 'bone-bike', name: 'HoverRoot', parent: 'ROOT_BONE', position: [14, 7, cz] }],
    animations: [{
      id: 'hover', name: 'Hover Bob', duration: 3.0, loop: true, channels: [
        { bone: 'bone-bike', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 1.5, value: [0, 0.9, 0], interp: 'EASE_IN_OUT_SINE' }, { time: 3.0, value: [0, 0, 0] },
        ] },
        { bone: 'bone-bike', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.75, value: [1.02, 0.96, 1.0] }, { time: 1.5, value: [1, 1, 1] },
          { time: 2.25, value: [1.02, 0.96, 1.0] }, { time: 3.0, value: [1, 1, 1] },
        ] },
      ],
    }],
    pivot: [14, 0, cz],
  };
}

/** 巡逻机：26×12×26，碟身 + 四推进器 + 传感眼，自旋 */
export function hitechDrone() {
  const pal = new Palette();
  const shell = spHitech.ramp(pal, 'hitech', 'droneShell', '#9aa7b4', { steps: 7, vRange: [0.55, 1.1] });
  const shellD = spHitech.ramp(pal, 'hitech', 'droneShellDark', '#454e58', { steps: 5, vRange: [0.6, 1.0] });
  const eye = spHitech.ramp(pal, 'hitech', 'eye', '#ff5a3a', { steps: 4, vRange: [0.7, 1.15], emissive: 0.85, emissiveTop: 1.0 });
  const thrust = spHitech.ramp(pal, 'hitech', 'thrust', '#48e0ff', { steps: 5, vRange: [0.6, 1.2], emissive: 0.7, emissiveTop: 1.0 });
  const metal = spHitech.ramp(pal, 'hitech', 'frame', '#d9a441', { steps: 4, vRange: [0.6, 1.1] });
  const stripe = spHitech.ramp(pal, 'hitech', 'stripe', '#2a5a78', { steps: 4, vRange: [0.55, 1.0] });

  const W = 26, H = 12, D = 26, cx = 13, cy = 6, cz = 13;
  const main = new Sculptor(W, H, D);
  // 碟形机身
  main.fill((x, y, z) => {
    const r = Math.hypot((x - cx) / 9.2, (z - cz) / 9.2);
    const dome = (y - (cy + 1.2)) / 2.6;
    const under = (y - (cy - 0.6)) / 2.2;
    return Math.max(r + Math.max(0, dome) - 1, r + Math.max(0, -under) * 1.2 - 1, Math.abs(dome) * 0.4 + r * 0.4 - 0.72);
  }, (x, y, z) => {
    const n = dither(x, y, z, 5);
    if (y > cy + 1.4) return shell(clamp01(0.7 + n));
    if (y < cy - 0.2) return shellD(clamp01(0.5 + n));
    const ang = Math.atan2(z - cz, x - cx);
    const seg = Math.floor((ang + Math.PI) / (TAU / 12)) % 3;
    return seg === 0 ? stripe(0.66) : seg === 1 ? shell(0.62) : shell(0.82);
  });
  // 座舱罩 + 传感眼（朝 +x）
  main.fill(sd.ell(cx + 4.4, cy + 1.6, cz, 2.6, 1.7, 2.6), (x, y, z) => shell(0.85));
  main.fill(sd.ell(cx + 6.4, cy + 1.4, cz, 1.2, 1.0, 1.6), () => eye(0.95));
  // 四臂 + 推进器
  const arms = radialArray(4, cx, cz, (ang) => sd.polylineTube(
    [[cx, cy - 0.6, cz], [cx + Math.cos(ang) * 6.0, cy - 0.9, cz + Math.sin(ang) * 6.0]], (t) => 1.1 - t * 0.25,
  ));
  main.fill(arms, (x, y, z) => metal(0.7));
  for (let i = 0; i < 4; i += 1) {
    const ang = (i / 4) * TAU;
    const px = cx + Math.cos(ang) * 7.4, pz = cz + Math.sin(ang) * 7.4;
    main.fill(sd.cylinderY(px, pz, cy - 2.6, cy - 0.6, 1.5), (x, y, z) => shellD(0.66 + dither(x, y, z, 9)));
    main.fill(sd.cylinderY(px, pz, cy - 3.4, cy - 2.4, 1.1), (x, y, z) => thrust(clamp01(0.55 + (cy - 2.4 - y) / 1.2)));
  }
  // 天线
  main.fill(sd.capsule(cx, cy + 3.4, cz, cx, cy + 5.4, cz, 0.4), () => metal(0.8));
  main.fill(sd.ell(cx, cy + 5.6, cz, 0.6, 0.6, 0.6), () => thrust(0.9));

  return {
    style: 'hitech-drone', natural: [W, H, D], palette: pal,
    groups: [{ id: 'drone_body', name: '机身', position: [0, 0, 0], sculptor: main, bone: 'bone-drone' }],
    bones: [{ id: 'bone-drone', name: 'DroneRoot', parent: 'ROOT_BONE', position: [cx, cy, cz] }],
    animations: [{
      id: 'patrol', name: 'Patrol Spin', duration: 8.0, loop: true, channels: [
        { bone: 'bone-drone', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 8.0, value: [0, -1, 0, 0] },
        ] },
        { bone: 'bone-drone', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 4.0, value: [0, 0.5, 0], interp: 'EASE_IN_OUT_SINE' }, { time: 8.0, value: [0, 0, 0] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 轨道站：44×26×44，中枢 + 环轨 + 太阳能翼，环旋转 */
export function hitechStation() {
  const pal = new Palette();
  const hull = spHitech.ramp(pal, 'hitech', 'stationHull', '#aab6c2', { steps: 8, vRange: [0.55, 1.1] });
  const hullD = spHitech.ramp(pal, 'hitech', 'stationHullDark', '#46505a', { steps: 5, vRange: [0.6, 1.0] });
  const panel = spHitech.ramp(pal, 'hitech', 'solar', '#2a5a9a', { steps: 6, vRange: [0.5, 1.05] });
  const glow = spHitech.ramp(pal, 'hitech', 'window', '#ffd98a', { steps: 5, vRange: [0.7, 1.1], emissive: 0.8, emissiveTop: 1.0 });
  const metal = spHitech.ramp(pal, 'hitech', 'girder', '#d9a441', { steps: 4, vRange: [0.6, 1.1] });
  const light = spHitech.ramp(pal, 'hitech', 'nav', '#ff5a3a', { steps: 3, vRange: [0.75, 1.1], emissive: 0.9, emissiveTop: 1.0 });

  const W = 44, H = 26, D = 44, cx = 22, cy = 13, cz = 22;
  // 中枢 + 脊柱（静态）
  const hub = new Sculptor(W, H, D);
  hub.fill(sd.ell(cx, cy, cz, 5.2, 4.6, 5.2), (x, y, z) => {
    const n = dither(x, y, z, 3);
    return hull(clamp01(0.5 + (y - cy) / 10 + n));
  });
  hub.fill(sd.cylinderY(cx, cz, 2, 24, 1.4), (x, y, z) => metal(0.7));
  hub.fill(sd.ell(cx, 24.4, cz, 2.0, 1.6, 2.0), () => light(1.0));
  // 对接臂（±x）+ 太阳能翼
  for (const side of [-1, 1]) {
    hub.fill(sd.capsule(cx + side * 4.5, cy, cz, cx + side * 11.5, cy, cz, 1.0), (x, y, z) => hullD(0.66));
    hub.fill(sd.roundBox(cx + side * 16.6, cy, cz, 4.6, 0.35, 6.4, 0.3), (x, y, z) => {
      const cell = (Math.floor((x - cx) / 2.1) + Math.floor((z - cz) / 2.1)) % 2 === 0 ? 0.1 : -0.05;
      return panel(clamp01(0.55 + cell + dither(x, y, z, 7)));
    });
    hub.fill(sd.roundBox(cx + side * 16.6, cy, cz, 4.6, 0.5, 0.4, 0.2), () => metal(0.75));
  }
  // 舷窗带（环向）
  const wins = radialArray(10, cx, cz, (ang) => sd.ell(cx + Math.cos(ang) * 5.4, cy, cz + Math.sin(ang) * 5.4, 0.55, 0.8, 0.55));
  hub.fill(wins, () => glow(0.95));

  // 环轨（独立组，旋转）
  const ring = new Sculptor(W, 8, D);
  ring.fill(sd.torusY(cx, 3.5, cz, 13.2, 1.7), (x, y, z) => {
    const ang = Math.atan2(z - cz, x - cx);
    const n = dither(x, y, z, 9);
    if (Math.floor((ang + Math.PI) / (TAU / 16)) % 4 === 0) return glow(0.9); // 环上舱段灯
    return hull(clamp01(0.52 + (y - 3) / 5 + n));
  });
  ring.fill(sd.torusY(cx, 3.5, cz, 13.2, 0.6), () => hullD(0.6)); // 环下缘
  // 环连接辐条
  ring.fill(radialArray(4, cx, cz, (ang) => sd.capsule(
    cx, 3.5, cz, cx + Math.cos(ang) * 12.4, 3.5, cz + Math.sin(ang) * 12.4, 0.7,
  )), () => metal(0.7));

  return {
    style: 'hitech-station', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'station_hub', name: '中枢', position: [0, 0, 0], sculptor: hub },
      { id: 'station_ring', name: '环轨', position: [0, cy - 3.5, 0], sculptor: ring, bone: 'bone-ring' },
    ],
    bones: [{ id: 'bone-ring', name: 'HabitatRing', parent: 'ROOT_BONE', position: [cx, cy, cz] }],
    animations: [{
      id: 'spin', name: 'Ring Spin', duration: 12.0, loop: true, channels: [
        { bone: 'bone-ring', path: 'rotation', keyframes: [
          { time: 0, value: [0, 0, 0, 1] }, { time: 12.0, value: [0, 1, 0, 0] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/* ============================== COZY ============================== */

const spCozy = new SeriesPalette();

/** 温馨小屋：30×24×26，木桁架 + 红瓦坡顶 + 烟囱炊烟 */
export function cozyCottage() {
  const pal = new Palette();
  const plaster = spCozy.ramp(pal, 'cozy', 'plaster', '#e8dcc2', { steps: 6, vRange: [0.62, 1.06], hueShift: 3 });
  const timber = spCozy.ramp(pal, 'cozy', 'timber', '#6e4a2a', { steps: 5, vRange: [0.55, 1.05] });
  const roof = spCozy.ramp(pal, 'cozy', 'roof', '#b5502e', { steps: 6, vRange: [0.5, 1.08], hueShift: -3 });
  const stone = spCozy.ramp(pal, 'cozy', 'chimney', '#8d949c', { steps: 5, vRange: [0.55, 1.05] });
  const door = spCozy.ramp(pal, 'cozy', 'door', '#4e3a24', { steps: 4, vRange: [0.55, 1.05] });
  const glow = spCozy.ramp(pal, 'cozy', 'lamp', '#ffcf6e', { steps: 4, vRange: [0.7, 1.1], emissive: 0.75, emissiveTop: 1.0 });
  const smoke = spCozy.ramp(pal, 'cozy', 'smoke', '#dfe4ea', { steps: 5, vRange: [0.6, 1.05] });
  const grass = spCozy.ramp(pal, 'cozy', 'grass', '#7aa054', { steps: 4, vRange: [0.55, 1.0] });

  const W = 30, H = 24, D = 26, cx = 15, cz = 13;
  const body = new Sculptor(W, H, D);
  // 草皮基座
  body.fill(sd.roundBox(cx, 0.9, cz, 13.8, 0.9, 11.8, 0.5), (x, y, z) => grass(clamp01(0.55 + dither(x, y, z, 3))));
  // 墙体
  body.fill(sd.roundBox(cx, 7.5, cz, 11.2, 6.2, 10.2, 0.4), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 5 }) - 0.5) * 0.18;
    // 木桁架：竖梁 + 顶梁
    const beamV = (x % 5 < 1.1 || z % 5 < 1.1);
    const beamH = Math.abs(y - 12.6) < 0.8 || Math.abs(y - 6.4) < 0.8;
    if ((beamV && y > 2 && y < 13.4) || beamH) return timber(clamp01(0.5 + n));
    return plaster(clamp01(0.55 + (y - 2) / 12 * 0.35 + n));
  });
  // 人字坡顶（叠层收分 + 出檐）
  body.fill((x, y, z) => {
    const rx = Math.abs(x + 0.5 - cx), rz = Math.abs(z + 0.5 - cz);
    const t = clamp01((y - 13.0) / 7.6);
    const half = 11.0 - t * 9.9;
    return (rz > half - 1.2 && rz < half + 0.4 && y >= 13.0 && y <= 20.6 && rx < half + 1.4) ? -1 : 1;
  }, (x, y, z) => {
    const row = Math.floor(y * 1.4);
    const alt = row % 2 === 0 ? 0.05 : -0.05;
    const n = (fbm3(x, y, z, { freq: 0.35, seed: 15 }) - 0.5) * 0.14;
    return roof(clamp01(0.45 + (y - 13) / 10 * 0.4 + alt + n));
  });
  // 屋脊
  body.fill(sd.roundBox(cx, 21.2, cz, 2.2, 0.6, 1.2, 0.3), () => timber(0.6));
  // 门 + 圆窗（暖光）
  body.carve(sd.roundBox(cx, 4.0, cz - 8.2, 1.7, 3.4, 1.2, 0.6));
  body.fill(sd.roundBox(cx, 3.6, cz - 8.4, 1.4, 3.0, 0.6, 0.4), (x, y, z) => door(clamp01(0.5 + y / 8)));
  body.fill(sd.ell(cx - 4.6, 9.6, cz - 8.1, 1.3, 1.3, 0.5), () => glow(0.9));
  body.fill(sd.ell(cx + 4.6, 9.6, cz - 8.1, 1.3, 1.3, 0.5), () => glow(0.9));
  body.fill(sd.ell(cx, 9.6, cz + 8.1, 1.5, 1.5, 0.5), () => glow(0.8));
  // 烟囱（石砌）
  body.fill(sd.cylinderY(21.5, 8.5, 12, 21.5, 1.6), (x, y, z) => stone(clamp01(0.5 + y / 24 + dither(x, y, z, 9))));
  body.fill(sd.roundBox(21.5, 22.0, 8.5, 2.0, 0.5, 2.0, 0.3), () => stone(0.75));

  // 炊烟（独立组）
  const puff = new Sculptor(9, 10, 9);
  puff.fill(sd.smoothUnion(1.2)(
    sd.ell(4.5, 1.8, 4.5, 1.4, 1.2, 1.4),
    sd.ell(5.0, 4.2, 4.7, 1.7, 1.5, 1.7),
    sd.ell(4.2, 7.0, 5.0, 2.0, 1.8, 2.0),
  ), (x, y, z) => smoke(clamp01(0.5 + (y - 1) / 8 + (fbm3(x, y, z, { freq: 0.5, seed: 21 }) - 0.5) * 0.2)));

  return {
    style: 'cozy-cottage', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'cottage_body', name: '屋身', position: [0, 0, 0], sculptor: body },
      { id: 'cottage_smoke', name: '炊烟', position: [17.5, 21.5, 4.5], sculptor: puff, bone: 'bone-smoke' },
    ],
    bones: [{ id: 'bone-smoke', name: 'ChimneySmoke', parent: 'ROOT_BONE', position: [22, 22, 9] }],
    animations: [{
      id: 'drift', name: 'Smoke Drift', duration: 4.5, loop: true, channels: [
        { bone: 'bone-smoke', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 2.25, value: [0.5, 0.8, 0.3], interp: 'EASE_IN_OUT_SINE' }, { time: 4.5, value: [0, 0, 0] },
        ] },
        { bone: 'bone-smoke', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 1.5, value: [1.08, 1.05, 1.08] }, { time: 3.0, value: [0.95, 0.97, 0.95] }, { time: 4.5, value: [1, 1, 1] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 许愿水井：16×18×16，石圈 + 双柱小顶 + 吊桶 */
export function cozyWell() {
  const pal = new Palette();
  const stone = spCozy.ramp(pal, 'cozy', 'wellStone', '#8d949c', { steps: 7, vRange: [0.52, 1.08], hueShift: -3 });
  const stoneD = spCozy.ramp(pal, 'cozy', 'wellStoneDark', '#4a5058', { steps: 4, vRange: [0.6, 1.0] });
  const wood = spCozy.ramp(pal, 'cozy', 'post', '#7c5836', { steps: 6, vRange: [0.55, 1.06] });
  const roof = spCozy.ramp(pal, 'cozy', 'shingle', '#b5502e', { steps: 5, vRange: [0.5, 1.05] });
  const rope = spCozy.ramp(pal, 'cozy', 'rope', '#a08454', { steps: 4, vRange: [0.6, 1.05] });
  const water = spCozy.ramp(pal, 'cozy', 'water', '#4a8ac2', { steps: 5, vRange: [0.6, 1.1], emissive: 0.15, emissiveTop: 0.35 });
  const moss = spCozy.ramp(pal, 'cozy', 'wellMoss', '#5c7a52', { steps: 4, vRange: [0.55, 1.0] });

  const W = 16, H = 18, D = 16, cx = 8, cz = 8;
  const main = new Sculptor(W, H, D);
  // 石圈（环墙，带内腔水面）
  main.fill(sd.cylinderY(cx, cz, 0, 5.5, 5.4), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 5 }) - 0.5) * 0.2;
    const brick = (Math.floor(y * 1.5) + Math.floor(Math.atan2(z - cz, x - cx) * 4)) % 2 === 0 ? 0.05 : -0.04;
    if (fbm3(x, y, z, { freq: 0.2, seed: 9 }) > 0.66 && y < 3.2) return moss(clamp01(0.45 + n));
    return stone(clamp01(0.42 + y / 8 + brick + n));
  });
  main.carve(sd.cylinderY(cx, cz, -0.5, 4.4, 3.7));
  // 水面
  main.fill(sd.cylinderY(cx, cz, 3.0, 4.2, 3.65), (x, y, z) => water(clamp01(0.55 + (fbm3(x, y, z, { freq: 0.6, seed: 11 }) - 0.5) * 0.3)));
  // 井沿收边
  main.fill(sd.torusY(cx, 5.5, cz, 4.6, 0.9), (x, y, z) => stoneD(0.62));
  // 双柱 + 卷轴 + 小顶
  for (const side of [-1, 1]) {
    main.fill(sd.capsule(cx + side * 4.2, 5.5, cz, cx + side * 4.2, 16.2, cz, 0.85), (x, y, z) => wood(clamp01(0.5 + (y - 5) / 12)));
  }
  main.fill(sd.capsule(cx - 4.2, 12.5, cz, cx + 4.2, 12.5, cz, 0.7), () => wood(0.72));
  for (const side of [-1, 1]) {
    main.fill((x, y, z) => {
      const rz = Math.abs(z + 0.5 - cz);
      const t = (y - 12.6) / 3.4;
      const half = 6.4 - t * 5.6;
      return (rz > half - 1.0 && rz < half + 0.35 && y >= 12.6 && y <= 16.0 && Math.abs(x + 0.5 - cx) < 6.6) ? -1 : 1;
    }, (x, y, z) => roof(clamp01(0.5 + (y - 12.6) / 5 + dither(x, y, z, 13))));
  }
  // 吊绳 + 木桶
  main.fill(sd.polylineTube([[cx, 12.4, cz], [cx, 8.2, cz]], (t) => 0.32), () => rope(0.65));
  main.fill(sd.cylinderY(cx, cz, 6.4, 8.2, 1.35), (x, y, z) => wood(clamp01(0.45 + (y - 6) / 3 + dither(x, y, z, 15))));
  main.fill(sd.torusY(cx, 6.6, cz, 1.35, 0.3), () => stoneD(0.7));
  main.fill(sd.torusY(cx, 8.0, cz, 1.35, 0.3), () => stoneD(0.7));
  weathering(main, { amount: 0.07, seed: 19 });

  return {
    style: 'cozy-well', natural: [W, H, D], palette: pal,
    groups: [{ id: 'well_body', name: '水井', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/** 篝火小锅：14×12×14，石圈 + 柴堆 + 火舌 + 吊锅 */
export function cozyCampfire() {
  const pal = new Palette();
  const stone = spCozy.ramp(pal, 'cozy', 'fireStone', '#8a8f8a', { steps: 5, vRange: [0.5, 1.05], hueShift: 4 });
  const log = spCozy.ramp(pal, 'cozy', 'log', '#6e4a2a', { steps: 6, vRange: [0.45, 1.0] });
  const ember = spCozy.ramp(pal, 'cozy', 'fireEmber', '#e2481d', { steps: 5, vRange: [0.45, 1.2], emissive: 0.55, emissiveTop: 1.0 });
  const emberCore = spCozy.ramp(pal, 'cozy', 'fireCore', '#ffb347', { steps: 4, vRange: [0.8, 1.2], emissive: 0.9, emissiveTop: 1.0 });
  const iron = spCozy.ramp(pal, 'cozy', 'kettle', '#3a4046', { steps: 5, vRange: [0.55, 1.05] });
  const ash = spCozy.ramp(pal, 'cozy', 'ash', '#9a948a', { steps: 4, vRange: [0.5, 0.95] });

  const W = 14, H = 12, D = 14, cx = 7, cz = 7;
  const base = new Sculptor(W, H, D);
  // 石圈（8 块围合）
  const stones = radialArray(8, cx, cz, (ang, i) => sd.ell(
    cx + Math.cos(ang) * 4.6, 1.1 + (i % 2) * 0.3, cz + Math.sin(ang) * 4.6, 1.5, 1.2, 1.5,
  ), { phase: 0.2 });
  base.fill(stones, (x, y, z) => stone(clamp01(0.45 + y / 4 + dither(x, y, z, 5))));
  // 柴堆（交叉三根）
  for (const ang of [0.3, 0.3 + TAU / 3, 0.3 + (2 * TAU) / 3]) {
    base.fill(sd.capsule(
      cx - Math.cos(ang) * 2.2, 1.2, cz - Math.sin(ang) * 2.2,
      cx + Math.cos(ang) * 2.2, 2.4, cz + Math.sin(ang) * 2.2, 0.8,
    ), (x, y, z) => log(clamp01(0.4 + y / 4 + dither(x, y, z, 7))));
  }
  // 灰烬
  base.fill(sd.cylinderY(cx, cz, 0.2, 1.0, 2.6), (x, y, z) => ash(0.5 + dither(x, y, z, 9) * 0.5));
  // 吊杆三脚架 + 挂钩（静态部分：杆）
  for (const ang of [0.8, 0.8 + TAU / 3, 0.8 + (2 * TAU) / 3]) {
    base.fill(sd.polylineTube(
      [[cx + Math.cos(ang) * 4.2, 0.6, cz + Math.sin(ang) * 4.2], [cx, 9.4, cz]],
      (t) => 0.5 - t * 0.15,
    ), (x, y, z) => log(clamp01(0.5 + y / 12)));
  }
  base.fill(sd.capsule(cx, 9.2, cz, cx, 7.6, cz, 0.25), () => iron(0.7));

  // 火舌（独立组，动画）
  const flame = new Sculptor(10, 9, 10);
  const tongues = [
    { off: [0, 0], h: 8.0, r0: 1.9, seed: 41 },
    { off: [-1.6, 1.2], h: 5.8, r0: 1.3, seed: 43 },
    { off: [1.5, -1.3], h: 6.2, r0: 1.3, seed: 45 },
  ];
  for (const tg of tongues) {
    const fx = 5 + tg.off[0], fz = 5 + tg.off[1];
    const fSdf = (x, y, z) => {
      const t = clamp01(y / tg.h);
      const sway = Math.sin(t * 2.2) * 0.9;
      const rr = tg.r0 * (1 - t * 0.7) + 0.35;
      const d = sd.ell(fx + sway, t * tg.h, fz, rr, tg.h * 0.5, rr)(x, y, z);
      return d + (fbm3(x, y, z, { freq: 0.4, seed: tg.seed, octaves: 3 }) - 0.5) * 0.9 * (1 - t * 0.4);
    };
    flame.fill(fSdf, (x, y, z) => {
      const t = clamp01(y / tg.h);
      const r = Math.hypot(x - fx, z - fz);
      const core = r < tg.r0 * 0.5 && t < 0.65;
      const n = (fbm3(x, y, z, { freq: 0.55, seed: 47 }) - 0.5) * 0.3;
      return core ? emberCore(clamp01(0.4 + t * 0.6 + n)) : ember(clamp01(0.15 + t * 0.85 + n));
    });
  }
  // 吊锅（静态铁锅挂在火上方：放 base 组）
  base.fill(sd.ell(cx, 7.0, cz, 2.0, 1.2, 2.0), (x, y, z) => iron(clamp01(0.5 + (y - 6) / 3 + dither(x, y, z, 13) * 0.4)));
  base.carve(sd.roundBox(cx, 7.8, cz, 1.5, 0.5, 1.5)); // 锅口

  return {
    style: 'cozy-campfire', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'fire_base', name: '火堆', position: [0, 0, 0], sculptor: base },
      { id: 'fire_flame', name: '火舌', position: [2, 1, 2], sculptor: flame, bone: 'bone-fire' },
    ],
    bones: [{ id: 'bone-fire', name: 'Campfire', parent: 'ROOT_BONE', position: [cx, 2, cz] }],
    animations: [{
      id: 'flicker', name: 'Flame Flicker', duration: 1.8, loop: true, channels: [
        { bone: 'bone-fire', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.45, value: [1.1, 0.92, 1.08] }, { time: 0.9, value: [0.94, 1.1, 0.95] },
          { time: 1.35, value: [1.06, 0.95, 1.05] }, { time: 1.8, value: [1, 1, 1] },
        ] },
        { bone: 'bone-fire', path: 'translation', keyframes: [
          { time: 0, value: [0, 0, 0] }, { time: 0.9, value: [0.2, 0.25, -0.15] }, { time: 1.8, value: [0, 0, 0] },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 市集货摊：24×18×14，条纹凉棚 + 柜台 + 南瓜货 */
export function cozyStall() {
  const pal = new Palette();
  const wood = spCozy.ramp(pal, 'cozy', 'stallWood', '#9a6a3a', { steps: 6, vRange: [0.5, 1.08] });
  const woodD = spCozy.ramp(pal, 'cozy', 'stallWoodDark', '#54381e', { steps: 4, vRange: [0.6, 1.0] });
  const canopyA = spCozy.ramp(pal, 'cozy', 'canopyRed', '#c25036', { steps: 5, vRange: [0.5, 1.1] });
  const canopyB = spCozy.ramp(pal, 'cozy', 'canopyCream', '#efe6cf', { steps: 4, vRange: [0.62, 1.05] });
  const pumpkin = spCozy.ramp(pal, 'cozy', 'pumpkin', '#d9822e', { steps: 5, vRange: [0.5, 1.1], hueShift: 4 });
  const leaf = spCozy.ramp(pal, 'cozy', 'leaf', '#5c8a42', { steps: 4, vRange: [0.55, 1.0] });
  const sack = spCozy.ramp(pal, 'cozy', 'sack', '#c2a878', { steps: 4, vRange: [0.55, 1.02] });
  const iron = spCozy.ramp(pal, 'cozy', 'nail', '#3a4046', { steps: 4, vRange: [0.6, 1.05] });

  const W = 24, H = 18, D = 14, cx = 12, cz = 7;
  const main = new Sculptor(W, H, D);
  // 柜台（木板条）
  main.fill(sd.roundBox(cx, 3.4, cz + 1.5, 9.6, 2.2, 3.4, 0.4), (x, y, z) => {
    const plank = Math.floor(y * 1.6) % 2 === 0 ? 0.05 : -0.04;
    return wood(clamp01(0.48 + y / 8 + plank + dither(x, y, z, 3) * 0.4));
  });
  main.fill(sd.roundBox(cx, 5.9, cz + 1.5, 9.8, 0.35, 3.6, 0.3), () => woodD(0.66));
  // 四柱
  for (const [px, pz] of [[3.4, 1.5], [20.6, 1.5], [3.4, 12.5], [20.6, 12.5]]) {
    main.fill(sd.cylinderY(px, pz, 0, 12.4, 0.75), (x, y, z) => wood(clamp01(0.5 + y / 16)));
  }
  // 凉棚（斜面条纹，前低后高）
  main.fill((x, y, z) => {
    const t = clamp01((x - 2) / 20);
    const yy = 13.6 - t * 2.2 + Math.abs(z + 0.5 - cz) * 0.12;
    return (y > yy && y < yy + 1.3 && x > 1.6 && x < 22.4 && z > 0.4 && z < 13.6) ? -1 : 1;
  }, (x, y, z) => {
    const stripe = Math.floor((x - 1.6) / 2.6) % 2 === 0;
    const n = (fbm3(x, y, z, { freq: 0.4, seed: 7 }) - 0.5) * 0.12;
    return stripe ? canopyA(clamp01(0.5 + (y - 11) / 4 + n)) : canopyB(clamp01(0.6 + n * 0.5));
  });
  // 棚骨（前檐横杆）
  main.fill(sd.capsule(2.0, 12.2, 1.0, 22.0, 12.2, 1.0, 0.5), () => woodD(0.7));
  // 南瓜堆（大小三只 + 蒂叶）
  for (const [px, pz, r] of [[7, 5.5, 2.0], [11.5, 6.5, 1.6], [15.5, 5.0, 2.3]]) {
    main.fill(sd.ell(px, 6.2 + r * 0.4, pz, r, r * 0.8, r), (x, y, z) => {
      const lob = Math.abs(Math.sin(Math.atan2(z - pz, x - px) * 4)) > 0.5 ? 0.08 : -0.04;
      const n = (fbm3(x, y, z, { freq: 0.45, seed: 11 }) - 0.5) * 0.16;
      return pumpkin(clamp01(0.45 + (y - 5) / 4 * 0.4 + lob + n));
    });
    main.fill(sd.ell(px, 6.2 + r * 1.25, pz, 0.5, 0.7, 0.5), () => leaf(0.65));
  }
  // 麻袋两只
  for (const [px, pz] of [[18.5, 10.0], [20.5, 8.2]]) {
    main.fill(sd.ell(px, 5.8, pz, 1.7, 1.5, 1.5), (x, y, z) => sack(clamp01(0.5 + (y - 4.5) / 4 + dither(x, y, z, 17) * 0.3)));
  }
  // 吊牌（stampGlyph 木牌）
  main.fill(sd.roundBox(cx, 8.8, 1.0, 3.4, 1.7, 0.35, 0.3), () => woodD(0.6));
  main.fill(sd.capsule(cx, 10.2, 1.0, cx, 12.0, 1.0, 0.3), () => iron(0.7));
  stampGlyph(main, [
    '#.#',
    '.#.',
    '#.#',
  ], { x: cx - 2, y: 10.2, z: 0, axis: 'z', paint: () => canopyA(0.8) });

  return {
    style: 'cozy-stall', natural: [W, H, D], palette: pal,
    groups: [{ id: 'stall_body', name: '货摊', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/* ============================== HORROR ============================== */

const spHorror = new SeriesPalette();

/** 枯树：24×32×24，虬枝 + 空洞双眼 */
export function horrorDeadtree() {
  const pal = new Palette();
  const bark = spHorror.ramp(pal, 'horror', 'bark', '#4a3f36', { steps: 8, vRange: [0.42, 1.02], hueShift: 3 });
  const barkD = spHorror.ramp(pal, 'horror', 'barkDark', '#26201c', { steps: 5, vRange: [0.5, 1.0] });
  const mossD = spHorror.ramp(pal, 'horror', 'gloom', '#3e5240', { steps: 4, vRange: [0.45, 0.95] });
  const eye = spHorror.ramp(pal, 'horror', 'willowisp', '#b8ff5a', { steps: 4, vRange: [0.6, 1.15], emissive: 0.8, emissiveTop: 1.0 });
  const splinter = spHorror.ramp(pal, 'horror', 'splinter', '#8a7a66', { steps: 4, vRange: [0.5, 1.0] });
  const lichen = spHorror.ramp(pal, 'horror', 'lichen', '#8a9a5a', { steps: 4, vRange: [0.5, 1.0] });

  const W = 24, H = 32, D = 24, cx = 12, cz = 12;
  const main = new Sculptor(W, H, D);
  // 主干（扭曲：底部粗、收分 + fbm 扭摆）
  main.fill((x, y, z) => {
    const t = clamp01(y / 18);
    const sway = Math.sin(t * 2.2) * 1.6;
    const wob = (fbm3(x, y, z, { freq: 0.16, seed: 7 }) - 0.5) * 1.6;
    const r = 3.4 - t * 1.8;
    return Math.hypot(x + 0.5 - cx - sway, z + 0.5 - cz + Math.cos(t * 1.8) * 0.9) - r + wob;
  }, (x, y, z) => {
    const t = y / 24;
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 11 }) - 0.5) * 0.26;
    const ridge = Math.abs(Math.sin(Math.atan2(z - cz, x - cx) * 6)) < 0.25 ? -0.1 : 0.04;
    if (fbm3(x, y, z, { freq: 0.12, seed: 31 }) > 0.68) return lichen(clamp01(0.42 + n));
    if (fbm3(x, y, z, { freq: 0.2, seed: 15 }) > 0.62 && y < 10) return mossD(clamp01(0.4 + n));
    return bark(clamp01(0.36 + t * 0.4 + ridge + n));
  });
  // 根部外扩
  for (const ang of [0.5, 2.2, 4.0, 5.5]) {
    main.fill(sd.polylineTube(
      [[cx + Math.cos(ang) * 6.4, 0.4, cz + Math.sin(ang) * 6.4], [cx + Math.cos(ang) * 2.4, 3.6, cz + Math.sin(ang) * 2.4], [cx, 6.5, cz]],
      (t) => 1.6 - t * 1.0,
    ), (x, y, z) => barkD(clamp01(0.4 + y / 8 + dither(x, y, z, 13) * 0.3)));
  }
  // 虬枝（4 根贝塞尔，向上外）
  const branches = [
    { p: [cx + 1.2, 20, cz], p1: [cx + 6, 24, cz - 2], p2: [cx + 8, 28, cz - 4], end: [cx + 9.5, 31, cz - 5], r: 1.4, seed: 21 },
    { p: [cx - 1.0, 21, cz], p1: [cx - 5, 25, cz + 2], p2: [cx - 7.5, 28, cz + 3], end: [cx - 9.0, 30.5, cz + 3.5], r: 1.2, seed: 23 },
    { p: [cx, 16, cz + 1.0], p1: [cx + 1, 20, cz + 6], p2: [cx - 1, 23, cz + 8], end: [cx - 2.5, 25.5, cz + 9.5], r: 1.0, seed: 25 },
    { p: [cx - 0.5, 24, cz - 1], p1: [cx + 3, 27, cz - 6], p2: [cx + 4, 29, cz - 8], end: [cx + 4.5, 30, cz - 9.5], r: 0.9, seed: 27 },
  ];
  for (const br of branches) {
    main.fill(sd.polylineTube(sd.bezier3(br.p, br.p1, br.p2, br.end, 14), (t) => br.r - t * br.r * 0.7),
      (x, y, z) => bark(clamp01(0.4 + (y - 16) / 16 + (fbm3(x, y, z, { freq: 0.4, seed: br.seed }) - 0.5) * 0.24)));
    // 断口木茬
    main.fill(sd.ell(br.end[0], br.end[1], br.end[2], br.r * 0.8, br.r * 0.6, br.r * 0.8), () => splinter(0.65));
  }
  // 树洞 + 一对幽光眼
  main.carve(sd.ell(cx + 0.6, 9.0, cz - 2.6, 2.0, 2.6, 1.6));
  main.fill(sd.ell(cx - 0.3, 9.8, cz - 3.9, 0.5, 0.5, 0.5), () => eye(0.95));
  main.fill(sd.ell(cx + 1.1, 9.8, cz - 3.9, 0.5, 0.5, 0.5), () => eye(0.95));
  weathering(main, { amount: 0.09, seed: 33 });

  return {
    style: 'horror-deadtree', natural: [W, H, D], palette: pal,
    groups: [{ id: 'deadtree_body', name: '枯树', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/** 荒坟：18×20×12，斜碑 + 裂缝 + 骷髅 + 土丘 */
export function horrorGrave() {
  const pal = new Palette();
  const stone = spHorror.ramp(pal, 'horror', 'graveStone', '#7a8088', { steps: 7, vRange: [0.45, 1.0], hueShift: -5 });
  const stoneD = spHorror.ramp(pal, 'horror', 'graveStoneDark', '#3a3f46', { steps: 5, vRange: [0.55, 1.0] });
  const dirt = spHorror.ramp(pal, 'horror', 'graveDirt', '#4e3c2c', { steps: 5, vRange: [0.42, 0.95] });
  const bone = spHorror.ramp(pal, 'horror', 'skull', '#d8d2c2', { steps: 5, vRange: [0.6, 1.08], hueShift: 2 });
  const moss = spHorror.ramp(pal, 'horror', 'graveMoss', '#44583e', { steps: 4, vRange: [0.45, 0.9] });
  const glow = spHorror.ramp(pal, 'horror', 'graveGlow', '#8affc2', { steps: 3, vRange: [0.6, 1.1], emissive: 0.85, emissiveTop: 1.0 });

  const W = 18, H = 20, D = 12;
  const main = new Sculptor(W, H, D);
  // 土丘 + 草皮斑
  main.fill((x, y, z) => {
    const nx = (x - 9) / 7.6, nz = (z - 6) / 4.8;
    return nx * nx + nz * nz + ((y - 0.4) / 2.6) ** 2 - 1;
  }, (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.3, seed: 5 }) - 0.5) * 0.22;
    if (fbm3(x, y, z, { freq: 0.16, seed: 9 }) > 0.6) return moss(clamp01(0.4 + n));
    return dirt(clamp01(0.4 + y / 4 + n));
  });
  // 碑（微倾）+ 顶弧
  main.fill((x, y, z) => {
    const lean = (10 - y) * 0.06; // 绕 z 微倾
    const dx = Math.abs(x + 0.5 - 9 - lean) - 3.4;
    const dz = Math.abs(z + 0.5 - 6) - 1.4;
    const top = 15.5 - y;
    const bot = y - 2.2;
    if (y > 12.5) { // 顶部圆弧
      return Math.hypot(x + 0.5 - 9 - lean, (y - 12.5) * 1.4) - 3.4 + Math.abs(z + 0.5 - 6) * 0.2 - 0.4;
    }
    return Math.max(dx, dz, bot, top);
  }, (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.26, seed: 13 }) - 0.5) * 0.24;
    if (fbm3(x, y, z, { freq: 0.18, seed: 17 }) > 0.64) return moss(clamp01(0.38 + n));
    return stone(clamp01(0.36 + y / 22 + n));
  });
  // 裂缝（斜向刻槽）
  main.carve((x, y, z) => {
    const c = Math.abs((x - 7.2) - (15.5 - y) * 0.34);
    return (c < 0.5 && y > 5 && y < 14 && Math.abs(z - 6) < 1.6) ? -1 : 1;
  });
  // 碑文（stampGlyph + 侵蚀）
  stampGlyph(main, [
    '#.#.#',
    '.###.',
    '#.#.#',
    '..#..',
  ], { x: 6, y: 12, z: 8, axis: 'z', engrave: true, paint: (x, y, z) => stoneD(0.55) });
  stampGlyph(main, [
    '.###.',
    '#...#',
    '.###.',
  ], { x: 6.5, y: 9.5, z: 8, axis: 'z', engrave: true, paint: () => glow(0.85) });
  // 基座
  main.fill(sd.roundBox(9, 2.2, 6, 4.4, 1.0, 2.2, 0.4), (x, y, z) => stoneD(clamp01(0.5 + y / 4)));
  // 骷髅（倚碑半埋）
  main.fill(sd.ell(13.6, 2.6, 8.6, 1.7, 1.5, 1.7), (x, y, z) => bone(clamp01(0.65 + (y - 1.5) / 3 + dither(x, y, z, 21) * 0.2)));
  main.fill(sd.ell(13.0, 3.1, 9.9, 0.42, 0.5, 0.42), () => glow(0.9)); // 眼窝幽光
  main.fill(sd.ell(14.4, 3.1, 8.4, 0.42, 0.5, 0.42), () => glow(0.9));
  main.carve(sd.roundBox(13.6, 2.2, 10.4, 0.7, 0.4, 0.4)); // 牙缝
  // 枯草几撮
  for (const [gx, gz] of [[3.5, 9.5], [15.0, 3.0], [5.0, 2.5], [12.0, 10.5]]) {
    main.fill(sd.polylineTube([[gx, 0.4, gz], [gx + (hash3(gx, gz, 1, 3) - 0.5) * 1.6, 1.8 + hash3(gx, gz, 2, 5) * 1.4, gz + (hash3(gx, gz, 3, 7) - 0.5) * 1.2]],
      (t) => 0.28 - t * 0.16), (x, y, z) => moss(0.55));
  }
  weathering(main, { amount: 0.08, seed: 25 });

  return {
    style: 'horror-grave', natural: [W, H, D], palette: pal,
    groups: [{ id: 'grave_body', name: '荒坟', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [9, 0, 6],
  };
}

/** 灯笼祭坛：22×24×22，石坛 + 幽焰 + 蜡烛环 + 铁链 */
export function horrorAltar() {
  const pal = new Palette();
  const stone = spHorror.ramp(pal, 'horror', 'altarStone', '#5e6468', { steps: 8, vRange: [0.42, 1.0], hueShift: -4 });
  const stoneD = spHorror.ramp(pal, 'horror', 'altarStoneDark', '#2c3136', { steps: 5, vRange: [0.55, 1.0] });
  const flame = spHorror.ramp(pal, 'horror', 'soulFire', '#7ae07a', { steps: 6, vRange: [0.5, 1.2], emissive: 0.75, emissiveTop: 1.0 });
  const flameCore = spHorror.ramp(pal, 'horror', 'soulCore', '#d8ffd8', { steps: 4, vRange: [0.8, 1.2], emissive: 0.95, emissiveTop: 1.0 });
  const candle = spHorror.ramp(pal, 'horror', 'candle', '#e2d8c2', { steps: 4, vRange: [0.6, 1.05] });
  const chain = spHorror.ramp(pal, 'horror', 'chain', '#3a4046', { steps: 4, vRange: [0.55, 1.0] });
  const rune = spHorror.ramp(pal, 'horror', 'bloodRune', '#a83c34', { steps: 4, vRange: [0.5, 1.0], emissive: 0.2, emissiveTop: 0.5 });

  const W = 22, H = 24, D = 22, cx = 11, cz = 11;
  const main = new Sculptor(W, H, D);
  // 三层石坛
  main.fill(sd.roundBox(cx, 1.2, cz, 10.2, 1.2, 10.2, 0.5), (x, y, z) => {
    const band = (Math.floor(x / 2.4) + Math.floor(z / 2.4)) % 2 === 0 ? 0.1 : -0.06;
    return stone(clamp01(0.4 + y / 4 + band + dither(x, y, z, 3) * 0.4));
  });
  main.fill(sd.roundBox(cx, 3.2, cz, 8.0, 0.8, 8.0, 0.4), (x, y, z) => stone(clamp01(0.5 + y / 5 + dither(x, y, z, 5) * 0.4)));
  main.fill(sd.roundBox(cx, 5.0, cz, 5.8, 0.9, 5.8, 0.4), (x, y, z) => stoneD(0.6 + dither(x, y, z, 7) * 0.3));
  // 血符纹（坛面环刻）
  main.repaint((x, y, z) => {
    const r = Math.hypot(x - cx, z - cz);
    if (r < 6.6 || r > 7.6 || y < 2.2 || y > 3.4) return 0;
    const ang = Math.atan2(z - cz, x - cx);
    return (Math.floor(((ang + Math.PI) / TAU) * 12) % 2 === 0) ? rune(0.7) : 0;
  }, (x, y, z) => main.get(x, y, z) !== 0);
  // 中央石柱 + 血刻字
  main.fill(sd.roundBox(cx, 10.5, cz, 2.6, 5.0, 2.6, 0.5), (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.28, seed: 11 }) - 0.5) * 0.22;
    return stone(clamp01(0.42 + (y - 5) / 12 + n));
  });
  stampGlyph(main, [
    '#.#',
    '###',
    '#.#',
    '.#.',
  ], { x: cx - 1, y: 14, z: cz - 3.1, axis: 'z', engrave: true, paint: () => rune(0.85) });
  // 柱顶承焰盘
  main.fill(sd.cylinderY(cx, cz, 15.4, 16.4, 3.0), (x, y, z) => stoneD(0.7));
  // 蜡烛环（radialArray 8 根小蜡烛 + 火点）
  const candles = radialArray(8, cx, cz, (ang, i) => sd.cylinderY(
    cx + Math.cos(ang) * 8.4, cz + Math.sin(ang) * 8.4, 2.4, 2.4 + 1.2 + (i % 2) * 0.8, 0.55,
  ));
  main.fill(candles, (x, y, z) => candle(clamp01(0.5 + y / 4 + dither(x, y, z, 15) * 0.45)));
  const sparks = radialArray(8, cx, cz, (ang, i) => sd.sphere(
    cx + Math.cos(ang) * 8.4, 4.0 + (i % 2) * 0.8, cz + Math.sin(ang) * 8.4, 0.4,
  ));
  main.fill(sparks, () => flame(0.95));
  // 垂链（从柱顶两侧垂到坛角）
  for (const side of [-1, 1]) {
    main.fill(sd.polylineTube(
      [[cx, 15.2, cz], [cx + side * 4.4, 13.0, cz + side * 3.4], [cx + side * 8.6, 6.4, cz + side * 7.2], [cx + side * 9.4, 2.8, cz + side * 8.2]],
      (t) => 0.5 - t * 0.1,
    ), (x, y, z) => chain(0.55 + dither(x, y, z, 13) * 0.3));
  }

  // 幽焰（独立组）
  const fire = new Sculptor(12, 10, 12);
  const fSdf = (x, y, z) => {
    const t = clamp01(y / 8.5);
    const sway = Math.sin(t * 2.0) * 1.1;
    const rr = 2.2 * (1 - t * 0.68) + 0.4;
    const d = sd.ell(6 + sway, t * 8.5, 6, rr, 8.5 * 0.5, rr)(x, y, z);
    return d + (fbm3(x, y, z, { freq: 0.38, seed: 55, octaves: 3 }) - 0.5) * 1.0 * (1 - t * 0.4);
  };
  fire.fill(fSdf, (x, y, z) => {
    const t = clamp01(y / 8.5);
    const r = Math.hypot(x - 6, z - 6);
    const core = r < 1.1 && t < 0.6;
    const n = (fbm3(x, y, z, { freq: 0.5, seed: 57 }) - 0.5) * 0.3;
    return core ? flameCore(clamp01(0.4 + t * 0.6 + n)) : flame(clamp01(0.15 + t * 0.85 + n));
  });

  return {
    style: 'horror-altar', natural: [W, H, D], palette: pal,
    groups: [
      { id: 'altar_body', name: '祭坛', position: [0, 0, 0], sculptor: main },
      { id: 'altar_fire', name: '幽焰', position: [cx - 6, 15.4, cz - 6], sculptor: fire, bone: 'bone-soulfire' },
    ],
    bones: [{ id: 'bone-soulfire', name: 'SoulFire', parent: 'ROOT_BONE', position: [cx, 16.4, cz] }],
    animations: [{
      id: 'breathe', name: 'Soul Breathe', duration: 3.2, loop: true, channels: [
        { bone: 'bone-soulfire', path: 'scale', keyframes: [
          { time: 0, value: [1, 1, 1] }, { time: 0.8, value: [1.1, 1.06, 1.1] }, { time: 1.6, value: [0.93, 1.1, 0.93] },
          { time: 2.4, value: [1.05, 0.96, 1.05] }, { time: 3.2, value: [1, 1, 1] },
        ] },
        { bone: 'bone-soulfire', path: 'alpha', keyframes: [
          { time: 0, value: 1 }, { time: 1.6, value: 0.7 }, { time: 3.2, value: 1 },
        ] },
      ],
    }],
    pivot: [cx, 0, cz],
  };
}

/** 废弃小屋：28×22×26，塌顶 + 破墙 + 幽窗 */
export function horrorHut() {
  const pal = new Palette();
  const wall = spHorror.ramp(pal, 'horror', 'hutWall', '#6e6257', { steps: 7, vRange: [0.42, 1.0], hueShift: 3 });
  const wood = spHorror.ramp(pal, 'horror', 'hutWood', '#4e3c2c', { steps: 6, vRange: [0.45, 1.0] });
  const woodD = spHorror.ramp(pal, 'horror', 'hutWoodDark', '#2c221a', { steps: 4, vRange: [0.55, 1.0] });
  const thatch = spHorror.ramp(pal, 'horror', 'thatch', '#8a7a4e', { steps: 5, vRange: [0.42, 0.95] });
  const moss = spHorror.ramp(pal, 'horror', 'hutMoss', '#3e5240', { steps: 4, vRange: [0.45, 0.9] });
  const glow = spHorror.ramp(pal, 'horror', 'hutGlow', '#c2a2ff', { steps: 4, vRange: [0.6, 1.15], emissive: 0.8, emissiveTop: 1.0 });
  const plank = spHorror.ramp(pal, 'horror', 'board', '#7a6a52', { steps: 4, vRange: [0.5, 1.0] });

  const W = 28, H = 22, D = 26, cx = 14, cz = 13;
  const main = new Sculptor(W, H, D);
  // 墙体（部分塌：右上角低）
  const wallTop = (x, z) => 13.5 - Math.max(0, (x - 18) / 9) * 5.5 - Math.max(0, (z - 18) / 7) * 3.0
    - (hash3(Math.floor(x / 2), Math.floor(z / 2), 4, 21) > 0.7 ? 1.6 : 0);
  main.fill((x, y, z) => {
    const hx = Math.abs(x + 0.5 - cx), hz = Math.abs(z + 0.5 - cz);
    const outer = Math.max(hx - 10.2, hz - 9.2);
    const yOk = y > 0.8 && y < wallTop(x + 0.5, z + 0.5);
    return (outer < 0 && yOk) ? -1 : 1;
  }, (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.28, seed: 5 }) - 0.5) * 0.22;
    const brick = (Math.floor(y / 1.8) + Math.floor(x / 3.6) + Math.floor(z / 3.6)) % 2 === 0 ? 0.05 : -0.04;
    if (fbm3(x, y, z, { freq: 0.15, seed: 9 }) > 0.6) return moss(clamp01(0.4 + n));
    return wall(clamp01(0.36 + y / 18 + brick + n));
  });
  // 木梁框（四角 + 门框 + 塌顶残梁）
  for (const [px, pz] of [[4.4, 4.4], [23.6, 4.4], [4.4, 21.6], [23.6, 21.6]]) {
    main.fill(sd.cylinderY(px, pz, 0.6, Math.min(14.2, wallTop(px, pz)) , 0.85), (x, y, z) => wood(clamp01(0.5 + y / 18)));
  }
  // 门洞（凹龛 + 钉木板封门，木板贴墙）
  main.carve(sd.roundBox(cx - 3, 4.0, cz - 8.9, 1.9, 3.6, 1.1, 0.5));
  for (let i = 0; i < 3; i += 1) {
    main.fill(sd.roundBox(cx - 3, 3.4 + i * 2.4, cz - 10.0, 1.7, 0.55, 0.7, 0.2), (x, y, z) => plank(clamp01(0.5 + i * 0.12 + dither(x, y, z, 11) * 0.3)));
  }
  // 幽窗（紫光，嵌进墙带）
  main.fill(sd.roundBox(cx + 6, 8.2, cz - 8.6, 1.9, 1.9, 1.1), () => glow(0.85));
  main.fill(sd.roundBox(cx - 6, 8.2, cz + 8.6, 1.9, 1.9, 1.1), () => glow(0.75));
  // 塌顶（半边茅草斜板 + 断椽）
  main.fill((x, y, z) => {
    if (x > cx - 1) return 1; // 只剩半边
    const t = clamp01((x - 2) / 11);
    const yy = 15.2 - t * 6.4 + Math.abs(z + 0.5 - cz) * 0.22;
    return (y > yy && y < yy + 1.2 && x > 1.6 && x < cx - 0.6 && z > 2 && z < 24) ? -1 : 1;
  }, (x, y, z) => {
    const n = (fbm3(x, y, z, { freq: 0.4, seed: 15 }) - 0.5) * 0.16;
    if (fbm3(x, y, z, { freq: 0.2, seed: 19 }) > 0.64) return moss(clamp01(0.42 + n));
    return thatch(clamp01(0.4 + (y - 8) / 10 + n));
  });
  for (let i = 0; i < 3; i += 1) {
    main.fill(sd.roundBox(cx + 2.5 + i * 2.2, 13.2 - i * 1.4, cz - 4 + i * 3, 0.4, 0.4, 4.2, 0.2), (x, y, z) => woodD(0.6));
  }
  // 门内幽光渗出
  main.fill(sd.roundBox(cx - 3, 3.0, cz - 8.4, 1.2, 1.6, 0.6), () => glow(0.55));
  weathering(main, { amount: 0.08, seed: 27 });

  return {
    style: 'horror-hut', natural: [W, H, D], palette: pal,
    groups: [{ id: 'hut_body', name: '废屋', position: [0, 0, 0], sculptor: main }],
    bones: [], animations: [],
    pivot: [cx, 0, cz],
  };
}

/* ============================== 注册表 ============================== */

export const SCULPT_PROGRAMS = {
  pixel: {
    series: 'pixel',
    entries: [
      { key: 'pixel-rifle', match: ['rifle', 'blaster', 'gun', '枪'], role: 'hero', animated: true, fn: pixelRifle },
      { key: 'pixel-pickaxe', match: ['pickaxe', 'axe', 'tool', '镐'], role: 'prop', animated: false, fn: pixelPickaxe },
      { key: 'pixel-turret', match: ['turret', 'defense', '炮塔'], role: 'prop', animated: true, fn: pixelTurret },
      { key: 'pixel-castle', match: ['castle', 'keep', 'fort', '城堡'], role: 'landmark', animated: false, fn: pixelCastle },
    ],
    defaults: ['pixel-rifle', 'pixel-turret', 'pixel-pickaxe', 'pixel-castle'],
  },
  ink: {
    series: 'ink',
    entries: [
      { key: 'ink-furnace', match: ['furnace', '丹炉', '炉'], role: 'hero', animated: true, fn: inkFurnace },
      { key: 'ink-crane', match: ['crane', '鹤'], role: 'hero', animated: true, fn: inkCrane },
      { key: 'ink-stele', match: ['stele', '碑', '石碑'], role: 'landmark', animated: true, fn: inkStele },
      { key: 'ink-boat', match: ['boat', 'ship', '舟', '船'], role: 'landmark', animated: true, fn: inkBoat },
    ],
    defaults: ['ink-furnace', 'ink-crane', 'ink-stele', 'ink-boat'],
  },
  hitech: {
    series: 'hitech',
    entries: [
      { key: 'hitech-pylon', match: ['pylon', 'tower', '能量塔', '塔'], role: 'landmark', animated: true, fn: hitechPylon },
      { key: 'hitech-hoverbike', match: ['bike', 'hover', '摩托'], role: 'hero', animated: true, fn: hitechHoverbike },
      { key: 'hitech-drone', match: ['drone', 'patrol', '巡逻机', '机'], role: 'prop', animated: true, fn: hitechDrone },
      { key: 'hitech-station', match: ['station', 'orbital', '轨道站', '站'], role: 'landmark', animated: true, fn: hitechStation },
    ],
    defaults: ['hitech-hoverbike', 'hitech-pylon', 'hitech-drone', 'hitech-station'],
  },
  cozy: {
    series: 'cozy',
    entries: [
      { key: 'cozy-cottage', match: ['cottage', 'house', '小屋'], role: 'landmark', animated: true, fn: cozyCottage },
      { key: 'cozy-well', match: ['well', '井'], role: 'prop', animated: false, fn: cozyWell },
      { key: 'cozy-campfire', match: ['campfire', 'fire', '篝火'], role: 'prop', animated: true, fn: cozyCampfire },
      { key: 'cozy-stall', match: ['stall', 'market', '货摊', '摊'], role: 'prop', animated: false, fn: cozyStall },
    ],
    defaults: ['cozy-cottage', 'cozy-well', 'cozy-campfire', 'cozy-stall'],
  },
  horror: {
    series: 'horror',
    entries: [
      { key: 'horror-deadtree', match: ['tree', 'dead', '枯树'], role: 'landmark', animated: false, fn: horrorDeadtree },
      { key: 'horror-grave', match: ['grave', 'tomb', '坟', '墓'], role: 'prop', animated: false, fn: horrorGrave },
      { key: 'horror-altar', match: ['altar', 'lantern', '祭坛'], role: 'hero', animated: true, fn: horrorAltar },
      { key: 'horror-hut', match: ['hut', 'ruin', '废屋', '弃屋'], role: 'landmark', animated: false, fn: horrorHut },
    ],
    defaults: ['horror-altar', 'horror-grave', 'horror-deadtree', 'horror-hut'],
  },
};

/** GDD 模型条目 -> 程序选择（按 name/style 关键词匹配，role 兜底） */
export function pickProgram(artStyle, entry, index = 0) {
  const set = SCULPT_PROGRAMS[artStyle] || SCULPT_PROGRAMS.pixel;
  const label = `${entry.name || ''} ${entry.style || ''}`.toLowerCase();
  let pick = set.entries.find((e) => e.match.some((m) => label.includes(m.toLowerCase())));
  if (!pick) pick = set.entries.find((e) => entry.role && e.role === entry.role);
  if (!pick) pick = set.entries[Math.min(index, set.entries.length - 1)];
  return pick;
}

/** GDD.models 缺省时按 artStyle 给默认模型集 */
export function defaultModels(artStyle) {
  const set = SCULPT_PROGRAMS[artStyle] || SCULPT_PROGRAMS.pixel;
  return set.defaults.map((key, i) => ({
    role: i === 0 ? 'hero' : i === set.defaults.length - 1 ? 'landmark' : 'prop',
    name: key,
    style: key,
    animated: set.entries.find((e) => e.key === key)?.animated || false,
  }));
}
