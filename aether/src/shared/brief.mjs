#!/usr/bin/env node
/**
 * VisualBrief/0.1 — the style contract every visual artifact derives from.
 *
 * A brief is the only place raw hex values are allowed. DesignSystem,
 * ScreenPlan, layout and model compilation read the brief and must not invent
 * colours, type scales or spacing outside the resulting DesignSystem.
 */
import { hashObject, hexToRgb, parseArgs, readJson, writeJson } from './common.mjs';

export const BRIEF_VERSION = 'VisualBrief/0.1';

export const BRIEFS = {
  A: {
    id: 'A',
    version: BRIEF_VERSION,
    name: '像素幻想 四队起床战争',
    genre: 'pixel-fantasy-bedwars',
    mood: ['competitive', 'readable', 'playful'],
    era: 'medieval-fantasy',
    camera: 'third-person',
    uiDensity: 'medium',
    readabilityPriority: 'combat',
    palette: {
      base: ['#090d1f', '#1b2440'],
      accent: ['#ffc93c', '#ff5a5f'],
      teams: {
        red: '#ff5a5f',
        blue: '#3d8bfd',
        green: '#3ddc84',
        yellow: '#ffd166',
      },
      forbidden: ['#ff00ff', '#00ff00'],
    },
    typography: { display: 'bold-pixel', body: 'clean-sans' },
    iconStyle: 'pixel-outline',
    motion: 'snappy',
    modelRoles: ['landmark', 'weapon', 'hero'],
    gameplay: {
      teamCount: 4,
      objective: 'break-beds',
      economy: ['iron', 'gold', 'emerald'],
      roundSeconds: 300,
      shop: true,
      respawn: true,
      minimap: true,
    },
    notes: '四队起床战争；红蓝绿黄必须一眼区分；战斗中生命与目标优先。',
  },
  B: {
    id: 'B',
    version: BRIEF_VERSION,
    name: '科幻峡谷 双队夺旗',
    genre: 'sci-fi-canyon-ctf',
    mood: ['precise', 'tense', 'high-tech'],
    era: 'far-future',
    camera: 'third-person',
    uiDensity: 'dense',
    readabilityPriority: 'objective',
    palette: {
      base: ['#04070f', '#0a1526'],
      accent: ['#25f4ee', '#8b5cf6'],
      teams: {
        cyan: '#25f4ee',
        orange: '#ff7a1a',
      },
      forbidden: ['#ff00ff', '#ffd166'],
    },
    typography: { display: 'tech-mono', body: 'condensed-mono' },
    iconStyle: 'neon-line',
    motion: 'precise',
    modelRoles: ['landmark', 'hero'],
    gameplay: {
      teamCount: 2,
      objective: 'capture-flag',
      roundSeconds: 240,
      radar: true,
      respawn: true,
      shop: false,
    },
    notes: '冷色峡谷霓虹；雷达/目标推进/少量高亮；禁用暖金色。',
  },
  C: {
    id: 'C',
    version: BRIEF_VERSION,
    name: '温馨城镇 探索任务',
    genre: 'cozy-town-explore',
    mood: ['calm', 'warm', 'friendly'],
    era: 'timeless-village',
    camera: 'isometric',
    uiDensity: 'airy',
    readabilityPriority: 'quest',
    palette: {
      base: ['#241a16', '#3a2b23'],
      accent: ['#f2c14e', '#e07a5f'],
      teams: { town: '#f2c14e' },
      forbidden: ['#ff00ff', '#25f4ee'],
    },
    typography: { display: 'soft-serif', body: 'humanist-sans' },
    iconStyle: 'soft-rounded',
    motion: 'gentle',
    modelRoles: ['landmark', 'hero'],
    gameplay: {
      teamCount: 1,
      objective: 'quests',
      quests: ['baker', 'lighthouse', 'gardener'],
      shop: false,
      respawn: false,
      minimap: true,
    },
    notes: '暖色、对话/任务/地图；低战斗密度；柔和排版，避免电竞式红蓝对抗。',
  },
};

