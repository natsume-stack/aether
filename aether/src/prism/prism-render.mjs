/**
 * ui-theme-render.mjs — 主题化 UI 截图渲染器 (UIThemeRender/0.1)
 *
 * 把布局求解结果渲染成像素级 PNG：组件原语 → 主题化 DOM（块状描边/细线/发光/圆角），
 * 图标 = 12×12 位图 → png.mjs 编码 → data URI（image-rendering:pixelated），
 * 页面 = 游戏占位背景（深色+网格）以验证可读性，最后经 renderer.mjs 的 Edge 截图出图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../shared/png.mjs';
import { screenshotHtml } from '../shared/renderer.mjs';
import { ICON_GLYPHS } from './prism-kit.mjs';

/* ---------- 颜色角色解析 ---------- */
function resolveColor(role, theme) {
  if (!role) return 'transparent';
  if (role.startsWith('teams.')) return theme.teams[Number(role.split('.')[1]) || 0];
  if (role === 'transparent') return 'transparent';
  return theme.palette[role] || role;
}
function withAlpha(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ---------- 位图图标 → data URI ---------- */
const iconCache = new Map();
function shade(hex, mul) {
  const r = Math.min(255, Math.round(parseInt(hex.slice(1, 3), 16) * mul));
  const g = Math.min(255, Math.round(parseInt(hex.slice(3, 5), 16) * mul));
  const b = Math.min(255, Math.round(parseInt(hex.slice(5, 7), 16) * mul));
  return `rgb(${r},${g},${b})`;
}
export function iconDataUri({ icon, theme, state = 'full', tint }) {
  const key = `${icon}|${theme.id}|${state}|${tint || ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const glyph = ICON_GLYPHS[icon] || ICON_GLYPHS.block;
  const base = tint ? resolveColor(tint, theme) : (icon === 'heart' ? theme.palette.danger : theme.palette.text);
  const dim = theme.palette.slot;
  const size = 24; // 12×12 ×2
  const rgba = Buffer.alloc(size * size * 4);
  const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mainRgb = hexToRgb(base.length === 7 ? base : '#cccccc');
  const dimRgb = hexToRgb(dim.length === 7 ? dim : '#222222');
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ch = glyph[Math.floor(y / 2)]?.[Math.floor(x / 2)] || ' ';
      const ptr = (y * size + x) * 4;
      let rgb = null;
      const isLeft = x < size / 2;
      if (state === 'empty' || (state === 'half' && !isLeft)) {
        rgb = ch === ' ' ? null : dimRgb;
      } else {
        rgb = ch === '#' ? mainRgb : ch === '.' ? mainRgb.map((v) => Math.min(255, v + 45)) : ch === '+' ? mainRgb.map((v) => Math.round(v * 0.55)) : null;
      }
      if (rgb) { rgba[ptr] = rgb[0]; rgba[ptr + 1] = rgb[1]; rgba[ptr + 2] = rgb[2]; rgba[ptr + 3] = 255; }
    }
  }
  const png = encodePng(size, size, rgba);
  const uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  iconCache.set(key, uri);
  return uri;
}

/* ---------- 主题 CSS ---------- */
function themeCss(theme) {
  const p = theme.palette;
  const border = (() => {
    switch (theme.border.style) {
      case 'chunky':
        return `.panel{background:${p.panelBg};box-shadow:inset ${theme.border.size}px ${theme.border.size}px 0 ${p.borderLight},inset -${theme.border.size}px -${theme.border.size}px 0 ${p.borderDark},0 0 0 ${theme.border.size}px ${p.border}}`;
      case 'glow':
        return `.panel{background:${p.panelBg};border:1px solid ${p.borderLight};box-shadow:0 0 10px ${withAlpha(p.borderLight.startsWith('#') ? p.borderLight : '#5ff0ff', 0.35)},inset 0 0 12px ${withAlpha(p.borderLight.startsWith('#') ? p.borderLight : '#5ff0ff', 0.12)}}`;
      case 'soft':
        return `.panel{background:${p.panelBg};border:${theme.border.size}px solid ${p.border};border-radius:${theme.radius}px;box-shadow:0 4px 14px rgba(90,70,50,.25)}`;
      default:
        return `.panel{background:${p.panelBg};border:${theme.border.size}px solid ${p.border};border-radius:${theme.radius}px}`;
    }
  })();
  return `
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:${'{}W'}px;height:${'{}H'}px;font-family:${theme.fontStack};overflow:hidden;letter-spacing:${theme.letterSpacing}px}
  .stage{position:absolute;inset:0;background:${p.bgPlaceholder}}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(128,128,128,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(128,128,128,.07) 1px,transparent 1px);background-size:32px 32px}
  .comp{position:absolute}
  .prim{position:absolute}
  .slot{background:${p.slot};box-shadow:inset ${theme.border.size}px ${theme.border.size}px 0 ${p.borderDark},inset -${theme.border.size}px -${theme.border.size}px 0 ${p.borderLight}}
  .slot.sel{outline:${theme.border.size + 1}px solid ${p.slotSelected};outline-offset:1px}
  .icon{image-rendering:pixelated}
  .text{white-space:pre;text-shadow:${theme.textShadow}}
  .bar-track{background:rgba(0,0,0,.45);box-shadow:inset 0 0 0 1px ${p.borderDark}}
  .bar-fill{height:100%}
  .btn{display:flex;align-items:center;justify-content:center;cursor:pointer}
  .btn.primary{background:${p.accent};color:#14141c;font-weight:bold;box-shadow:inset -2px -2px 0 rgba(0,0,0,.35),inset 2px 2px 0 rgba(255,255,255,.35)}
  .btn.plain{background:${p.panelBgAlt};color:${p.text};box-shadow:inset -2px -2px 0 ${p.borderDark},inset 2px 2px 0 ${p.borderLight},0 0 0 1px ${p.border}}
  ${border}
  `;
}

/* ---------- 原语 → DOM ---------- */
function primDom(prim, theme) {
  const style = (extra) => `position:absolute;left:${prim.x}px;top:${prim.y}px;width:${prim.w}px;height:${prim.h}px;${extra || ''}`;
  switch (prim.t) {
    case 'rect':
      return `<div class="prim ${prim.role === 'panel' ? 'panel' : ''}" style="${style(`background:${withAlpha(resolveColor(prim.fill, theme), prim.alpha ?? 1)};${prim.minimap ? 'opacity:.9' : ''}`)}"></div>`;
    case 'circle':
      return `<div class="prim ${prim.role === 'panel' ? 'panel' : ''}" style="${style(`background:${withAlpha(resolveColor(prim.fill, theme), prim.alpha ?? 1)};border-radius:50%`)}"></div>`;
    case 'slot':
      return `<div class="prim slot ${prim.selected ? 'sel' : ''}" style="${style('')}">${prim.count ? `<span class="text" style="position:absolute;right:2px;bottom:0;font-size:10px;color:${theme.palette.textDim}">${prim.count}</span>` : ''}</div>`;
    case 'icon': {
      const src = iconDataUri({ icon: prim.icon, theme, state: prim.state || 'full', tint: prim.tint });
      return `<img class="prim icon" src="${src}" style="${style('object-fit:contain')}">`;
    }
    case 'bar':
      return `<div class="prim bar-track" style="${style('')}"><div class="bar-fill" style="width:${Math.round(prim.pct * 100)}%;background:${resolveColor(prim.fill, theme)}"></div></div>`;
    case 'text': {
      const align = prim.align === 'right' ? 'right' : prim.align === 'center' ? 'center' : 'left';
      const valign = prim.valign === 'middle' ? 'center' : prim.valign === 'bottom' ? 'flex-end' : 'flex-start';
      return `<div class="prim text" style="${style(`display:flex;justify-content:${align};align-items:${valign};color:${resolveColor(prim.color, theme)};font-size:${Math.round(prim.size)}px;${prim.bold ? 'font-weight:bold' : ''}`)}">${prim.text}</div>`;
    }
    case 'button':
      return `<div class="prim btn ${prim.primary ? 'primary' : 'plain'}" style="${style(`font-size:${Math.round(prim.h * 0.42)}px`)}">${prim.label}</div>`;
    case 'crosshair': {
      const col = resolveColor(prim.color, theme);
      const s = prim.w / 5;
      return `<div class="prim" style="${style('')}">
        <div style="position:absolute;left:50%;top:0;width:${s}px;height:100%;transform:translateX(-50%);background:${col}"></div>
        <div style="position:absolute;top:50%;left:0;height:${s}px;width:100%;transform:translateY(-50%);background:${col}"></div>
        <div style="position:absolute;left:50%;top:50%;width:${s}px;height:${s}px;transform:translate(-50%,-50%);background:#fff"></div>
      </div>`;
    }
    default:
      return '';
  }
}

/* ---------- 布局 → 页面 HTML ---------- */
export function composeHtml({ layout, title }) {
  const theme = layout.theme;
  const p = theme.palette;
  const parts = [];
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><title>${title || theme.id}</title><style>${themeCss(theme).replaceAll('{}W', layout.profile.w).replaceAll('{}H', layout.profile.h)}</style></head><body>`);
  parts.push('<div class="stage"></div><div class="grid"></div>');
  for (const [kind, place] of Object.entries(layout.placements)) {
    if (place.hidden) continue;
    const inner = (place.built.prims || []).map((prim) => primDom(prim, theme)).join('');
    parts.push(`<div class="comp" data-kind="${kind}" style="left:${Math.round(place.x)}px;top:${Math.round(place.y)}px;width:${Math.round(place.w)}px;height:${Math.round(place.h)}px">${inner}</div>`);
  }
  parts.push(`<div style="position:absolute;left:8px;bottom:4px;font-size:12px;color:${p.textDim};font-family:${theme.fontStack}">${layout.profile.w}×${layout.profile.h} · ${theme.label} · ${layout.metrics.placed} 组件</div>`);
  parts.push('</body></html>');
  return parts.join('');
}

/* ---------- 截图 ---------- */
export async function renderLayoutSheet({ layout, outDir, name, title }) {
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, `${name}.html`);
  const pngPath = path.join(outDir, `${name}.png`);
  fs.writeFileSync(htmlPath, composeHtml({ layout, title }));
  await screenshotHtml({
    htmlPath, pngPath,
    width: layout.profile.w, height: layout.profile.h,
    profileDir: path.join(outDir, 'edge-profile'),
  });
  return { htmlPath, pngPath, metrics: layout.metrics };
}

/* ---------- 一致性抽样：统计所有面板/槽位是否都来自主题 token ---------- */
export function consistencyAudit(layout) {
  const theme = layout.theme;
  const tokens = new Set([...Object.values(theme.palette), ...theme.teams]);
  let used = 0, themed = 0;
  for (const place of Object.values(layout.placements)) {
    for (const prim of place.built.prims || []) {
      for (const role of [prim.fill, prim.color]) {
        if (!role) continue;
        used += 1;
        const resolved = resolveColor(role, theme);
        if (tokens.has(resolved) || role.startsWith('teams.') || role === 'transparent') themed += 1;
      }
    }
  }
  return { used, themed, ratio: used ? themed / used : 1 };
}
