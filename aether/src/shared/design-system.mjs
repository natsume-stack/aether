#!/usr/bin/env node
/**
 * StyleResolver: VisualBrief -> DesignSystem.
 *
 * The brief supplies artistic intent and the only allowed raw palette. This
 * module derives role colours, a type scale, spacing, icons, component
 * variants/states and motion tokens, then proves WCAG and forbidden-colour
 * compliance. Everything downstream must reference these tokens by name.
 */
import {
  contrast,
  ensureContrast,
  hashObject,
  hexToRgb,
  mixColor,
  parseArgs,
  writeJson,
} from './common.mjs';
import { BRIEFS, briefHash, loadBrief, validateBrief } from './brief.mjs';

const ARCHETYPES = {
  'pixel-fantasy': {
    match: ['pixel-fantasy', 'bedwars', 'fantasy'],
    fontStack: {
      'bold-pixel': "Consolas, 'Courier New', monospace",
      'clean-sans': "'Segoe UI', system-ui, sans-serif",
    },
    displayWeight: 800,
    bodyWeight: 600,
    tracking: 0.04,
    radii: [0, 2, 4],
    border: [2, 1, 3],
    elevation: ['none', 'inset 0 0 0 2px rgba(255,255,255,.08)', '0 6px 0 rgba(0,0,0,.45)'],
    iconGlyphs: ['♥', '◈', '◆', '⚑', '¤', '⌛', '▲', '❗', '✦', '▦'],
    shape: 'square',
    aesthetic: ['high-contrast team colours', 'chunky pixel outlines', 'arcade numbers'],
  },
  'sci-fi': {
    match: ['sci-fi', 'ctf', 'cyber', 'space'],
    fontStack: {
      'tech-mono': "Bahnschrift, 'Cascadia Mono', Consolas, monospace",
      'condensed-mono': "'Cascadia Mono', Consolas, monospace",
    },
    displayWeight: 700,
    bodyWeight: 500,
    tracking: 0.1,
    radii: [2, 6, 10],
    border: [1, 1, 2],
    elevation: ['none', '0 0 0 1px rgba(37,244,238,.35)', '0 0 18px rgba(37,244,238,.28)'],
    iconGlyphs: ['◇', '◎', '△', '▷', '⌁', '⧗', '⬆', '⚠', '✦', '▤'],
    shape: 'bevel',
    aesthetic: ['neon edge light', 'radar geometry', 'sparse high-signal colour'],
  },
  cozy: {
    match: ['cozy', 'town', 'explore', 'village'],
    fontStack: {
      'soft-serif': "Georgia, 'Palatino Linotype', serif",
      'humanist-sans': "'Segoe UI', 'Trebuchet MS', sans-serif",
    },
    displayWeight: 600,
    bodyWeight: 400,
    tracking: 0.01,
    radii: [8, 14, 22],
    border: [1, 1, 2],
    elevation: ['none', '0 2px 0 rgba(0,0,0,.28)', '0 10px 24px rgba(0,0,0,.32)'],
    iconGlyphs: ['♡', '●', '❀', '✿', '◍', '◔', '➜', '❗', '✎', '☁'],
    shape: 'round',
    aesthetic: ['warm paper surfaces', 'soft rounded cards', 'low-combat breathing room'],
  },
};

const DENSITY = {
  compact: { type: [11, 14, 20, 28, 34], space: [3, 5, 8, 12, 18, 24], row: 22, pad: 10 },
  dense: { type: [11, 13, 18, 26, 32], space: [2, 4, 8, 12, 16, 24], row: 20, pad: 8 },
  medium: { type: [12, 16, 22, 32, 40], space: [4, 8, 12, 16, 24, 32], row: 26, pad: 14 },
  airy: { type: [13, 17, 24, 34, 44], space: [4, 8, 16, 24, 32, 44], row: 30, pad: 18 },
};

const MOTION = {
  snappy: { fast: 90, base: 140, slow: 200, easing: 'cubic-bezier(.2,.9,.25,1)', pulse: 0.08 },
  precise: { fast: 120, base: 180, slow: 260, easing: 'cubic-bezier(.4,0,.2,1)', pulse: 0.04 },
  gentle: { fast: 180, base: 260, slow: 360, easing: 'cubic-bezier(.25,.8,.3,1)', pulse: 0.14 },
};

