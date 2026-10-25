/**
 * ui-theme-kit.mjs — 主题化 UI 组件库 (UIThemeKit/0.1)
 *
 * 职责：游戏风格(artStyle) → UI 套系。提供 5 套主题（像素/水墨/科幻/温馨/恐怖）
 * 与 19 种"真组件"（物品栏/心形血量/像素昵称牌/击杀信息…），全部数据驱动：
 * build(kind, spec, theme) → 原语列表（rect/icon/text/bar/grid），measure() → 尺寸。
 * 渲染由 ui-theme-render.mjs 完成；布局由 ui-layout-solver.mjs 完成。
 *
 * 对比旧版（layout-engine.mjs）的本质区别：
 *  - 旧版一切皆"带背景色的文本块"；本库组件有真实结构（格子/图标/条/字位）
 *  - 旧版 3 个硬编码 archetype；本库主题决定形状语言（块状描边/细线框/发光/圆角）
 */

/* ============ 图标位图（12×12 字符画，'#'=主色,'+'=暗部,'.'=亮部,' '=空） ============ */
const GLYPHS = {
  heart: [
    ' #### #### ',
    '###########',
    '###########',
    '###########',
    '.#########.',
    '..#######..',
    '...#####...',
    '....###....',
    '.....#.....',
    '           ',
    '           ',
    '           ',
  ],
  sword: [
    '        ## ',
    '       ### ',
    '      ###  ',
    '     ###   ',
    '    ###    ',
    '   ###     ',
    '+ ###      ',
    ' ++#       ',
    ' #+ +      ',
    '##         ',
    '           ',
    '           ',
  ],
  flag: [
    '#####      ',
    '######     ',
    '### ###    ',
    '###  ###   ',
    '######     ',
    '#####      ',
    '##         ',
    '##         ',
    '##         ',
    '##         ',
    '           ',
    '           ',
  ],
  skull: [
    '  #######  ',
    ' ######### ',
    ' ## # # ## ',
    ' ## # # ## ',
    ' ######### ',
    '  ### ###  ',
    '  # # # #  ',
    '  ### ###  ',
    '   # # #   ',
    '           ',
    '           ',
    '           ',
  ],
  crown: [
    '#   #   #  ',
    '## ## ## # ',
    '###########',
    '###########',
    '.#########.',
    '###########',
    '#########+#',
    '           ',
    '           ',
    '           ',
    '           ',
    '           ',
  ],
  pickaxe: [
    '   ##  ##  ',
    '  ######## ',
    ' ## ## ### ',
    '##  ##  ## ',
    '    ##     ',
    '    ##     ',
    '    ##     ',
    '    ##     ',
    '    ##     ',
    '           ',
    '           ',
    '           ',
  ],
};
/** 几何图标程序化生成 */
function proceduralGlyph(name) {
  const g = Array.from({ length: 12 }, () => Array(12).fill(' '));
  const set = (x, y, c = '#') => { if (x >= 0 && x < 12 && y >= 0 && y < 12) g[y][x] = c; };
  const rect = (x0, y0, w, h, c = '#') => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, c); };
  const circle = (cx, cy, r, c = '#') => { for (let y = 0; y < 12; y += 1) for (let x = 0; x < 12; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, c); };
  switch (name) {
    case 'block': rect(1, 1, 10, 10); rect(1, 1, 10, 2, '.'); rect(1, 9, 10, 2, '+'); break;
    case 'shield': rect(2, 1, 8, 6); rect(3, 7, 6, 2); rect(4, 9, 4, 1); rect(5, 10, 2, 1); rect(3, 1, 6, 2, '.'); break;
    case 'star': for (let i = 0; i < 12; i += 1) { set(6, i); if (i > 1 && i < 10) { set(i, 6); } } set(4, 4); set(8, 4); set(4, 8); set(8, 8); circle(6, 6, 1, '.'); break;
    case 'potion': rect(4, 1, 4, 2); rect(3, 3, 6, 8); rect(4, 5, 4, 5, '.'); rect(3, 9, 6, 2, '+'); break;
    case 'snowball': circle(6, 6, 5); circle(5, 5, 2, '.'); break;
    case 'flame': for (let y = 0; y < 10; y += 1) { const w = Math.max(1, Math.round(5 - y * 0.35)); rect(6 - Math.floor(w / 2), 2 + y, w, 1); } rect(4, 10, 4, 1, '+'); break;
    default: rect(2, 2, 8, 8);
  }
  return g.map((row) => row.join(''));
}
const GLYPH_SETS = { ...GLYPHS };
for (const name of ['block', 'shield', 'star', 'potion', 'snowball', 'flame']) GLYPH_SETS[name] = proceduralGlyph(name);
export const ICON_GLYPHS = GLYPH_SETS;

