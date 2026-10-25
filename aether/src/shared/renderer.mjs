#!/usr/bin/env node
/**
 * Headless UI renderer.
 *
 * Converts a UIPlan tree into static HTML that mirrors the engine rect model
 * (anchor + offset + size), then uses the installed Edge in headless mode to
 * take a real screenshot. This is a HEADLESS_EDGE render of the authored UI
 * tree, not a mock-up and not the official engine compositor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, hexToRgb, parseArgs, writeJson, writeText } from './common.mjs';
import { buildDesignSystem } from './design-system.mjs';
import { loadBrief, BRIEFS } from './brief.mjs';
import { composeScreenPlan } from './screen-composer.mjs';
import { composeBriefLayouts } from './layout-engine.mjs';
import { decodePng } from './png.mjs';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

export const RENDERER = {
  mode: 'HEADLESS_EDGE_UI_TREE',
  browser: 'Edge headless',
  note: 'Screenshot of the authored UI tree rendered by a headless browser; the official engine compositor is not used.',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function rgbCss(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function rgbaCss(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function radiusFor(node, ds) {
  if (node.isPanel) return Number(ds.radius.lg);
  if (node.component === 'button') return Number(ds.radius.md);
  return Number(ds.radius.sm);
}

function borderFor(node, ds) {
  if (node.isPanel) return `${Math.max(1, ds.border.base)}px solid ${ds.border.color}`;
  if (node.component === 'button' && node.componentState === 'danger') return `${ds.border.base}px solid ${ds.tokens['color.danger']}`;
  if (node.component === 'button') return `${ds.border.thin}px solid ${ds.border.color}`;
  return 'none';
}

export function buildHtml({ brief, ds, layout }) {
  const { width, height } = { width: layout.viewport[0], height: layout.viewport[1] };
  const bg = ds.tokens['color.bg'];
  const surface = ds.tokens['color.surface'];
  const accent = ds.tokens['color.accent'];
  const displayFamily = ds.type.cssFamily.display;
  const bodyFamily = ds.type.cssFamily.body;
  const displayWeight = ds.type.displayWeight;
  const bodyWeight = ds.type.bodyWeight;
  const blocks = [];
  for (const node of layout.nodes) {
    const payload = node.payload;
    const color = rgbCss(payload.textColor);
    const family = ['title', 'hero', 'number'].includes(node.role) || node.fontToken === 'font.hero' || node.fontToken === 'font.title' || node.fontToken === 'font.number'
      ? displayFamily
      : bodyFamily;
    const weight = ['title', 'hero', 'number'].includes(node.role) ? displayWeight : bodyWeight;
    const align = payload.textXAlignment === 1 ? 'left' : 'center';
    const box = `position:absolute;z-index:2;left:${node.rect.x}px;top:${node.rect.y}px;width:${node.rect.w}px;height:${node.rect.h}px;box-sizing:border-box;`;
    if (node.isPanel) {
      const bgColor = rgbaCss(payload.backgroundColor, node.bgOpacity);
      blocks.push(
        `<div class="panel" style="${box}background:${bgColor};border:${borderFor(node, ds)};border-radius:${radiusFor(node, ds)}px;box-shadow:${ds.elevation[2]};"></div>`,
      );
      continue;
    }
    const drawBackground =
      node.component === 'button' ||
      node.role === 'action' ||
      node.role === 'item' ||
      node.role === 'price' ||
      node.componentState === 'disabled';
    const background = drawBackground
      ? `background:${rgbaCss(payload.backgroundColor, Math.max(0.2, node.bgOpacity))};border:${borderFor(node, ds)};border-radius:${radiusFor(node, ds)}px;`
      : '';
    const alignBox = payload.textYAlignment === 1 ? 'display:flex;align-items:center;justify-content:' + (align === 'left' ? 'flex-start' : 'center') + ';' : '';
    blocks.push(
      `<div class="text" style="${box}${background}${alignBox}font-family:${family};font-size:${node.fontSize}px;font-weight:${weight};letter-spacing:${ds.type.tracking}em;line-height:1.2;color:${color};text-align:${align};white-space:pre;overflow:hidden;">${escapeHtml(node.text)}</div>`,
    );
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:${bg};}
  #stage{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:
    radial-gradient(120% 90% at 50% 20%, ${rgbaCss(hexToRgb(surface), 0.55)} 0%, ${rgbaCss(hexToRgb(bg), 0)} 62%),
    linear-gradient(180deg, ${bg} 0%, ${rgbaCss(hexToRgb(surface), 0.35)} 55%, ${bg} 100%);}
  #vignette{position:absolute;z-index:0;inset:0;pointer-events:none;background:radial-gradient(120% 100% at 50% 45%, rgba(0,0,0,0) 55%, ${rgbaCss(hexToRgb(bg), 0.55)} 100%);}
  #stage:after{content:'';position:absolute;left:0;right:0;top:0;height:2px;background:${accent};opacity:.5;}
</style></head>
<body><div id="stage"><div id="vignette"></div>${blocks.join('')}</div></body></html>
`;
}

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no Edge/Chrome binary found');
}

export function screenshotHtml({ htmlPath, pngPath, width, height, profileDir, timeout = 60_000 }) {
  ensureDir(path.dirname(pngPath));
  ensureDir(profileDir);
  const edge = findEdge();
  const url = `file:///${htmlPath.replaceAll('\\', '/')}`.replace('file:////', 'file:///');
  const result = spawnSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      url,
    ],
    { encoding: 'utf8', timeout },
  );
  if (result.error) throw result.error;
  if (!fs.existsSync(pngPath)) {
    throw new Error(`screenshot missing: ${result.stderr || result.stdout || 'edge failed'}`);
  }
  const image = decodePng(fs.readFileSync(pngPath));
  return {
    png: pngPath,
    html: htmlPath,
    width: image.width,
    height: image.height,
    expected: [width, height],
    exactSize: image.width === width && image.height === height,
    bytes: fs.statSync(pngPath).size,
    renderer: RENDERER.mode,
    stderr: result.stderr ? result.stderr.split('\n').filter(Boolean).slice(-2) : [],
  };
}

export function renderLayout({ brief, ds, layout, runDir, name, profileDir }) {
  const html = buildHtml({ brief, ds, layout });
  const htmlPath = path.join(runDir, 'render', `${name}.html`);
  const pngPath = path.join(runDir, 'render', `${name}.png`);
  writeText(htmlPath, html);
  return screenshotHtml({
    htmlPath,
    pngPath,
    width: layout.viewport[0],
    height: layout.viewport[1],
    profileDir: profileDir || path.join(runDir, 'render', 'edge-profile'),
  });
}

export function renderBrief({ brief, ds, plan, layouts, runDir }) {
  const profileDir = path.join(runDir, 'render', 'edge-profile');
  const shots = {};
  for (const [breakpoint, name] of [
    ['desktop', 'ui-1366'],
    ['desktop', 'ui-1920'],
    ['mobile', 'ui-390'],
  ]) {
    const layout = breakpoint === 'desktop' && name === 'ui-1920'
      ? scaleLayout(layouts.desktop.playing, 1920, 1080)
      : layouts[breakpoint].playing;
    shots[name] = renderLayout({ brief, ds, layout, runDir, name, profileDir });
  }
  for (const state of Object.keys(layouts.states)) {
    const layout = layouts.states[state].desktop;
    const artifactName = 'state-' + state;
    shots[artifactName] = renderLayout({ brief, ds, layout, runDir, name: artifactName, profileDir });
  }
  const mobileDialog = layouts.states.dialog?.mobile;
  if (mobileDialog) shots['state-dialog-390'] = renderLayout({ brief, ds, layout: mobileDialog, runDir, name: 'state-dialog-390', profileDir });
  return shots;
}

/**
 * Re-anchor a desktop layout to a larger viewport without re-composing, so the
 * 1920 screenshot exercises the same anchor model the engine uses.
 */
