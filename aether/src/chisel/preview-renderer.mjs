/**
 * Model preview.
 *
 * Official path: VOXA is a browser app with a WebGL client; there is no HTTP
 * render endpoint. We probe the client and expose an explicit capability
 * record. When no official capture is available the software isometric render
 * is labelled SOFTWARE_PREVIEW, never presented as official.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureDir } from './common.mjs';
import { encodePng } from './png.mjs';

const VOXA_ROOT = process.env.VOXA_ROOT || 'D:/desktop/神奇代码岛/box3-local-engine/apps/voxa';
const requireFromVoxa = createRequire(path.join(VOXA_ROOT, 'package.json'));
const { allocVoxels } = requireFromVoxa('@box/utils/voxel');
const { decompress } = requireFromVoxa('@box/utils/rle-compress');
const { MuReadStream } = requireFromVoxa('@box/mudb/stream');

export const PREVIEW_MODES = {
  software: 'SOFTWARE_PREVIEW',
  official: 'OFFICIAL_VOXA_WEBGL',
};

function decodeProjectVoxel(voxel) {
  const stream = new MuReadStream(new Uint8Array(voxel.encodedView));
  const sx = stream.readInt32();
  const sy = stream.readInt32();
  const sz = stream.readInt32();
  const view = allocVoxels(sx, sy, sz);
  decompress(stream, view);
  return { view, sx, sy, sz };
}

function fillPolygon(rgba, width, height, points, color, alpha = 255) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    const xs = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.floor(xs[i]));
      const x1 = Math.min(width - 1, Math.ceil(xs[i + 1]));
      for (let x = x0; x <= x1; x += 1) {
        const ptr = (y * width + x) * 4;
        rgba[ptr] = color[0];
        rgba[ptr + 1] = color[1];
        rgba[ptr + 2] = color[2];
        rgba[ptr + 3] = alpha;
      }
    }
  }
}

const shade = (rgb, factor) => [
  Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
  Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
  Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
];

export async function renderSoftwarePreview({ project, plan, outFile, size = 384, background = '#0f172a' }) {
  const materials = new Map(plan.materials.map((material) => [material.id, material]));
  const voxels = [];
  const materialUsage = new Map();
  for (const part of plan.parts) {
    const voxel = project.voxels[part.voxelId];
    if (!voxel) continue;
    const { view, sx, sy, sz } = decodeProjectVoxel(voxel);
    for (let y = 0; y < sy; y += 1) {
      for (let z = 0; z < sz; z += 1) {
        for (let x = 0; x < sx; x += 1) {
          const id = view.getVoxel(x, y, z);
          if (!id) continue;
          materialUsage.set(id, (materialUsage.get(id) || 0) + 1);
          voxels.push({
            x: part.position[0] + x,
            y: part.position[1] + y,
            z: part.position[2] + z,
            id,
          });
        }
      }
    }
  }
  if (!voxels.length) throw new Error('preview: no voxels');
  const iso = (x, y, z) => [(x - z) * 0.8660254, (x + z) * 0.5 - y];
  const range = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const voxel of voxels) {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]]) {
      const [px, py] = iso(voxel.x + dx, voxel.y + dy, voxel.z + dz);
      range.minX = Math.min(range.minX, px);
      range.maxX = Math.max(range.maxX, px);
      range.minY = Math.min(range.minY, py);
      range.maxY = Math.max(range.maxY, py);
    }
  }
  const contentW = Math.max(1, range.maxX - range.minX);
  const contentH = Math.max(1, range.maxY - range.minY);
  const scale = Math.min((size * 0.86) / contentW, (size * 0.86) / contentH);
  const offsetX = size / 2 - ((range.minX + range.maxX) / 2) * scale;
  const offsetY = size / 2 - ((range.minY + range.maxY) / 2) * scale;
  const bg = /^#[0-9a-f]{6}$/i.test(background) ? [
    parseInt(background.slice(1, 3), 16),
    parseInt(background.slice(3, 5), 16),
    parseInt(background.slice(5, 7), 16),
  ] : [15, 23, 42];
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  const projectPoint = (x, y, z) => {
    const [px, py] = iso(x, y, z);
    return [offsetX + px * scale, offsetY + py * scale];
  };
  voxels.sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z));
  for (const voxel of voxels) {
    const material = materials.get(voxel.id);
    if (!material) continue;
    const base = material.rgb;
    const emissiveBoost = material.emissive ? 0.25 * material.emissive : 0;
    const x = voxel.x;
    const y = voxel.y;
    const z = voxel.z;
    const top = [
      projectPoint(x, y + 1, z),
      projectPoint(x + 1, y + 1, z),
      projectPoint(x + 1, y + 1, z + 1),
      projectPoint(x, y + 1, z + 1),
    ];
    const left = [
      projectPoint(x, y, z + 1),
      projectPoint(x + 1, y, z + 1),
      projectPoint(x + 1, y + 1, z + 1),
      projectPoint(x, y + 1, z + 1),
    ];
    const right = [
      projectPoint(x + 1, y, z),
      projectPoint(x + 1, y, z + 1),
      projectPoint(x + 1, y + 1, z + 1),
      projectPoint(x + 1, y + 1, z),
    ];
    fillPolygon(rgba, size, size, left, shade(base, 0.72 + emissiveBoost));
    fillPolygon(rgba, size, size, right, shade(base, 0.56 + emissiveBoost));
    fillPolygon(rgba, size, size, top, shade(base, 1.05 + emissiveBoost));
  }
  ensureDir(path.dirname(outFile));
  fs.writeFileSync(outFile, encodePng(size, size, rgba));
  let inkPixels = 0;
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      if (rgba[index] !== bg[0] || rgba[index + 1] !== bg[1] || rgba[index + 2] !== bg[2]) {
        inkPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    file: outFile,
    mode: PREVIEW_MODES.software,
    size,
    bytes: fs.statSync(outFile).size,
    voxelCount: voxels.length,
    materialsUsed: [...materialUsage.entries()].map(([id, count]) => ({ id, count })),
    bbox: inkPixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    inkRatio: inkPixels / (size * size),
  };
}

export async function probeOfficial(voxaBase = 'http://127.0.0.1:3001') {
  try {
    const res = await fetch(voxaBase, { signal: AbortSignal.timeout(4000) });
    const html = await res.text();
    const hasCanvas = /canvas|webgl|regl|three/i.test(html);
    return {
      available: true,
      httpStatus: res.status,
      mechanism: 'VOXA web client (WebGL canvas)',
      hasCanvas,
      httpPreviewEndpoint: null,
      officialScreenshot: 'NOT_ATTEMPTED',
      note: 'VOXA has no HTTP preview endpoint; an official capture requires driving the browser client.',
    };
  } catch (error) {
    return {
      available: false,
      mechanism: null,
      error: String(error?.message || error),
      officialScreenshot: 'UNAVAILABLE',
    };
  }
}

export const renderPreviewPng = renderSoftwarePreview;