export function pickArchetype(brief) {
  const genre = String(brief.genre || '').toLowerCase();
  for (const [name, spec] of Object.entries(ARCHETYPES)) {
    if (spec.match.some((token) => genre.includes(token))) return { name, spec };
  }
  return { name: 'pixel-fantasy', spec: ARCHETYPES['pixel-fantasy'] };
}

function typeScale(brief, density) {
  const [caption, body, title, hero, number] = density.type;
  const priority = brief.readabilityPriority;
  const boost = priority === 'combat' ? { hero: 4, number: 6 } : priority === 'objective' ? { title: 2 } : priority === 'quest' ? { body: 1 } : {};
  const size = {
    caption,
    body: body + (boost.body || 0),
    title: title + (boost.title || 0),
    hero: hero + (boost.hero || 0),
    number: number + (boost.number || 0),
  };
  const lineHeight = { caption: 1.35, body: 1.4, title: 1.2, hero: 1.1, number: 1.0 };
  const weight = {
    caption: 500,
    body: 500,
    title: 700,
    hero: 800,
    number: 800,
  };
  return {
    family: {
      display: brief.typography.display,
      body: brief.typography.body,
    },
    scale: Object.fromEntries(
      Object.entries(size).map(([role, px]) => [
        role,
        { px, lineHeight: lineHeight[role], weight: weight[role], letterSpacing: role === 'number' ? 0 : 0 },
      ]),
    ),
  };
}

function componentSpecs(tokens) {
  const state = (name, patch) => ({
    state: name,
    background: patch.background,
    text: patch.text,
    border: patch.border,
    opacity: patch.opacity ?? 1,
    translateY: patch.translateY ?? 0,
    durationMs: tokens['motion.fast'] ? Number(tokens['motion.fast']) : 90,
  });
  const base = {
    background: tokens['color.surface'],
    text: tokens['color.text'],
    border: tokens['color.border'],
  };
  return {
    button: {
      variants: ['primary', 'secondary', 'ghost'],
      states: [
        state('default', base),
        state('hover', { ...base, background: tokens['color.surfaceAlt'], border: tokens['color.accent'] }),
        state('pressed', { ...base, background: tokens['color.surfaceAlt'], translateY: 1 }),
        state('disabled', { ...base, text: tokens['color.muted'], background: tokens['color.overlay'], opacity: 0.45 }),
        state('danger', { ...base, background: tokens['color.dangerSoft'], text: tokens['color.danger'], border: tokens['color.danger'] }),
      ],
      radius: tokens['radius.md'],
      padding: `${tokens['space.sm']} ${tokens['space.md']}`,
      font: tokens['type.body'],
      minTarget: 44,
    },
    panel: {
      variants: ['default', 'raised', 'overlay'],
      states: [state('default', base), state('hover', base), state('disabled', { ...base, opacity: 0.5 }), state('danger', { ...base, border: tokens['color.danger'] })],
      radius: tokens['radius.lg'],
      padding: tokens['space.md'],
      elevation: tokens['elevation.2'],
      background: tokens['color.surface'],
      border: tokens['color.border'],
    },
    row: {
      variants: ['default', 'selected', 'muted'],
      states: [state('default', base), state('hover', { ...base, background: tokens['color.surfaceAlt'] }), state('disabled', { ...base, text: tokens['color.muted'] })],
      height: tokens['space.xl'],
      gap: tokens['space.sm'],
      font: tokens['type.body'],
    },
    badge: {
      variants: ['team', 'danger', 'success', 'neutral'],
      states: [state('default', base), state('disabled', { ...base, opacity: 0.5 })],
      radius: tokens['radius.pill'],
      font: tokens['type.caption'],
      padding: `${tokens['space.xs']} ${tokens['space.sm']}`,
    },
    timer: {
      variants: ['round', 'phase'],
      states: [state('default', { ...base, text: tokens['color.accent'] }), state('urgent', { ...base, text: tokens['color.danger'] }), state('disabled', { ...base, text: tokens['color.muted'] })],
      font: tokens['type.number'],
      radius: tokens['radius.md'],
    },
    bar: {
      variants: ['health', 'resource', 'progress'],
      states: [state('default', base), state('danger', { ...base, background: tokens['color.dangerSoft'], text: tokens['color.danger'] }), state('disabled', { ...base, opacity: 0.5 })],
      height: tokens['space.sm'],
      radius: tokens['radius.pill'],
    },
    dialog: {
      variants: ['confirm', 'danger', 'quest'],
      states: [state('default', base), state('disabled', { ...base, opacity: 0.5 }), state('danger', { ...base, border: tokens['color.danger'], text: tokens['color.danger'] })],
      radius: tokens['radius.lg'],
      elevation: tokens['elevation.3'],
      actions: ['confirm', 'cancel'],
      minTarget: 44,
    },
  };
}

