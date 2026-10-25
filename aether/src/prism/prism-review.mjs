/**
 * prism-review.mjs — UI 套件确定性评审钩子（PrismReview/0.1）
 *
 * 与布局求解器的"0 重叠/0 越界"互补：评的是**视觉质量**——对比度、对齐
 * 节奏、留白密度。全确定性，无需引擎；VLM 判官接口（BOX_VISION_JUDGE_CMD）
 * 与 chisel v4 同约定：stdin=JSON，stdout={score, comments}，不可用即跳过。
 *
 * 用法：
 *   import { reviewSuite } from './prism-review.mjs';
 *   const report = await reviewSuite({ gdd, solves, theme });
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** WCAG 相对亮度对比度（rgb 均为 0..255 数组） */
export function contrastRatio(a, b) {
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const toRgb = (hex) => {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};

/**
 * 评审一套布局解。
 * @param {object} opts { solves: {desktop:{placements,profile},...}, theme, minContrast? }
 * @returns {{ pass, scores:{contrast,alignment,rhythm}, issues:[], judge? }}
 */
export async function reviewSuite({ solves, theme, minContrast = 3.5, visionCmd = null }) {
  const issues = [];
  const scores = { contrast: 100, alignment: 100, rhythm: 100 };

  /* 对比度：主题面板色 vs 背景色（关键可读性下限） */
  const panel = toRgb(theme?.tokens?.panel || theme?.tokens?.surface || '#1b2430');
  const text = toRgb(theme?.tokens?.text || theme?.tokens?.fg || '#e8e8e8');
  const accent = toRgb(theme?.tokens?.accent || theme?.tokens?.primary || '#4ea1ff');
  const crText = contrastRatio(text, panel);
  const crAccent = contrastRatio(accent, panel);
  if (crText < minContrast) issues.push(`正文/面板对比度 ${crText.toFixed(2)} < ${minContrast}`);
  if (crAccent < minContrast) issues.push(`强调色/面板对比度 ${crAccent.toFixed(2)} < ${minContrast}`);
  scores.contrast = Math.round(Math.max(0, Math.min(100, (Math.min(crText, crAccent) / 7) * 100)));

  /* 对齐：同一 profile 内 placements 的 x/y 应落在少数几条网格线上 */
  for (const [profileId, solve] of Object.entries(solves || {})) {
    const placements = solve.placements || [];
    if (placements.length < 3) continue;
    const xs = new Map();
    const ys = new Map();
    for (const p of placements) {
      const gx = Math.round((p.x ?? p.left ?? 0) / 8);
      const gy = Math.round((p.y ?? p.top ?? 0) / 8);
      xs.set(gx, (xs.get(gx) || 0) + 1);
      ys.set(gy, (ys.get(gy) || 0) + 1);
    }
    const aligned = Math.max(...xs.values()) / placements.length;
    const alignedY = Math.max(...ys.values()) / placements.length;
    const score = Math.round(((aligned + alignedY) / 2) * 100);
    scores.alignment = Math.min(scores.alignment, score);
    if (score < 60) issues.push(`${profileId}: 对齐度 ${score}%（多数组件未落 8px 网格）`);
  }

  /* 留白节奏：组件间距的标准差（过大=松散，过密=拥挤） */
  for (const [profileId, solve] of Object.entries(solves || {})) {
    const placements = (solve.placements || []).filter((p) => (p.x ?? p.left) !== undefined);
    if (placements.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < placements.length; i += 1) {
      gaps.push(Math.abs((placements[i].x ?? placements[i].left) - (placements[i - 1].x ?? placements[i - 1].left)));
    }
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    const cv = mean ? sd / mean : 1;
    if (cv > 0.9) issues.push(`${profileId}: 间距节奏离散度 ${cv.toFixed(2)} > 0.9（松散/拥挤混杂）`);
    scores.rhythm = Math.min(scores.rhythm, Math.round(Math.max(0, 100 - cv * 80)));
  }

  const pass = issues.length === 0;

  /* VLM 判官（可选，与 chisel v4 同约定；不可用自动跳过） */
  let judge = null;
  const cmd = visionCmd || String(process.env.BOX_VISION_JUDGE_CMD || '').trim();
  if (cmd) {
    try {
      const res = spawnSync(cmd, {
        input: JSON.stringify({ target: 'prism-ui', theme: theme?.name || null, solves: Object.keys(solves || {}), deterministic: { scores, issues } }),
        timeout: 90_000, shell: true, encoding: 'utf8',
      });
      if (res.status === 0 && res.stdout) judge = JSON.parse(res.stdout);
    } catch { judge = { score: null, warning: 'vision judge 不可用' }; }
  }

  return { version: 'PrismReview/0.1', pass, scores, issues, judge };
}
