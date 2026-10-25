/**
 * ui-layout-solver.mjs — UI 布局求解器 (UILayout/0.2)
 *
 * 输入 GDD.ui.components + ui-theme-kit 组件，输出三档分辨率的摆放：
 *   desktop 1366×768 / laptop 989×600 / mobile 390×844
 * 能力：锚点槽位垂直堆叠（槽内顺序表驱动）、并排对（计时↔队伍分、护甲↔饥饿）、
 *       状态互斥（play/modal：准星与商店弹窗不同帧）、防碰撞推挤、安全区、密度间距、
 *       移动端缩放与降显（killfeed/scoreboard/bossbar 收起，摇杆/跳跃键出现）。
 */
import { build, COMPONENT_META, themeFor } from './prism-kit.mjs';

export const PROFILES = {
  desktop: { w: 1366, h: 768, margin: 24, scale: 1, hudScale: 1 },
  laptop: { w: 989, h: 600, margin: 16, scale: 0.9, hudScale: 0.88 },
  mobile: { w: 390, h: 844, margin: 12, scale: 0.72, hudScale: 0.8 },
};
const DENSITY_GAP = { compact: 0.6, medium: 1, airy: 1.5, dense: 0.8 };
/** 每个锚点槽内的自锚点起的堆叠顺序（bottom 槽=自底向上，top 槽=自顶向下） */
const SLOT_ORDER = {
  'bottom-center': ['hotbar', 'hearts', 'armorBar', 'hunger', 'xpBar'],
  'top-center': ['timer', 'teamScore', 'nameplate', 'bossbar'],
  'right-top': ['minimapFrame', 'scoreboard', 'killfeed'],
  'bottom-right': ['toast', 'ammoCounter', 'buffRow'],
  'left-bottom': ['joystick'],
  'right-bottom': ['jumpBtn'],
  center: ['crosshair', 'dialog', 'shopGrid'],
};
const STATE_OF = { crosshair: 'play', dialog: 'modal', shopGrid: 'modal' };
const besideOf = (kind) => ({ teamScore: 'timer', hunger: 'armorBar' }[kind] || null);

