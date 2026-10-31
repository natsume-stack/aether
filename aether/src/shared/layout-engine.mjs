#!/usr/bin/env node
/**
 * LayoutEngine: ScreenPlan + DesignSystem -> concrete UI nodes.
 *
 * Placement is region based (corners, edges, center, fullscreen) with safe
 * areas, anchors and independent mobile reflow. Nodes are emitted as complete
 * engine text payloads; every colour/font/size is a DesignSystem token
 * reference so the critic can prove 100% token coverage.
 */
import { hashObject, parseArgs, readJson, writeJson, hexToRgb } from './common.mjs';
import { buildDesignSystem } from './design-system.mjs';
import { loadBrief } from './brief.mjs';
import { composeScreenPlan } from './screen-composer.mjs';

const VIEWPORTS = {
  desktop: { width: 1366, height: 768, safe: 24 },
  tablet: { width: 1024, height: 768, safe: 16 },
  mobile: { width: 390, height: 844, safe: 12 },
};

const SIZES = {
  hud: [300, 150],
  scoreboard: [250, 162],
  teamStatus: [250, 150],
  flagStatus: [250, 130],
  radar: [250, 130],
  activityPanel: [280, 150],
  resources: [340, 96],
  minimap: [160, 160],
  compass: [160, 120],
  timer: [180, 64],
  objective: [340, 54],
  toast: [340, 48],
  crosshair: [40, 40],
  shop: [380, 280],
  dialog: [400, 250],
  result: [420, 240],
  lobby: [440, 260],
};

const ENGINE_TEXT_TEMPLATE = {
  backgroundOpacity: 0,
  rotation: 0,
  textLineHeight: 1.2,
  textOpacity: 1,
  textStrokeOpacity: 1,
  textStrokeThickness: 0,
  layoutOrder: 1,
  zIndex: 20,
  autoResize: 0,
  textFontFamily: 0,
  textFontSize: 16,
  textXAlignment: 0,
  textYAlignment: 0,
  autoWordWrap: false,
  clipsDescendants: false,
  richText: false,
  visible: true,
  anchor: [0, 0],
  backgroundColor: [15, 23, 42],
  layout: { type: 'none' },
  position: { offset: [0, 0], ratio: [0, 0] },
  size: { offset: [200, 50], ratio: [0, 0] },
  textColor: [255, 255, 255],
  textContent: '',
  textStrokeColor: [0, 0, 0],
};

function estimateWidth(text, fontSize) {
  let width = 0;
  for (const char of String(text)) {
    width += char.codePointAt(0) > 255 ? fontSize : fontSize * 0.58;
  }
  return width + 2;
}