/* ============ 主题注册表 ============ */
const TEAM_BASE = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524'];
export const THEMES = {
  pixel: {
    id: 'pixel', label: '像素方块',
    cell: 4, border: { size: 2, style: 'chunky' }, radius: 0,
    fontStack: '"Courier New", "SimSun", monospace', letterSpacing: 1,
    textShadow: '2px 2px 0 rgba(0,0,0,.85)',
    palette: {
      panelBg: '#2a2a3d', panelBgAlt: '#1b1b2a', border: '#0c0c14',
      borderLight: 'rgba(255,255,255,.35)', borderDark: 'rgba(0,0,0,.65)',
      text: '#f2f2e8', textDim: '#9a9a8e', accent: '#ffd23e',
      danger: '#e5484d', success: '#57c76a', water: '#4aa3e0',
      slot: '#14141f', slotSelected: '#ffd23e',
      bgPlaceholder: '#101018',
    },
    teams: TEAM_BASE,
    iconStyle: 'bitmap',
  },
  ink: {
    id: 'ink', label: '水墨宣纸',
    cell: 6, border: { size: 1, style: 'thin' }, radius: 2,
    fontStack: '"KaiTi", "STKaiti", serif', letterSpacing: 2,
    textShadow: 'none',
    palette: {
      panelBg: 'rgba(243,237,224,.94)', panelBgAlt: 'rgba(232,224,206,.9)', border: '#5a5248',
      borderLight: 'rgba(90,82,72,.25)', borderDark: 'rgba(60,52,44,.35)',
      text: '#3a332b', textDim: '#8a8073', accent: '#b3372c',
      danger: '#a03a2e', success: '#5d7a52', water: '#5d7a8a',
      slot: 'rgba(255,252,244,.9)', slotSelected: '#b3372c',
      bgPlaceholder: '#e9e2d0',
    },
    teams: ['#b3372c', '#3a5a6e', '#5d7a52', '#8a6d3b'],
    iconStyle: 'bitmap',
  },
  hitech: {
    id: 'hitech', label: '科幻发光',
    cell: 4, border: { size: 1, style: 'glow' }, radius: 3,
    fontStack: '"Consolas", "Microsoft YaHei", monospace', letterSpacing: 1,
    textShadow: '0 0 8px rgba(95,240,255,.55)',
    palette: {
      panelBg: 'rgba(8,18,28,.88)', panelBgAlt: 'rgba(10,24,36,.82)', border: '#17475c',
      borderLight: 'rgba(95,240,255,.8)', borderDark: 'rgba(10,40,54,.9)',
      text: '#d7f6ff', textDim: '#6fa7bd', accent: '#5ff0ff',
      danger: '#ff5f6d', success: '#5ff0a0', water: '#3ea8c8',
      slot: 'rgba(6,16,26,.9)', slotSelected: '#5ff0ff',
      bgPlaceholder: '#050d14',
    },
    teams: ['#ff5f6d', '#5ff0ff', '#b45fff', '#ffd23e'],
    iconStyle: 'bitmap',
  },
  cozy: {
    id: 'cozy', label: '温馨卡通',
    cell: 6, border: { size: 2, style: 'soft' }, radius: 12,
    fontStack: '"Microsoft YaHei", "PingFang SC", sans-serif', letterSpacing: 0,
    textShadow: '0 1px 0 rgba(255,255,255,.5)',
    palette: {
      panelBg: 'rgba(255,250,240,.95)', panelBgAlt: 'rgba(250,240,225,.92)', border: '#d8b890',
      borderLight: 'rgba(255,255,255,.8)', borderDark: 'rgba(180,140,100,.4)',
      text: '#5a4632', textDim: '#a08968', accent: '#f0864f',
      danger: '#e5696b', success: '#7ab86a', water: '#6ab8d4',
      slot: '#fff8ec', slotSelected: '#f0864f',
      bgPlaceholder: '#f3e3c8',
    },
    teams: ['#f0864f', '#6aa6d8', '#7ab86a', '#c98ad4'],
    iconStyle: 'bitmap',
  },
  horror: {
    id: 'horror', label: '暗夜恐怖',
    cell: 4, border: { size: 1, style: 'thin' }, radius: 1,
    fontStack: '"Courier New", "SimSun", monospace', letterSpacing: 2,
    textShadow: '0 0 6px rgba(180,20,20,.6)',
    palette: {
      panelBg: 'rgba(14,12,13,.92)', panelBgAlt: 'rgba(20,16,17,.88)', border: '#3a1416',
      borderLight: 'rgba(160,40,40,.5)', borderDark: 'rgba(0,0,0,.8)',
      text: '#cfc3bb', textDim: '#7a6e68', accent: '#c22e2e',
      danger: '#c22e2e', success: '#8a9a6a', water: '#4a5a6a',
      slot: '#0d0b0c', slotSelected: '#c22e2e',
      bgPlaceholder: '#0a0809',
    },
    teams: ['#c22e2e', '#5a5a8a', '#6a8a5a', '#8a7a4a'],
    iconStyle: 'bitmap',
  },
};
export function themeFor(artStyle) { return THEMES[artStyle] || THEMES.pixel; }