export function solveLayout({ gdd, profileId = 'desktop', extraComponents = [] }) {
  const profile = PROFILES[profileId];
  const baseTheme = themeFor(gdd.artStyle);
  const gap = Math.round(8 * DENSITY_GAP[gdd.ui?.density || 'medium'] * profile.scale);
  const theme = profileId === 'mobile' ? { ...baseTheme, cell: Math.max(2, baseTheme.cell * profile.hudScale) } : baseTheme;

  const wanted = [
    ...(gdd.ui?.components || []).map((c) => ({ kind: c.kind, spec: c.bindings || {} })),
    ...extraComponents,
  ];
  const comps = [];
  for (const w of wanted) {
    const meta = COMPONENT_META[w.kind];
    if (!meta) continue;
    if (meta.mobileOnly && profileId !== 'mobile') continue;
    const hidden = profileId === 'mobile' && ['killfeed', 'scoreboard', 'bossbar'].includes(w.kind);
    comps.push({ kind: w.kind, meta, built: build(w.kind, w.spec, theme), hidden });
  }

  const placements = new Map();
  const groups = new Map();
  for (const c of comps) {
    if (c.hidden) continue;
    const a = c.meta.anchor;
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(c);
  }

  for (const [anchor, list] of groups) {
    const isBottom = anchor.includes('bottom');
    const order = SLOT_ORDER[anchor] || [];
    const ordered = [
      ...order.filter((k) => list.some((c) => c.kind === k)).map((k) => list.find((c) => c.kind === k)),
      ...list.filter((c) => !order.includes(c.kind)),
    ];
    const main = ordered.filter((c) => !besideOf(c.kind));
    const beside = ordered.filter((c) => besideOf(c.kind));
    const groupKinds = new Set();
    // center 锚点：屏幕正中
    if (anchor === 'center') {
      for (const c of main) {
        const x = Math.round(profile.w / 2 - c.built.w / 2);
        const y = Math.round(profile.h / 2 - c.built.h / 2);
        placements.set(c.kind, { x, y, w: c.built.w, h: c.built.h, built: c.built, hidden: false });
        groupKinds.add(c.kind);
      }
    } else {
      let cursor = isBottom ? profile.h - profile.margin : profile.margin;
      for (const c of main) {
        const y = isBottom ? cursor - c.built.h : cursor;
        placements.set(c.kind, { x: 0, y, w: c.built.w, h: c.built.h, built: c.built, hidden: false });
        groupKinds.add(c.kind);
        cursor = isBottom ? y - gap : y + c.built.h + gap;
      }
      // 槽内水平对齐（仅本组）
      const alignX = (p) => {
        if (anchor.includes('center')) return Math.round(profile.w / 2 - p.w / 2);
        if (anchor.startsWith('right')) return profile.w - profile.margin - p.w;
        return profile.margin;
      };
      for (const kind of groupKinds) placements.get(kind).x = alignX(placements.get(kind));
    }
    // 并排对：跟随参照物右侧（参照不存在则按主堆叠对齐）
    for (const c of beside) {
      const ref = placements.get(besideOf(c.kind));
      const p = { x: 0, y: 0, w: c.built.w, h: c.built.h, built: c.built, hidden: false };
      if (ref) {
        p.x = ref.x + ref.w + gap;
        p.y = ref.y + (ref.h - p.h) / 2;
      } else if (anchor === 'center') {
        p.x = Math.round(profile.w / 2 - p.w / 2);
        p.y = Math.round(profile.h / 2 - p.h / 2);
      } else {
        p.y = isBottom ? cursor - p.h : cursor;
        cursor = isBottom ? p.y - gap : p.y + p.h + gap;
        p.x = anchor.startsWith('right') ? profile.w - profile.margin - p.w : (anchor.includes('center') ? Math.round(profile.w / 2 - p.w / 2) : profile.margin);
      }
      placements.set(c.kind, p);
      groupKinds.add(c.kind);
    }
    // 并排对导致超宽时整组平移回中（仅居中槽、仅本组）
    if (anchor.includes('center') && anchor !== 'center' && groupKinds.size > 1) {
      const ps = [...groupKinds].map((k) => placements.get(k));
      const minX = Math.min(...ps.map((p) => p.x));
      const maxX = Math.max(...ps.map((p) => p.x + p.w));
      const shift = Math.round(profile.w / 2 - (minX + maxX) / 2);
      for (const p of ps) p.x += shift;
    }
  }
  for (const c of comps) if (c.hidden && !placements.has(c.kind)) placements.set(c.kind, { x: -1, y: -1, w: c.built.w, h: c.built.h, built: c.built, hidden: true });

  // modal 互斥：同帧只保留优先级最高的弹窗（dialog/shopGrid 不并存）
  const modalKinds = [...placements.entries()].filter(([k, p]) => !p.hidden && (STATE_OF[k] === 'modal')).sort((a, b) => (b[1].built.priority || 0) - (a[1].built.priority || 0));
  for (const [kind, p] of modalKinds.slice(1)) { p.hidden = true; p.modalHidden = true; }

  // 防碰撞（仅同状态可见件）：迭代分离 —— 先尝试水平推开（受安全区约束），
  // 水平放不下则垂直分离（低优先级者抬高），直到无重叠或到达迭代上限。
  const stateOf = (kind) => STATE_OF[kind] || 'play';
  const visible = [...placements.entries()].filter(([, p]) => !p.hidden).sort((a, b) => (b[1].built.priority || 0) - (a[1].built.priority || 0));
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  let moved = true;
  let guard = 0;
  while (moved && guard < 24) {
    moved = false;
    guard += 1;
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const [ka, a] = visible[i]; const [kb, b] = visible[j];
        if (stateOf(ka) !== stateOf(kb)) continue;
        if (!hit(a, b)) continue;
        const cx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
        const leftX = a.x - b.w - gap;
        const rightX = a.x + a.w + gap;
        const canLeft = leftX >= 4;
        const canRight = rightX + b.w <= profile.w - 4;
        if (canLeft && (cx > profile.w / 2 || !canRight)) b.x = leftX;
        else if (canRight) b.x = rightX;
        else {
          const aboveY = a.y - b.h - gap;
          if (aboveY >= 4) b.y = aboveY;
          else b.y = Math.min(profile.h - 4 - b.h, a.y + a.h + gap);
        }
        moved = true;
      }
    }
  }
  for (const p of placements.values()) {
    if (p.hidden) continue;
    p.x = Math.max(4, Math.min(p.x, profile.w - p.w - 4));
    p.y = Math.max(4, Math.min(p.y, profile.h - p.h - 4));
  }
  const metrics = {
    overlapCount: countOverlaps(placements, stateOf),
    outOfBoundsCount: countOutOfBounds(placements, profile),
    placed: [...placements.values()].filter((p) => !p.hidden).length,
    hidden: [...placements.values()].filter((p) => p.hidden).length,
  };
  return { profileId, profile, theme, placements: Object.fromEntries(placements), metrics };
}

function countOverlaps(placements, stateOf) {
  const list = [...placements.entries()].filter(([, p]) => !p.hidden);
  let n = 0;
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const [ka, a] = list[i]; const [kb, b] = list[j];
    if (stateOf(ka) !== stateOf(kb)) continue;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n += 1;
  }
  return n;
}
function countOutOfBounds(placements, profile) {
  let n = 0;
  for (const p of placements.values()) {
    if (p.hidden) continue;
    if (p.x < 0 || p.y < 0 || p.x + p.w > profile.w || p.y + p.h > profile.h) n += 1;
  }
  return n;
}

export function solveAllResolutions({ gdd, extraComponents = [] }) {
  const out = {};
  for (const id of Object.keys(PROFILES)) out[id] = solveLayout({ gdd, profileId: id, extraComponents });
  return out;
}