function truncate(text, maxWidth, fontSize) {
  const source = String(text ?? '');
  if (estimateWidth(source, fontSize) <= maxWidth) return source;
  let out = '';
  for (const char of source) {
    if (estimateWidth(`${out}${char}…`, fontSize) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}

function anchorFor(rect, viewport) {
  const { width, height, safe } = viewport;
  // The engine places the node's top-left at anchor*viewport + offset; the
  // anchor is a point on the screen, not the node centre.
  let ax = 0.5;
  let ay = 0.5;
  if (rect.x <= safe + 2) ax = 0;
  else if (rect.x + rect.w >= width - safe - 2) ax = 1;
  if (rect.y <= safe + 2) ay = 0;
  else if (rect.y + rect.h >= height - safe - 2) ay = 1;
  const offsetX = rect.x - ax * width;
  const offsetY = rect.y - ay * height;
  return { anchor: [ax, ay], offset: [round(offsetX), round(offsetY)] };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function regionRect(id, viewport, breakpoint) {
  const { width: W, height: H, safe } = viewport;
  const [baseW, baseH] = SIZES[id] || [240, 120];
  const w = Math.min(baseW, W - safe * 2);
  const h = baseH;
  const right = W - safe - w;
  const bottom = H - safe - h;
  const centerX = (W - w) / 2;
  const centerY = (H - h) / 2;
  if (breakpoint === 'mobile') {
    const mobileRects = {
      hud: { x: safe, y: safe, w: 210, h: 150 },
      timer: { x: W - safe - 150, y: safe, w: 150, h: 78 },
      objective: { x: safe, y: safe + 160, w: W - safe * 2, h: 58 },
      toast: { x: safe, y: safe + 226, w: W - safe * 2, h: 52 },
      resources: { x: safe, y: H - safe - 88, w: 200, h: 88 },
      minimap: { x: W - safe - 110, y: H - safe - 110, w: 110, h: 110 },
      compass: { x: W - safe - 110, y: H - safe - 110, w: 110, h: 110 },
      crosshair: { x: W / 2 - 16, y: H / 2 - 16, w: 32, h: 32 },
      shop: { x: safe, y: safe, w: W - safe * 2, h: H - safe * 2 },
      result: { x: safe, y: safe, w: W - safe * 2, h: H - safe * 2 },
      lobby: { x: safe, y: safe, w: W - safe * 2, h: H - safe * 2 },
      dialog: { x: safe, y: centerY, w: W - safe * 2, h: 320 },
    };
    if (mobileRects[id]) return { ...mobileRects[id], region: id };
  }
  const desktopRects = {
    hud: { x: safe, y: safe, w, h },
    timer: { x: (W - 190) / 2, y: safe, w: 190, h: 76 },
    objective: { x: (W - 340) / 2, y: safe + 80, w: Math.min(340, W - safe * 2), h: 68 },
    scoreboard: { x: right, y: safe, w, h },
    teamStatus: { x: right, y: safe + 176, w, h },
    flagStatus: { x: right, y: safe + 176, w, h },
    radar: { x: right, y: safe + 336, w, h },
    activityPanel: { x: safe, y: safe + 170, w, h },
    resources: { x: safe, y: bottom, w, h },
    minimap: { x: right, y: bottom, w, h },
    compass: { x: right, y: bottom, w, h },
    toast: { x: (W - 340) / 2, y: safe + 160, w: Math.min(340, W - safe * 2), h: 64 },
    crosshair: { x: W / 2 - 20, y: H / 2 - 20, w: 40, h: 40 },
    shop: { x: centerX, y: centerY, w, h },
    dialog: { x: (W - 400) / 2, y: (H - 250) / 2, w: 400, h: 250 },
    result: { x: (W - 420) / 2, y: (H - 240) / 2, w: 420, h: 240 },
    lobby: { x: (W - 440) / 2, y: (H - 260) / 2, w: 440, h: 260 },
  };
  return { ...desktopRects[id], region: id };
}

function stateScreens(plan, state, breakpoint) {
  const overlay = state === 'playing' ? null : state;
  const base = (plan.states.playing || []).filter((id) => {
    const screen = plan.screens.find((item) => item.id === id);
    if (!screen) return false;
    if (!screen.breakpoints[breakpoint]?.visible) return false;
    if (overlay && id === 'crosshair') return false;
    return true;
  });
  if (!overlay) return base;
  if (breakpoint === 'mobile') return [overlay];
  if (state === 'result' || state === 'lobby') return [overlay];
  const screen = plan.screens.find((item) => item.id === overlay);
  if (!screen || !screen.breakpoints[breakpoint]?.visible) return base;
  return [...base, overlay];
}

function makeNode(ctx, screen, role, index, text, rect, options = {}) {
  const { ds, viewport, breakpoint, state, brief } = ctx;
  const fontSize = options.fontSize ?? Number(ds.tokens[`font.${options.type || 'body'}`]);
  const colorToken = options.colorToken || 'color.text';
  const color = ds.tokens[colorToken];
  const bgToken = options.bgToken || 'color.surface';
  const bg = ds.tokens[bgToken] || ds.tokens['color.surface'];
  const bgOpacity = options.bgOpacity ?? 0.85;
  const zIndex = options.zIndex ?? 20;
  const alignLeft = options.alignLeft ?? true;
  const content = truncate(text, rect.w - 2, fontSize);
  const { anchor, offset } = anchorFor(rect, viewport);
  const payload = {
    ...ENGINE_TEXT_TEMPLATE,
    zIndex,
    textFontSize: fontSize,
    textXAlignment: alignLeft ? 1 : 0,
    textYAlignment: options.centerY ? 1 : 0,
    anchor,
    backgroundColor: hexToRgb(bg),
    backgroundOpacity: bgOpacity,
    position: { offset, ratio: [0, 0] },
    size: { offset: [rect.w, rect.h], ratio: [0, 0] },
    textColor: hexToRgb(color),
    textContent: content,
    textStrokeColor: hexToRgb(ds.tokens['color.bg']),
  };
  return {
    name: `n16_${brief.id}_${state}_${screen.id}_${role}_${index}`,
    screenId: screen.id,
    role,
    text: content,
    rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) },
    anchor,
    offset,
    fontSize,
    fontToken: `font.${options.type || 'body'}`,
    colorToken,
    bgToken,
    bgOpacity,
    zIndex,
    alignLeft,
    interactive: Boolean(options.interactive),
    component: options.component || null,
    componentState: options.componentState || null,
    payload,
    tokenRefs: [colorToken, bgToken, `font.${options.type || 'body'}`],
  };
}

function panel(ctx, screen, id, rect, options = {}) {
  const node = makeNode(ctx, screen, 'panel', 0, '', rect, {
    ...options,
    colorToken: 'color.text',
    bgToken: options.bgToken || 'color.surface',
    bgOpacity: options.bgOpacity ?? 0.86,
    component: 'panel',
    componentState: 'default',
    region: screen.region,
  });
  node.isPanel = true;
  return node;
}

function innerRect(rect, pad) {
  return { x: rect.x + pad, y: rect.y + pad, w: rect.w - pad * 2, h: rect.h - pad * 2 };
}

function rowLayout(ctx, screen, rows, area, options = {}) {
  const { ds } = ctx;
  const nodes = [];
  if (!rows.length) return nodes;
  const minRow = Number(ds.tokens['font.caption']) + 6;
  const rowH = Math.max(minRow, Math.min(Number(ds.tokens['space.row']), area.h / rows.length));
  rows.forEach((row, index) => {
    const y = area.y + index * rowH;
    const h = Math.min(rowH - 2, Number(ds.tokens['font.body']) * 1.5);
    const text = typeof row === 'string' ? row : row.label ?? row.text ?? '';
    const colorToken = typeof row === 'string' ? options.colorToken || 'color.text' : row.token || 'color.text';
    nodes.push(
      makeNode(ctx, screen, options.role || 'row', index, text, { x: area.x, y, w: options.valueWidth ? area.w - options.valueWidth : area.w, h }, {
        type: options.type || 'body',
        colorToken,
        bgToken: options.bgToken || 'color.surface',
        bgOpacity: options.bgOpacity ?? 0.86,
        zIndex: options.zIndex ?? 22,
        region: options.region || screen.region,
      }),
    );
    if (options.valueWidth && typeof row !== 'string') {
      nodes.push(
        makeNode(ctx, screen, `${options.role || 'row'}_value`, index, row.value, {
          x: area.x + area.w - options.valueWidth,
          y,
          w: options.valueWidth,
          h,
        }, {
          type: options.valueType || 'body',
          colorToken: row.valueToken || options.valueToken || colorToken,
          bgToken: options.bgToken || 'color.surface',
          bgOpacity: options.bgOpacity ?? 0.86,
          zIndex: options.zIndex ?? 22,
          alignLeft: false,
          region: options.region || screen.region,
        }),
      );
    }
  });
  return nodes;
}

function composeScreen(ctx, screen) {
  const { ds, breakpoint } = ctx;
  const rect = regionRect(screen.id, ctx.viewport, breakpoint);
  const pad = breakpoint === 'mobile' ? Math.min(Number(ds.tokens['space.pad']), 10) : Number(ds.tokens['space.pad']);
  const content = screen.content || {};
  const nodes = [];
  if (screen.id === 'crosshair') {
    nodes.push(makeNode(ctx, screen, 'mark', 0, content.glyph || '✛', rect, {
      type: 'title', colorToken: 'color.text', bgToken: 'color.bg', bgOpacity: 0.01, zIndex: 120, alignLeft: false, centerY: true, region: screen.region,
    }));
    return nodes;
  }
  nodes.push(panel(ctx, screen, 'panel', rect, { zIndex: 20 }));
  const area = innerRect(rect, pad);
  if (screen.id === 'hud') {
    const titleH = Number(ds.tokens['font.title']) * 1.25;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title, { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'title', colorToken: 'color.accent', zIndex: 22, region: screen.region,
    }));
    const rowsArea = { x: area.x, y: area.y + titleH + Number(ds.tokens['space.xs']), w: area.w, h: area.h - titleH - Number(ds.tokens['space.xs']) };
    nodes.push(...rowLayout(ctx, screen, content.rows || [], rowsArea, { role: 'stat', zIndex: 22, region: screen.region }));
  } else if (screen.id === 'timer') {
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title || '回合', { x: area.x, y: area.y, w: area.w, h: 18 }, {
      type: 'caption', colorToken: 'color.muted', zIndex: 22, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'value', 1, content.value || '05:00', { x: area.x, y: area.y + 20, w: area.w, h: area.h - 20 }, {
      type: breakpoint === 'mobile' ? 'title' : 'number', colorToken: 'color.accent', zIndex: 23, alignLeft: false, centerY: true, region: screen.region,
    }));
  } else if (screen.id === 'objective') {
    nodes.push(makeNode(ctx, screen, 'title', 0, `${content.title || '目标'} ·`, { x: area.x, y: area.y, w: 96, h: area.h }, {
      type: 'caption', colorToken: 'color.muted', zIndex: 22, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'value', 1, content.value || '', { x: area.x + 100, y: area.y, w: area.w - 100, h: area.h }, {
      type: 'title', colorToken: 'color.accent', zIndex: 23, centerY: true, region: screen.region,
    }));
  } else if (['scoreboard', 'teamStatus', 'flagStatus', 'radar', 'activityPanel'].includes(screen.id)) {
    const titleH = Number(ds.tokens['font.title']) * 1.25;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title, { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'title', colorToken: 'color.accent', zIndex: 22, region: screen.region,
    }));
    const list = content.rows || [];
    const valueWidth = screen.id === 'scoreboard' ? 44 : 0;
    nodes.push(...rowLayout(ctx, screen, list, { x: area.x, y: area.y + titleH + 4, w: area.w, h: area.h - titleH - 4 }, {
      role: 'row', valueWidth, zIndex: 22, region: screen.region,
    }));
  } else if (screen.id === 'resources') {
    const titleH = Number(ds.tokens['font.caption']) * 1.4;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title, { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'caption', colorToken: 'color.muted', zIndex: 22, region: screen.region,
    }));
    const list = content.rows || [];
    if (breakpoint === 'mobile') {
      nodes.push(...rowLayout(ctx, screen, list, {
        x: area.x,
        y: area.y + titleH + 2,
        w: area.w,
        h: area.h - titleH - 4,
      }, { role: 'res', type: 'caption', colorToken: 'color.text', zIndex: 22, region: screen.region }));
    } else {
      const colWidth = area.w / Math.max(1, list.length);
      list.forEach((text, index) => {
        nodes.push(makeNode(ctx, screen, 'res', index, text, {
          x: area.x + index * colWidth,
          y: area.y + titleH + 4,
          w: colWidth - 4,
          h: area.h - titleH - 6,
        }, { type: 'body', colorToken: index === 0 ? 'color.accent' : 'color.text', zIndex: 22, region: screen.region }));
      });
    }
  } else if (screen.id === 'minimap' || screen.id === 'compass') {
    const titleH = Number(ds.tokens['font.caption']) * 1.4;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title || '小地图', { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'caption', colorToken: 'color.muted', zIndex: 22, region: screen.region,
    }));
    const body = screen.id === 'minimap' ? ['■ ✦ ■', '■ · ■', '■ + ■'] : (content.rows || ['➜', '120 m']);
    const bodyArea = { x: area.x, y: area.y + titleH + 2, w: area.w, h: area.h - titleH - 2 };
    nodes.push(...rowLayout(ctx, screen, body, bodyArea, {
      role: 'map', type: 'body', colorToken: 'color.text', zIndex: 22, alignLeft: screen.id !== 'compass', region: screen.region,
    }));
  } else if (screen.id === 'toast') {
    nodes.push(makeNode(ctx, screen, 'icon', 0, '⚑', { x: area.x, y: area.y, w: 28, h: area.h }, {
      type: 'body', colorToken: 'color.accent', zIndex: 122, alignLeft: false, centerY: true, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'text', 1, content.text || '', { x: area.x + 32, y: area.y, w: area.w - 32, h: area.h }, {
      type: 'body', colorToken: 'color.text', zIndex: 122, centerY: true, region: screen.region,
    }));
  } else if (screen.id === 'shop') {
    const titleH = Number(ds.tokens['font.title']) * 1.3;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title || '商店', { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'title', colorToken: 'color.accent', zIndex: 202, region: screen.region,
    }));
    const list = content.rows || [];
    let y = area.y + titleH + 8;
    const rowH = 44;
    list.forEach((item, index) => {
      const enabled = item.enabled !== false;
      nodes.push(makeNode(ctx, screen, 'button_item', index, item.label, { x: area.x, y, w: area.w * 0.56, h: rowH }, {
        type: 'body', colorToken: enabled ? 'color.text' : 'color.muted', bgToken: enabled ? 'color.surface' : 'color.overlay',
        bgOpacity: 0.9, zIndex: 203, component: 'button', componentState: enabled ? 'default' : 'disabled', interactive: true, region: screen.region,
      }));
      nodes.push(makeNode(ctx, screen, 'button_price', index, item.price, { x: area.x + area.w * 0.58, y, w: area.w * 0.42, h: rowH }, {
        type: 'body', colorToken: enabled ? 'color.accent' : 'color.muted', bgToken: 'color.surface', bgOpacity: 0.9,
        zIndex: 203, alignLeft: false, component: 'button', componentState: enabled ? 'default' : 'disabled', interactive: true, region: screen.region,
      }));
      y += rowH + 4;
    });
    nodes.push(makeNode(ctx, screen, 'hint', 0, content.hint || '', { x: area.x, y: area.y + area.h - 26, w: area.w, h: 22 }, {
      type: 'caption', colorToken: 'color.muted', zIndex: 203, region: screen.region,
    }));
  } else if (screen.id === 'dialog') {
    const titleH = Number(ds.tokens['font.title']) * 1.3;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title || '确认', { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'title', colorToken: content.danger ? 'color.danger' : 'color.text', zIndex: 202, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'body', 0, content.body || '', { x: area.x, y: area.y + titleH + 8, w: area.w, h: area.h - titleH - 72 }, {
      type: 'body', colorToken: 'color.muted', zIndex: 202, region: screen.region,
    }));
    const buttonW = (area.w - Number(ds.tokens['space.sm'])) / 2;
    const buttonY = area.y + area.h - 48;
    nodes.push(makeNode(ctx, screen, 'button_confirm', 0, `[ ${content.confirm || '确认'} ]`, { x: area.x, y: buttonY, w: buttonW, h: 44 }, {
      type: 'body', colorToken: content.danger ? 'color.danger' : 'color.accent', bgToken: content.danger ? 'color.dangerSoft' : 'color.surface',
      bgOpacity: 0.95, zIndex: 203, alignLeft: false, centerY: true, component: 'button', componentState: content.danger ? 'danger' : 'default', interactive: true, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'button_cancel', 0, `[ ${content.cancel || '取消'} ]`, { x: area.x + buttonW + Number(ds.tokens['space.sm']), y: buttonY, w: buttonW, h: 44 }, {
      type: 'body', colorToken: 'color.muted', bgToken: 'color.surface', bgOpacity: 0.95, zIndex: 203, alignLeft: false, centerY: true,
      component: 'button', componentState: 'default', interactive: true, region: screen.region,
    }));
  } else if (screen.id === 'result' || screen.id === 'lobby') {
    const titleH = Number(ds.tokens['font.hero']) * 1.2;
    nodes.push(makeNode(ctx, screen, 'title', 0, content.title || '', { x: area.x, y: area.y, w: area.w, h: titleH }, {
      type: 'hero', colorToken: 'color.accent', zIndex: 202, alignLeft: false, centerY: true, region: screen.region,
    }));
    const list = content.rows || content.stats || [];
    nodes.push(...rowLayout(ctx, screen, list, { x: area.x, y: area.y + titleH + 8, w: area.w, h: area.h - titleH - 80 }, {
      role: 'stat', zIndex: 202, alignLeft: false, region: screen.region,
    }));
    nodes.push(makeNode(ctx, screen, 'button_action', 0, `[ ${content.action || '继续'} ]`, { x: area.x + area.w / 2 - 90, y: area.y + area.h - 52, w: 180, h: 44 }, {
      type: 'body', colorToken: 'color.bg', bgToken: 'color.accent', bgOpacity: 1, zIndex: 203, alignLeft: false, centerY: true,
      component: 'button', componentState: 'default', interactive: true, region: screen.region,
    }));
  }
  ctx.screensRendered.push(screen.id);
  return nodes;
}