function iconSet(brief, archetype, tokens) {
  const semantics = ['health', 'currency', 'team', 'objective', 'shop', 'timer', 'direction', 'warning', 'quest', 'map'];
  const labels = {
    health: '生命',
    currency: '资源',
    team: '队伍',
    objective: '目标',
    shop: '商店',
    timer: '计时',
    direction: '方向',
    warning: '警告',
    quest: '任务',
    map: '地图',
  };
  return semantics.map((semantic, index) => ({
    id: `icon.${semantic}`,
    semantic,
    glyph: archetype.spec.iconGlyphs[index],
    fallback: labels[semantic],
    style: brief.iconStyle,
    size: `space.${semantic === 'objective' || semantic === 'warning' ? 'md' : 'sm'}`,
    color: ['health', 'warning'].includes(semantic)
      ? 'color.danger'
      : ['currency', 'quest'].includes(semantic)
        ? 'color.accent'
        : 'color.text',
    strokeWidth: archetype.spec.border[0],
    token: tokens[`icon.${semantic}`],
  }));
}

export function buildDesignSystem(brief) {
  const validation = validateBrief(brief);
  if (!validation.ok) throw new Error(`invalid brief: ${JSON.stringify(validation.errors)}`);
  const archetype = pickArchetype(brief);
  const density = DENSITY[brief.uiDensity] || DENSITY.medium;
  const motion = MOTION[brief.motion] || MOTION.snappy;
  const palette = brief.palette;
  const bg = palette.base[0];
  const surface = palette.base[1];
  const surfaceAlt = mixColor(surface, bg, 0.35);
  const neutralText = archetype.name === 'cozy' ? '#fff4e6' : '#f8fafc';
  const text = ensureContrast(neutralText, bg, 10, true);
  const textOnSurface = ensureContrast(text, surface, 7, true);
  let muted = ensureContrast(mixColor(text, bg, 0.4), bg, 7.2, true);
  muted = ensureContrast(muted, surface, 7.2, true);
  const forbiddenSet = new Set((palette.forbidden || []).map((value) => String(value).toLowerCase()));
  const safeColor = (candidates) => {
    for (const candidate of candidates) {
      if (!forbiddenSet.has(String(candidate).toLowerCase())) return candidate;
    }
    return candidates[candidates.length - 1];
  };
  const accent = ensureContrast(palette.accent[0], bg, 5.0, true);
  const accentAlt = ensureContrast(palette.accent[1], bg, 7.0, true);
  const danger = ensureContrast(safeColor([palette.accent[1] || '#ef4444', '#ff5a5f', '#ef4444']), bg, 7.0, true);
  const dangerOnSurface = ensureContrast(danger, surface, 7.0, true);
  const accentOnSurface = ensureContrast(accent, surface, 7.0, true);
  const success = ensureContrast(
    safeColor([archetype.name === 'cozy' ? '#9ee37d' : '#3ddc84', '#22c55e', '#4ade80']),
    bg,
    7.0,
    true,
  );
  const warning = ensureContrast(
    safeColor([archetype.name === 'sci-fi' ? '#ff9f1c' : '#ffd166', '#f59e0b', '#fb923c', '#f97316']),
    bg,
    7.0,
    true,
  );
  const info = ensureContrast(
    safeColor([archetype.name === 'sci-fi' ? '#25f4ee' : '#7dd3fc', '#38bdf8', '#60a5fa']),
    bg,
    7.0,
    true,
  );
  const border = mixColor(surface, text, 0.28);
  const divider = mixColor(surface, text, 0.16);
  const overlay = mixColor(bg, '#000000', 0.25);
  const dangerSoft = mixColor(surface, danger, 0.2);
  const successSoft = mixColor(surface, success, 0.18);
  const teamColors = {};
  for (const [name, value] of Object.entries(palette.teams || {})) {
    teamColors[name] = ensureContrast(value, surface, 7.0, true);
  }
  const type = typeScale(brief, density);
  const tokens = {
    'color.bg': bg,
    'color.surface': surface,
    'color.surfaceAlt': surfaceAlt,
    'color.overlay': overlay,
    'color.text': text,
    'color.textOnSurface': textOnSurface,
    'color.muted': muted,
    'color.accent': accentOnSurface,
    'color.accentOnBg': accent,
    'color.accentAlt': accentAlt,
    'color.danger': dangerOnSurface,
    'color.dangerOnBg': danger,
    'color.dangerSoft': dangerSoft,
    'color.success': success,
    'color.successSoft': successSoft,
    'color.warning': warning,
    'color.info': info,
    'color.border': border,
    'color.divider': divider,
    'color.focus': accent,
    ...Object.fromEntries(Object.entries(teamColors).map(([name, value]) => [`color.team.${name}`, value])),
    'space.xs': String(density.space[0]),
    'space.sm': String(density.space[1]),
    'space.md': String(density.space[2]),
    'space.lg': String(density.space[3]),
    'space.xl': String(density.space[4]),
    'space.xxl': String(density.space[5]),
    'space.row': String(density.row),
    'space.pad': String(density.pad),
    'radius.sm': String(archetype.spec.radii[0]),
    'radius.md': String(archetype.spec.radii[1]),
    'radius.lg': String(archetype.spec.radii[2]),
    'radius.pill': String(archetype.name === 'pixel-fantasy' ? 2 : 999),
    'border.thin': String(archetype.spec.border[0]),
    'border.base': String(archetype.spec.border[1]),
    'border.strong': String(archetype.spec.border[2]),
    'elevation.1': archetype.spec.elevation[0],
    'elevation.2': archetype.spec.elevation[1],
    'elevation.3': archetype.spec.elevation[2],
    'font.caption': String(type.scale.caption.px),
    'font.body': String(type.scale.body.px),
    'font.title': String(type.scale.title.px),
    'font.hero': String(type.scale.hero.px),
    'font.number': String(type.scale.number.px),
    'font.display': type.family.display,
    'font.bodyFamily': type.family.body,
    'motion.fast': String(motion.fast),
    'motion.base': String(motion.base),
    'motion.slow': String(motion.slow),
    'motion.easing': motion.easing,
  };
  const icons = iconSet(brief, archetype, tokens);
  for (const icon of icons) tokens[`icon.${icon.semantic}`] = icon.glyph;
  const components = componentSpecs(tokens);
  const ds = {
    version: 'DesignSystem/0.1',
    briefHash: briefHash(brief),
    archetype: archetype.name,
    styleName: `${brief.genre}:${archetype.name}`,
    artDirection: {
      mood: [...brief.mood],
      era: brief.era,
      camera: brief.camera,
      density: brief.uiDensity,
      readabilityPriority: brief.readabilityPriority,
      shape: archetype.spec.shape,
      rules: [...archetype.spec.aesthetic],
      iconStyle: brief.iconStyle,
      motion: brief.motion,
    },
    tokens,
    type: {
      ...type,
      cssFamily: {
        display: archetype.spec.fontStack[brief.typography.display] || type.family.display,
        body: archetype.spec.fontStack[brief.typography.body] || type.family.body,
      },
      displayWeight: archetype.spec.displayWeight,
      bodyWeight: archetype.spec.bodyWeight,
      tracking: archetype.spec.tracking,
    },
    space: {
      xs: density.space[0],
      sm: density.space[1],
      md: density.space[2],
      lg: density.space[3],
      xl: density.space[4],
      xxl: density.space[5],
      row: density.row,
      pad: density.pad,
    },
    radius: { sm: archetype.spec.radii[0], md: archetype.spec.radii[1], lg: archetype.spec.radii[2], pill: brief.genre.includes('bedwars') ? 2 : 999 },
    border: { thin: archetype.spec.border[0], base: archetype.spec.border[1], strong: archetype.spec.border[2], color: border },
    elevation: archetype.spec.elevation,
    icons,
    components,
    motion: {
      fast: motion.fast,
      base: motion.base,
      slow: motion.slow,
      easing: motion.easing,
      pulseAmplitude: motion.pulse,
      enter: `translateY(${brief.motion === 'snappy' ? 6 : 4}px) fade ${motion.base}ms ${motion.easing}`,
      exit: `translateY(-4px) fade ${motion.fast}ms ${motion.easing}`,
    },
    teams: teamColors,
    forbidden: [...palette.forbidden],
    contrast: {},
    validation: {},
  };
  ds.contrast = {
    'text/bg': round(contrast(text, bg)),
    'text/surface': round(contrast(textOnSurface, surface)),
    'muted/bg': round(contrast(muted, bg)),
    'muted/surface': round(contrast(muted, surface)),
    'accent/bg': round(contrast(accent, bg)),
    'accent/surface': round(contrast(accent, surface)),
    'danger/bg': round(contrast(danger, bg)),
    'success/bg': round(contrast(success, bg)),
    ...Object.fromEntries(Object.entries(teamColors).map(([name, value]) => [`team.${name}/surface`, round(contrast(value, surface))])),
  };
  ds.validation = validateDesignSystem(ds, brief);
  ds.styleHash = styleHash(ds);
  return ds;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function styleHash(ds) {
  const { styleHash: _ignored, generatedAt: _at, ...stable } = ds;
  return hashObject(stable);
}

export function validateDesignSystem(ds, brief) {
  const errors = [];
  const warnings = [];
  const required = [
    'color.bg', 'color.surface', 'color.surfaceAlt', 'color.text', 'color.muted', 'color.accent',
    'color.danger', 'color.success', 'color.warning', 'color.info', 'color.border',
    'space.xs', 'space.sm', 'space.md', 'space.lg', 'space.xl',
    'radius.sm', 'radius.md', 'radius.lg',
    'border.thin', 'border.base', 'font.caption', 'font.body', 'font.title', 'font.hero', 'font.number',
    'motion.fast', 'motion.base', 'motion.slow',
  ];
  for (const key of required) {
    if (ds.tokens[key] === undefined) errors.push({ code: 'MISSING_TOKEN', token: key });
  }
  const checks = [
    ['text/bg', ds.tokens['color.text'], ds.tokens['color.bg'], 7, 'AAA'],
    ['text/surface', ds.tokens['color.textOnSurface'], ds.tokens['color.surface'], 7, 'AAA'],
    ['muted/bg', ds.tokens['color.muted'], ds.tokens['color.bg'], 4.5, 'AA'],
    ['muted/surface', ds.tokens['color.muted'], ds.tokens['color.surface'], 4.5, 'AA'],
    ['accent/bg', ds.tokens['color.accent'], ds.tokens['color.bg'], 4.5, 'AA'],
    ['danger/bg', ds.tokens['color.danger'], ds.tokens['color.bg'], 4.5, 'AA'],
    ['success/bg', ds.tokens['color.success'], ds.tokens['color.bg'], 4.5, 'AA'],
  ];
  for (const [name, fg, bg, min, level] of checks) {
    const ratio = round(contrast(fg, bg));
    if (ratio < min) errors.push({ code: 'CONTRAST_FAIL', pair: name, ratio, min, level });
  }
  for (const [name, value] of Object.entries(ds.teams)) {
    const ratio = round(contrast(value, ds.tokens['color.surface']));
    if (ratio < 4.5) errors.push({ code: 'TEAM_CONTRAST_FAIL', team: name, ratio });
  }
  const usedColors = Object.entries(ds.tokens)
    .filter(([key]) => key.startsWith('color.'))
    .map(([, value]) => String(value).toLowerCase());
  for (const forbidden of ds.forbidden) {
    if (usedColors.includes(String(forbidden).toLowerCase())) {
      errors.push({ code: 'FORBIDDEN_COLOR', color: forbidden });
    }
  }
  if (ds.icons.length < 8) errors.push({ code: 'ICON_SET_SMALL', count: ds.icons.length });
  const iconSemantics = new Set(ds.icons.map((icon) => icon.semantic));
  for (const semantic of ['health', 'currency', 'team', 'objective', 'shop', 'timer', 'direction', 'warning']) {
    if (!iconSemantics.has(semantic)) errors.push({ code: 'ICON_SEMANTIC_MISSING', semantic });
  }
  const states = ['default', 'hover', 'pressed', 'disabled', 'danger'];
  for (const [name, component] of Object.entries(ds.components)) {
    const present = new Set((component.states || []).map((item) => item.state));
    for (const state of states) {
      if (name === 'button' && !present.has(state)) errors.push({ code: 'COMPONENT_STATE_MISSING', component: name, state });
      if (name !== 'button' && ['default', 'disabled'].some((needed) => !present.has(needed)) && state === 'default') {
        errors.push({ code: 'COMPONENT_STATE_MISSING', component: name, state: 'default/disabled' });
        break;
      }
    }
  }
  const types = ['caption', 'body', 'title', 'hero', 'number'];
  let previous = 0;
  for (const role of types) {
    const px = ds.type.scale[role]?.px;
    if (!px) errors.push({ code: 'TYPE_SCALE_MISSING', role });
    else if (role !== 'number' && px < previous) errors.push({ code: 'TYPE_SCALE_ORDER', role });
    if (role !== 'number') previous = px;
  }
  if (brief.uiDensity === 'airy') {
    const ratio = ds.space.xl / ds.space.md;
    if (ratio < 1.8) warnings.push({ code: 'DENSITY_COMPRESSED', ratio });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    tokenCount: Object.keys(ds.tokens).length,
    iconCount: ds.icons.length,
    componentCount: Object.keys(ds.components).length,
    contrastPairs: Object.keys(ds.contrast).length,
  };
}

export function briefArtifacts(id) {
  const brief = loadBrief(id);
  const validation = validateBrief(brief);
  const designSystem = buildDesignSystem(brief);
  return { brief, validation, briefHash: briefHash(brief), designSystem };
}

if (process.argv[1] && process.argv[1].endsWith('design-system.mjs')) {
  const args = parseArgs();
  if (args.test) {
    const rows = [];
    const seen = new Set();
    let ok = true;
    for (const id of Object.keys(BRIEFS)) {
      const { brief, designSystem, briefHash: bHash } = briefArtifacts(id);
      const stable = buildDesignSystem(brief).styleHash === designSystem.styleHash;
      const distinct = !seen.has(designSystem.styleHash);
      seen.add(designSystem.styleHash);
      rows.push({
        id,
        name: brief.name,
        archetype: designSystem.archetype,
        briefHash: bHash,
        styleHash: designSystem.styleHash,
        stable,
        distinct,
        validation: designSystem.validation,
        contrast: designSystem.contrast,
      });
      if (!stable || !distinct || !designSystem.validation.ok) ok = false;
    }
    const out = { ok, briefs: rows };
    if (args.out) writeJson(args.out, out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const id = args.get || args.brief || args._[0];
  if (!id) {
    console.error('usage: node design-system.mjs --get=A|B|C [--out=file] | --test [--out=file]');
    process.exit(1);
  }
  const artifact = briefArtifacts(id);
  const out = { brief: artifact.brief, briefHash: artifact.briefHash, designSystem: artifact.designSystem };
  if (args.out) writeJson(args.out, out);
  console.log(JSON.stringify({ styleHash: artifact.designSystem.styleHash, validation: artifact.designSystem.validation, contrast: artifact.designSystem.contrast }, null, 2));
  process.exit(artifact.designSystem.validation.ok ? 0 : 1);
}