export function scaleLayout(layout, width, height) {
  const oldWidth = layout.viewport[0];
  const oldHeight = layout.viewport[1];
  if (width === oldWidth && height === oldHeight) return layout;
  const nodes = layout.nodes.map((node) => {
    const rect = {
      x: node.rect.x + (node.anchor[0] === 1 ? width - oldWidth : node.anchor[0] === 0.5 ? (width - oldWidth) / 2 : 0),
      y: node.rect.y + (node.anchor[1] === 1 ? height - oldHeight : node.anchor[1] === 0.5 ? (height - oldHeight) / 2 : 0),
      w: node.rect.w,
      h: node.rect.h,
    };
    const offset = [
      rect.x - node.anchor[0] * width,
      rect.y - node.anchor[1] * height,
    ];
    return {
      ...node,
      rect,
      offset,
      payload: {
        ...node.payload,
        position: { offset, ratio: [0, 0] },
        size: { offset: [rect.w, rect.h], ratio: [0, 0] },
      },
    };
  });
  return {
    ...layout,
    viewport: [width, height],
    safeArea: layout.safeArea,
    nodes,
    layoutHash: `${layout.layoutHash}:${width}x${height}`,
  };
}

if (process.argv[1] && process.argv[1].endsWith('renderer.mjs')) {
  const args = parseArgs();
  const id = args.get || args.brief || args._[0];
  if (!id) {
    console.error('usage: node renderer.mjs --get=A|B|C --out=<runDir>');
    process.exit(1);
  }
  const brief = loadBrief(id);
  const ds = buildDesignSystem(brief);
  const plan = composeScreenPlan(brief, ds);
  const layouts = composeBriefLayouts({ brief, ds, plan });
  const runDir = args.out || path.join('D:/desktop/神奇代码岛/box3-re/_scratch/e0-edit/n16/runs', `${id}-render`);
  const shots = renderBrief({ brief, ds, plan, layouts, runDir });
  writeJson(path.join(runDir, 'screenshots.json'), { renderer: RENDERER, shots });
  console.log(JSON.stringify({ runDir, shots: Object.fromEntries(Object.entries(shots).map(([key, value]) => [key, value.png])) }, null, 2));
}