export function validateBrief(brief) {
  const errors = [];
  const warn = [];
  const must = (ok, code, message) => {
    if (!ok) errors.push({ code, message });
  };
  must(brief && typeof brief === 'object', 'BRIEF_OBJECT', 'brief must be an object');
  if (!brief || typeof brief !== 'object') return { ok: false, errors, warnings: warn };
  must(brief.version === BRIEF_VERSION, 'BRIEF_VERSION', `version must be ${BRIEF_VERSION}`);
  must(typeof brief.genre === 'string' && brief.genre.length > 2, 'BRIEF_GENRE', 'genre required');
  must(Array.isArray(brief.mood) && brief.mood.length >= 2, 'BRIEF_MOOD', 'mood needs >=2 entries');
  must(typeof brief.era === 'string' && brief.era, 'BRIEF_ERA', 'era required');
  must(['first-person', 'third-person', 'isometric', 'top-down'].includes(brief.camera), 'BRIEF_CAMERA', 'camera invalid');
  must(['compact', 'medium', 'airy', 'dense'].includes(brief.uiDensity), 'BRIEF_DENSITY', 'uiDensity invalid');
  must(typeof brief.readabilityPriority === 'string', 'BRIEF_READABILITY', 'readabilityPriority required');
  const palette = brief.palette || {};
  must(Array.isArray(palette.base) && palette.base.length >= 2, 'BRIEF_BASE', 'palette.base needs >=2');
  must(Array.isArray(palette.accent) && palette.accent.length >= 2, 'BRIEF_ACCENT', 'palette.accent needs >=2');
  for (const value of [...(palette.base || []), ...(palette.accent || []), ...Object.values(palette.teams || {})]) {
    must(Boolean(hexToRgb(value)), 'BRIEF_HEX', `invalid hex ${value}`);
  }
  must(Array.isArray(palette.forbidden) && palette.forbidden.length >= 1, 'BRIEF_FORBIDDEN', 'palette.forbidden required');
  for (const value of palette.forbidden || []) must(Boolean(hexToRgb(value)), 'BRIEF_HEX', `invalid forbidden ${value}`);
  must(brief.typography && brief.typography.display && brief.typography.body, 'BRIEF_TYPE', 'typography display/body required');
  must(typeof brief.iconStyle === 'string' && brief.iconStyle, 'BRIEF_ICONS', 'iconStyle required');
  must(['snappy', 'precise', 'gentle'].includes(brief.motion), 'BRIEF_MOTION', 'motion invalid');
  must(Array.isArray(brief.modelRoles) && brief.modelRoles.length >= 1, 'BRIEF_MODEL_ROLES', 'modelRoles required');
  must(brief.gameplay && typeof brief.gameplay === 'object', 'BRIEF_GAMEPLAY', 'gameplay semantics required');
  if (brief.gameplay) {
    must(Number.isInteger(brief.gameplay.teamCount) && brief.gameplay.teamCount >= 1, 'BRIEF_TEAMS', 'gameplay.teamCount invalid');
    if (brief.gameplay.teamCount > 1) {
      const teams = Object.keys(palette.teams || {});
      must(teams.length >= brief.gameplay.teamCount, 'BRIEF_TEAM_COLORS', 'palette.teams must cover gameplay.teamCount');
    }
  }
  if ((palette.forbidden || []).some((value) => (palette.accent || []).includes(value))) {
    warn.push({ code: 'FORBIDDEN_IS_ACCENT', message: 'a forbidden colour is also an accent' });
  }
  return { ok: errors.length === 0, errors, warnings: warn };
}

export function briefHash(brief) {
  const { generatedAt: _ignored, ...stable } = brief;
  return hashObject(stable);
}

export function loadBrief(fileOrId) {
  if (BRIEFS[fileOrId]) return JSON.parse(JSON.stringify(BRIEFS[fileOrId]));
  return readJson(fileOrId);
}

if (process.argv[1] && process.argv[1].endsWith('brief.mjs')) {
  const args = parseArgs();
  if (args.list) {
    console.log(JSON.stringify(Object.fromEntries(Object.entries(BRIEFS).map(([k, v]) => [k, { name: v.name, hash: briefHash(v) }])), null, 2));
    process.exit(0);
  }
  if (args.get) {
    const brief = loadBrief(args.get);
    const validation = validateBrief(brief);
    const output = { brief, validation, hash: briefHash(brief) };
    if (args.out) writeJson(args.out, output);
    console.log(JSON.stringify(output, null, 2));
    process.exit(validation.ok ? 0 : 1);
  }
  console.error('usage: node brief.mjs --list | --get=A|B|C|<file> [--out=file]');
  process.exit(1);
}
