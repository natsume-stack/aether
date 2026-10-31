import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ARTIFACT_ROOT =
  process.env.N16_ROOT ||
  'D:/desktop/神奇代码岛/box3-re/_scratch/e0-edit/n16';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value, 'utf8');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function hashObject(value) {
  return sha256Hex(canonicalize(value));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function hexToRgb(hex) {
  const text = String(hex || '').trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
    ];
  }
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (!full) return null;
  return [parseInt(full[1], 16), parseInt(full[2], 16), parseInt(full[3], 16)];
}

export function rgbToHex(rgb) {
  const channel = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function mixColor(a, b, amount) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) throw new Error(`bad color ${a}/${b}`);
  const t = clamp(amount, 0, 1);
  return rgbToHex([
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  ]);
}

export function luminance(rgb) {
  const channel = (v) => {
    const c = clamp(v, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrast(a, b) {
  const ca = typeof a === 'string' ? hexToRgb(a) : a;
  const cb = typeof b === 'string' ? hexToRgb(b) : b;
  if (!ca || !cb) return 1;
  const la = luminance(ca) + 0.05;
  const lb = luminance(cb) + 0.05;
  return Math.max(la, lb) / Math.min(la, lb);
}

export function colorDistance(a, b) {
  const ca = typeof a === 'string' ? hexToRgb(a) : a;
  const cb = typeof b === 'string' ? hexToRgb(b) : b;
  if (!ca || !cb) return Infinity;
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
}

/** Raise/lower lightness until contrast(target, background) meets the ratio. */
export function ensureContrast(color, background, ratio, preferLight = true) {
  let current = color;
  for (let i = 0; i < 40; i += 1) {
    if (contrast(current, background) >= ratio) return current;
    current = preferLight
      ? mixColor(current, '#ffffff', 0.06)
      : mixColor(current, '#000000', 0.06);
  }
  return current;
}

export function rectsOverlap(a, b, minRatio = 0.2) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= x || bottom <= y) return 0;
  const area = (right - x) * (bottom - y);
  const minArea = Math.min(a.w * a.h, b.w * b.h) || 1;
  return area / minArea >= minRatio ? area / minArea : 0;
}

export function containsRect(outer, inner, pad = 1) {
  return (
    inner.x >= outer.x - pad &&
    inner.y >= outer.y - pad &&
    inner.x + inner.w <= outer.x + outer.w + pad &&
    inner.y + inner.h <= outer.y + outer.h + pad
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq < 0) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

export function engineCall(base, tool, args = {}, actor = 'n16:visual') {
  return fetch(`${base}/internal/ai-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args, actor }),
  })
    .then(async (res) => {
      const body = await res.json();
      if (body.code || body.result?.success === false) {
        throw new Error(
          `${tool}: ${body.message || body.result?.error || body.result?.code || 'failed'}`,
        );
      }
      return body.result;
    });
}

export function argsValue(args, name, fallback) {
  return args[name] === undefined ? fallback : args[name];
}

export function formatPct(value) {
  return `${Math.round(value * 1000) / 10}%`;
}