/* ============ 组件库 ============ */
/**
 * build(kind, spec, theme) → { kind, w, h, prims: [...] }
 * prim: {t:'rect'|'icon'|'text'|'bar'|'slot', x,y,w,h, ...样式引用(角色色名，不写死颜色)}
 * 颜色一律用角色名（panelBg/accent/teams.0…），渲染层查主题表 —— 保证套系一致。
 */
const S = (n, theme) => Math.round(n * theme.cell); // cell 度量

export function build(kind, spec = {}, theme) {
  const c = theme.palette;
  const k = {
    hotbar: buildHotbar, hearts: buildHearts, armorBar: buildIconRow('shield'),
    hunger: buildIconRow('potion'), xpBar: buildXpBar, nameplate: buildNameplate,
    bossbar: buildBossbar, killfeed: buildKillfeed, minimapFrame: buildMinimap,
    scoreboard: buildScoreboard, timer: buildTimer, teamScore: buildTeamScore,
    crosshair: buildCrosshair, toast: buildToast, dialog: buildDialog,
    shopGrid: buildShopGrid, buffRow: buildBuffRow, ammoCounter: buildAmmo,
    joystick: buildJoystick, jumpBtn: buildJumpBtn,
  }[kind];
  if (!k) throw new Error(`unknown component kind: ${kind}`);
  return k(spec, theme, c);
}

function pad(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }

function buildHotbar(spec, theme) {
  const slots = spec.slots || 9;
  const cellPx = S(9, theme), gap = theme.border.size + 1;
  const w = slots * cellPx + (slots + 1) * gap, h = cellPx + 2 * gap;
  const prims = [{ t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' }];
  for (let i = 0; i < slots; i += 1) {
    prims.push({ t: 'slot', x: gap + i * (cellPx + gap), y: gap, w: cellPx, h: cellPx, selected: i === (spec.selected ?? 0), count: i < 4 ? String(i + 1) : null });
    if (spec.items && spec.items[i]) prims.push({ t: 'icon', icon: spec.items[i], x: gap + i * (cellPx + gap) + S(1.6, theme), y: gap + S(1.6, theme), w: S(6, theme), h: S(6, theme) });
  }
  return { kind: 'hotbar', w, h, prims };
}

function buildHearts(spec, theme) {
  const n = spec.max ?? 10, hp = spec.hp ?? 18; // hp 半心计数（20=满10心）
  const cellPx = S(3.8, theme), gap = 1;
  const w = n * cellPx + (n - 1) * gap, h = cellPx;
  const prims = [];
  for (let i = 0; i < n; i += 1) {
    const state = hp >= (i + 1) * 2 ? 'full' : hp === i * 2 + 1 ? 'half' : 'empty';
    prims.push({ t: 'icon', icon: 'heart', state, x: i * (cellPx + gap), y: 0, w: cellPx, h: cellPx });
  }
  return { kind: 'hearts', w, h, prims };
}

function buildIconRow(icon) {
  return (spec, theme) => {
    const n = spec.max ?? 10, val = spec.val ?? 7;
    const cellPx = S(3.8, theme), gap = 1;
    const prims = [];
    for (let i = 0; i < n; i += 1) prims.push({ t: 'icon', icon, state: i < val ? 'full' : 'empty', x: i * (cellPx + gap), y: 0, w: cellPx, h: cellPx });
    return { kind: `${icon}Row`, w: n * cellPx + (n - 1) * gap, h: cellPx, prims };
  };
}

function buildXpBar(spec, theme) {
  const w = spec.w ?? S(46, theme), h = S(3.2, theme), pct = spec.pct ?? 0.62;
  const prims = [
    { t: 'rect', x: 0, y: 0, w, h, fill: 'panelBgAlt', role: 'panel' },
    { t: 'bar', x: 1, y: 1, w: w - 2, h: h - 2, pct, fill: 'success' },
    { t: 'text', x: w / 2, y: h / 2, text: String(spec.level ?? 24), size: h * 0.9, color: 'accent', align: 'center', valign: 'middle', bold: true },
  ];
  return { kind: 'xpBar', w, h, prims };
}

function buildNameplate(spec, theme) {
  const name = spec.name ?? '玩家名', team = spec.team ?? 0;
  const w = spec.w ?? S(20, theme), h = S(4, theme);
  const prims = [
    { t: 'rect', x: 0, y: 0, w, h: S(0.8, theme), fill: `teams.${team}` },
    { t: 'rect', x: 0, y: S(0.8, theme), w, h: h - S(0.8, theme), fill: 'panelBg', role: 'panel' },
    { t: 'text', x: w / 2, y: S(0.8, theme) + (h - S(0.8, theme)) / 2, text: name, size: S(2.4, theme), color: 'text', align: 'center', valign: 'middle' },
    { t: 'bar', x: S(1, theme), y: h - S(1.2, theme), w: w - S(2, theme), h: S(0.8, theme), pct: spec.hpPct ?? 0.85, fill: 'danger' },
  ];
  return { kind: 'nameplate', w, h, prims };
}

function buildBossbar(spec, theme) {
  const w = spec.w ?? S(60, theme), h = S(3.6, theme), pct = spec.pct ?? 0.45;
  return { kind: 'bossbar', w, h, prims: [
    { t: 'rect', x: 0, y: 0, w, h, fill: 'panelBgAlt', role: 'panel' },
    { t: 'bar', x: 2, y: S(1.2, theme), w: w - 4, h: S(1.6, theme), pct, fill: 'danger' },
    { t: 'text', x: w / 2, y: S(0.9, theme), text: spec.name ?? '岩浆巨兽', size: S(2, theme), color: 'text', align: 'center', valign: 'middle' },
  ] };
}

function buildKillfeed(spec, theme) {
  const rows = spec.rows ?? [
    { killer: '红方·阿豪', icon: 'sword', victim: '蓝方·小蓝', teamK: 0, teamV: 1 },
    { killer: '绿方·叶叶', icon: 'skull', victim: '红方·阿豪', teamK: 2, teamV: 0 },
    { killer: '黄方·闪闪', icon: 'sword', victim: '绿方·叶叶', teamK: 3, teamV: 2 },
  ];
  const rowH = S(3, theme) + 2, w = S(26, theme), h = rows.length * rowH + 4;
  const prims = [{ t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' }];
  rows.forEach((r, i) => {
    const y = 2 + i * rowH;
    prims.push({ t: 'text', x: 4, y: y + rowH / 2, text: r.killer, size: S(2, theme), color: `teams.${r.teamK}`, valign: 'middle' });
    prims.push({ t: 'icon', icon: r.icon, x: S(11, theme), y: y + (rowH - S(2.4, theme)) / 2, w: S(2.4, theme), h: S(2.4, theme) });
    prims.push({ t: 'text', x: S(14.5, theme), y: y + rowH / 2, text: r.victim, size: S(2, theme), color: `teams.${r.teamV}`, valign: 'middle' });
  });
  return { kind: 'killfeed', w, h, prims };
}

function buildMinimap(spec, theme) {
  const size = spec.size ?? S(20, theme);
  return { kind: 'minimapFrame', w: size, h: size, prims: [
    { t: 'rect', x: 0, y: 0, w: size, h: size, fill: 'panelBgAlt', role: 'panel' },
    { t: 'rect', x: S(2, theme), y: S(2, theme), w: size - S(4, theme), h: size - S(4, theme), fill: 'water', alpha: 0.35, minimap: true },
    { t: 'icon', icon: 'flag', x: S(4, theme), y: S(5, theme), w: S(2.4, theme), h: S(2.4, theme), tint: 'teams.0' },
    { t: 'icon', icon: 'flag', x: size - S(6, theme), y: S(8, theme), w: S(2.4, theme), h: S(2.4, theme), tint: 'teams.1' },
    { t: 'text', x: size / 2, y: 4, text: 'N', size: S(2, theme), color: 'accent', align: 'center', bold: true },
  ] };
}

function buildScoreboard(spec, theme) {
  const teams = spec.teams ?? [
    { name: '红方', score: 3, team: 0 }, { name: '蓝方', score: 2, team: 1 },
    { name: '绿方', score: 2, team: 2 }, { name: '黄方', score: 1, team: 3 },
  ];
  const w = S(18, theme), rowH = S(3, theme), h = rowH * (teams.length + 1) + 4;
  const prims = [{ t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' },
    { t: 'text', x: 6, y: rowH / 2 + 2, text: '队伍积分', size: S(2, theme), color: 'textDim', valign: 'middle' }];
  teams.forEach((tRow, i) => {
    const y = 2 + rowH * (i + 1);
    prims.push({ t: 'rect', x: 3, y: y + rowH / 2 - S(0.8, theme), w: S(1.6, theme), h: S(1.6, theme), fill: `teams.${tRow.team}` });
    prims.push({ t: 'text', x: S(4, theme), y: y + rowH / 2, text: tRow.name, size: S(2, theme), color: 'text', valign: 'middle' });
    prims.push({ t: 'text', x: w - 6, y: y + rowH / 2, text: String(tRow.score), size: S(2.2, theme), color: 'accent', align: 'right', valign: 'middle', bold: true });
  });
  return { kind: 'scoreboard', w, h, prims };
}

function buildTimer(spec, theme) {
  const w = S(14, theme), h = S(5, theme);
  const secs = spec.seconds ?? 245;
  return { kind: 'timer', w, h, prims: [
    { t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' },
    { t: 'text', x: w / 2, y: h * 0.38, text: `${pad(secs / 60)}:${pad(secs % 60)}`, size: S(2.8, theme), color: 'text', align: 'center', valign: 'middle', bold: true },
    { t: 'text', x: w / 2, y: h * 0.78, text: spec.label ?? '回合剩余', size: S(1.6, theme), color: 'textDim', align: 'center', valign: 'middle' },
  ] };
}

function buildTeamScore(spec, theme) {
  const teams = spec.teams ?? [{ team: 0, score: 3 }, { team: 1, score: 2 }, { team: 2, score: 2 }, { team: 3, score: 1 }];
  const chipW = S(3.6, theme), gap = S(0.8, theme), h = S(4.2, theme);
  const prims = [{ t: 'rect', x: 0, y: 0, w: teams.length * chipW + (teams.length - 1) * gap, h, fill: 'panelBg', role: 'panel' }];
  teams.forEach((tRow, i) => {
    const x = i * (chipW + gap);
    prims.push({ t: 'rect', x, y: 0, w: chipW, h: S(1, theme), fill: `teams.${tRow.team}` });
    prims.push({ t: 'rect', x: x + 2, y: h * 0.55 - S(0.7, theme), w: S(1.4, theme), h: S(1.4, theme), fill: `teams.${tRow.team}` });
    prims.push({ t: 'text', x: x + chipW - 3, y: h * 0.6, text: String(tRow.score), size: S(2, theme), color: 'text', align: 'right', valign: 'middle', bold: true });
  });
  return { kind: 'teamScore', w: teams.length * chipW + (teams.length - 1) * gap, h, prims };
}

function buildCrosshair(spec, theme) {
  const size = S(3, theme), variant = spec.variant ?? 'plus';
  const prims = [{ t: 'crosshair', x: 0, y: 0, w: size, h: size, variant, color: 'accent' }];
  return { kind: 'crosshair', w: size, h: size, prims };
}

function buildToast(spec, theme) {
  const lines = spec.lines ?? ['获得 铁剑 ×1', '任务完成：占领中央高地'];
  const w = S(24, theme), rowH = S(2.6, theme), h = lines.length * rowH + S(1.6, theme);
  const prims = [{ t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel', alpha: 0.92 }];
  lines.forEach((line, i) => prims.push({ t: 'text', x: S(1.6, theme), y: S(0.8, theme) + rowH * (i + 0.5), text: line, size: S(1.9, theme), color: i === 0 ? 'accent' : 'text', valign: 'middle' }));
  return { kind: 'toast', w, h, prims };
}

function buildDialog(spec, theme) {
  const w = spec.w ?? S(40, theme), h = S(16, theme);
  return { kind: 'dialog', w, h, prims: [
    { t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' },
    { t: 'rect', x: 0, y: 0, w, h: S(0.8, theme), fill: 'accent' },
    { t: 'text', x: S(2, theme), y: S(2.6, theme), text: spec.title ?? '神秘商人', size: S(2.6, theme), color: 'accent', bold: true },
    { t: 'text', x: S(2, theme), y: S(6, theme), text: spec.body ?? '要用 3 块铁锭换这把传说铁剑吗？', size: S(1.9, theme), color: 'text' },
    { t: 'button', x: w - S(19, theme), y: h - S(5, theme), w: S(8, theme), h: S(3, theme), label: '成交', primary: true },
    { t: 'button', x: w - S(9.6, theme), y: h - S(5, theme), w: S(8, theme), h: S(3, theme), label: '再见', primary: false },
  ] };
}

function buildShopGrid(spec, theme) {
  const cols = 3, rows = 2, cellPx = S(7, theme), gap = S(0.8, theme);
  const items = spec.items ?? ['sword', 'block', 'potion', 'shield', 'pickaxe', 'flame'];
  const prices = spec.prices ?? [12, 4, 8, 15, 10, 20];
  const w = cols * cellPx + (cols + 1) * gap, h = S(3.4, theme) + rows * cellPx + (rows + 1) * gap;
  const prims = [{ t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' },
    { t: 'text', x: gap, y: S(1.8, theme), text: '战备商店', size: S(2.2, theme), color: 'accent', bold: true, valign: 'middle' }];
  items.slice(0, cols * rows).forEach((item, i) => {
    const cx = gap + (i % cols) * (cellPx + gap), cy = S(3.4, theme) + gap + Math.floor(i / cols) * (cellPx + gap);
    prims.push({ t: 'slot', x: cx, y: cy, w: cellPx, h: cellPx, selected: false });
    prims.push({ t: 'icon', icon: item, x: cx + S(1, theme), y: cy + S(0.8, theme), w: S(5, theme), h: S(5, theme) });
    prims.push({ t: 'text', x: cx + cellPx - 2, y: cy + cellPx - S(1.6, theme), text: String(prices[i] ?? 0), size: S(1.8, theme), color: 'accent', align: 'right', valign: 'middle', bold: true });
  });
  return { kind: 'shopGrid', w, h, prims };
}

function buildBuffRow(spec, theme) {
  const buffs = spec.buffs ?? [{ icon: 'star', sec: 42 }, { icon: 'flame', sec: 8 }, { icon: 'shield', sec: 95 }, { icon: 'snowball', sec: 3 }];
  const cellPx = S(3.2, theme), gap = S(0.6, theme);
  const prims = [];
  buffs.forEach((b, i) => {
    const x = i * (cellPx + gap);
    prims.push({ t: 'rect', x, y: 0, w: cellPx, h: cellPx, fill: 'panelBgAlt', role: 'panel' });
    prims.push({ t: 'icon', icon: b.icon, x: x + S(0.6, theme), y: S(0.6, theme), w: S(2, theme), h: S(2, theme) });
    prims.push({ t: 'text', x: x + cellPx / 2, y: cellPx - S(1, theme), text: String(b.sec), size: S(1.4, theme), color: 'text', align: 'center', valign: 'middle' });
  });
  return { kind: 'buffRow', w: buffs.length * cellPx + (buffs.length - 1) * gap, h: cellPx, prims };
}

function buildAmmo(spec, theme) {
  const w = S(8, theme), h = S(4.6, theme);
  return { kind: 'ammoCounter', w, h, prims: [
    { t: 'rect', x: 0, y: 0, w, h, fill: 'panelBg', role: 'panel' },
    { t: 'text', x: w / 2, y: h * 0.42, text: String(spec.mag ?? 24), size: S(2.6, theme), color: 'text', align: 'center', valign: 'middle', bold: true },
    { t: 'text', x: w / 2, y: h * 0.8, text: `/ ${spec.reserve ?? 96}`, size: S(1.6, theme), color: 'textDim', align: 'center', valign: 'middle' },
  ] };
}

function buildJoystick(spec, theme) {
  const size = spec.size ?? S(15, theme);
  return { kind: 'joystick', w: size, h: size, prims: [
    { t: 'circle', x: 0, y: 0, w: size, h: size, fill: 'panelBg', alpha: 0.6, role: 'panel' },
    { t: 'circle', x: size * 0.25, y: size * 0.25, w: size * 0.5, h: size * 0.5, fill: 'slotSelected', alpha: 0.8 },
  ] };
}
function buildJumpBtn(spec, theme) {
  const size = spec.size ?? S(8, theme);
  return { kind: 'jumpBtn', w: size, h: size, prims: [
    { t: 'circle', x: 0, y: 0, w: size, h: size, fill: 'panelBg', alpha: 0.6, role: 'panel' },
    { t: 'text', x: size / 2, y: size / 2, text: '跳', size: size * 0.4, color: 'text', align: 'center', valign: 'middle' },
  ] };
}

/** 组件清单与默认锚点声明（供布局求解器消费） */
export const COMPONENT_META = {
  hotbar: { anchor: 'bottom-center', layer: 'hud', priority: 10 },
  hearts: { anchor: 'bottom-center', layer: 'hud', priority: 9, stackAbove: 'hotbar' },
  armorBar: { anchor: 'bottom-center', layer: 'hud', priority: 8, stackAbove: 'hearts', beside: 'hunger' },
  hunger: { anchor: 'bottom-center', layer: 'hud', priority: 8, besideOf: 'armorBar' },
  xpBar: { anchor: 'bottom-center', layer: 'hud', priority: 7, stackAbove: 'armorBar' },
  nameplate: { anchor: 'top-center', layer: 'hud', priority: 5 },
  bossbar: { anchor: 'top-center', layer: 'hud', priority: 6, stackBelow: 'nameplate' },
  killfeed: { anchor: 'right-top', layer: 'hud', priority: 4, stackBelow: 'scoreboard' },
  minimapFrame: { anchor: 'right-top', layer: 'hud', priority: 9 },
  scoreboard: { anchor: 'right-top', layer: 'hud', priority: 8, stackBelow: 'minimapFrame' },
  timer: { anchor: 'top-center', layer: 'hud', priority: 9, beside: 'teamScore' },
  teamScore: { anchor: 'top-center', layer: 'hud', priority: 9, besideOf: 'timer' },
  crosshair: { anchor: 'center', layer: 'hud', priority: 1 },
  toast: { anchor: 'bottom-right', layer: 'toast', priority: 3 },
  dialog: { anchor: 'center', layer: 'dialog', priority: 2 },
  shopGrid: { anchor: 'center', layer: 'dialog', priority: 3 },
  buffRow: { anchor: 'bottom-right', layer: 'hud', priority: 5, stackAbove: 'ammoCounter' },
  ammoCounter: { anchor: 'bottom-right', layer: 'hud', priority: 6, stackAbove: 'toast' },
  joystick: { anchor: 'left-bottom', layer: 'hud', priority: 10, mobileOnly: true },
  jumpBtn: { anchor: 'right-bottom', layer: 'hud', priority: 10, mobileOnly: true },
};