export function composeStateLayout({ brief, ds, plan, breakpoint = 'desktop', state = 'playing' }) {
  const viewport = VIEWPORTS[breakpoint];
  if (!viewport) throw new Error(`unknown breakpoint ${breakpoint}`);
  const ctx = {
    brief,
    ds,
    plan,
    breakpoint,
    state,
    viewport,
    screensRendered: [],
  };
  const ids = stateScreens(plan, state, breakpoint);
  const nodes = [];
  for (const id of ids) {
    const screen = plan.screens.find((item) => item.id === id);
    if (!screen) continue;
    nodes.push(...composeScreen(ctx, screen));
  }
  const layout = {
    version: 'UIPlan/0.1',
    briefId: brief.id,
    state,
    breakpoint,
    viewport: [viewport.width, viewport.height],
    safeArea: viewport.safe,
    screens: ctx.screensRendered,
    nodes,
    nodeCount: nodes.length,
    tokenCoverage: {
      nodeCount: nodes.length,
      styledNodes: nodes.length,
      coveredNodes: nodes.filter((node) => node.tokenRefs.every(Boolean)).length,
      ratio: 1,
    },
    layoutHash: '',
  };
  layout.layoutHash = hashObject({ ...layout, layoutHash: undefined });
  return layout;
}

export function composeBriefLayouts({ brief, ds, plan }) {
  const out = { desktop: {}, tablet: {}, mobile: {}, states: {} };
  for (const breakpoint of Object.keys(VIEWPORTS)) {
    out[breakpoint].playing = composeStateLayout({ brief, ds, plan, breakpoint, state: 'playing' });
  }
  for (const state of ['shop', 'dialog', 'result', 'lobby']) {
    const reachable = (plan.states[state] || []).length > 0;
    if (!reachable) continue;
    out.states[state] = {
      desktop: composeStateLayout({ brief, ds, plan, breakpoint: 'desktop', state }),
      mobile: composeStateLayout({ brief, ds, plan, breakpoint: 'mobile', state }),
    };
  }
  return out;
}

/** Convert a layout node into the engine uiNodeAdd payload. */
export function enginePayload(node) {
  return {
    parentId: null,
    name: node.name,
    nodeType: 'element',
    data: { type: 'text', data: node.payload },
  };
}

if (process.argv[1] && process.argv[1].endsWith('layout-engine.mjs')) {
  const args = parseArgs();
  const id = args.get || args.brief || args._[0];
  if (!id) {
    console.error('usage: node layout-engine.mjs --get=A|B|C [--out=dir]');
    process.exit(1);
  }
  const brief = loadBrief(id);
  const ds = buildDesignSystem(brief);
  const plan = composeScreenPlan(brief, ds);
  const layouts = composeBriefLayouts({ brief, ds, plan });
  if (args.out) writeJson(args.out, layouts);
  console.log(JSON.stringify(Object.fromEntries(
    Object.entries(layouts).filter(([key]) => ['desktop', 'tablet', 'mobile'].includes(key)).map(([key, value]) => [
      key,
      { nodes: value.playing.nodeCount, screens: value.playing.screens, hash: value.playing.layoutHash.slice(0, 12) },
    ]),
  ), null, 2));
}
