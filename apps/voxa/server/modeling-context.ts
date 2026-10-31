/**
 * Pure, dependency-free modeling-quality helpers for the VOXA agent.
 *
 * The browser sends `{ voxelContext: { partId, shape:[sx,sy,sz], cells, scanned,
 * totalCells, truncated }, parts, palette }`; everything here is derived from
 * that payload only (no store, DOM, IO or clock) so it can be unit tested.
 *
 * Axis conventions (cells are integer voxel coordinates inside `shape`, 0-based):
 * - front: screen x = X (increases to the right), screen y = Y with row 0 at
 *   max Y, depth = +Z, so the nearest occupied voxel (smallest Z) wins.
 * - side:  screen x = Z, screen y = Y with row 0 at max Y, depth = +X
 *   (smallest X wins), i.e. looking along +X.
 * - top:   screen x = X, screen y = Z with row 0 at Z 0, depth = +Y
 *   (smallest Y wins).
 *
 * Downsampling: a projection keeps a 1:1 mapping while the extent fits
 * `maxSize`; larger extents are folded into `maxSize` buckets
 * (`floor(coord * maxSize / extent)`) and each bucket keeps its **nearest**
 * depth plane. When several colors share that nearest plane (a downsampled
 * bucket spans several screen pixels) the dominant color by count wins, ties
 * broken by the smallest colorId. Model space is centered in small grids.
 *
 * All work is bounded: at most 4096 stored cells, 16384 raw cell entries,
 * 512 per axis, 64 grid size and 12 palette rows in the brief.
 */

const MAX_DIM = 512;
const MAX_CELLS = 4096;
const MAX_RAW_CELLS = 16384;
const DEFAULT_MAX_SIZE = 24;
const MAX_GRID_SIZE = 64;
const PALETTE_LIMIT = 12;

export const MODELING_BRIEF_LIMIT = 2400;

const SYMBOLS = '0123456789abcdefghijklmnopqrstuvwxy'; // 35 symbols, 'z' = other
const OTHER_SYMBOL = 'z';

export type VoxelCell = { x: number; y: number; z: number; color: number };
export type ProjectionGrid = number[][];
export type Projections = { front: ProjectionGrid; side: ProjectionGrid; top: ProjectionGrid };
export type QualityBounds = { min: [number, number, number]; max: [number, number, number] };
export type PaletteUsageEntry = { colorId: number; count: number };
export type PartBounds = { id: string | null; min: [number, number, number]; max: [number, number, number] };

export type ModelingQuality = {
  shape: [number, number, number];
  occupiedCells: number;
  scanned: number;
  totalCells: number;
  truncated: boolean;
  bounds: QualityBounds | null;
  /** Fraction of provided cells whose X-mirrored cell is also occupied. */
  symmetryX: number;
  components: number;
  /** 6-connected components other than the largest one. */
  floatingComponents: number;
  largestComponentShare: number;
  paletteUsage: PaletteUsageEntry[];
  partCount: number;
  /** Present only when at least one part exposes or yields bounds. */
  partBounds?: PartBounds[];
};

type NormalizedContext = {
  shape: [number, number, number];
  cells: VoxelCell[];
  truncated: boolean;
  scanned: number;
  totalCells: number;
  parts: unknown[];
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function readInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value
    ? value
    : null;
}

function safeCount(value: unknown, fallback: number): number {
  const parsed = readInt(value);
  if (parsed === null || parsed < 0) return fallback;
  return parsed;
}

function clampSize(value: unknown): number {
  const parsed = readInt(value);
  if (parsed === null || parsed < 1) return DEFAULT_MAX_SIZE;
  return Math.min(parsed, MAX_GRID_SIZE);
}

function readShape(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const item = readInt(value[index]);
    if (item === null || item < 0 || item > MAX_DIM) return null;
    out.push(item);
  }
  return [out[0], out[1], out[2]];
}

function emptyShape(shape: [number, number, number]): boolean {
  return shape[0] <= 0 || shape[1] <= 0 || shape[2] <= 0;
}

/** Falls back to the positive cell bounding box when `shape` is missing/invalid. */
function shapeFromCells(raw: unknown[]): [number, number, number] | null {
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  const limit = Math.min(raw.length, MAX_RAW_CELLS);
  for (let index = 0; index < limit; index += 1) {
    const cell = raw[index];
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const x = readInt(cell[0]);
    const y = readInt(cell[1]);
    const z = readInt(cell[2]);
    if (x === null || y === null || z === null) continue;
    if (x < 0 || y < 0 || z < 0) continue;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (maxX < 0 || maxY < 0 || maxZ < 0) return null;
  return [
    Math.min(maxX + 1, MAX_DIM),
    Math.min(maxY + 1, MAX_DIM),
    Math.min(maxZ + 1, MAX_DIM),
  ];
}

/**
 * Validates the payload. Invalid cells (non-integers, out of shape, colorId 0,
 * short tuples) are dropped; duplicates keep their first occurrence.
 */
function normalizeContext(input: unknown): NormalizedContext {
  const outer = asRecord(input) || {};
  const nested = asRecord(outer.voxelContext);
  const voxel = nested || outer;
  const rawCells: unknown[] = Array.isArray(voxel.cells) ? voxel.cells : [];

  let shape = readShape(voxel.shape);
  if (!shape || emptyShape(shape)) {
    const derived = shapeFromCells(rawCells);
    shape = derived || shape || [0, 0, 0];
  }
  const [sx, sy, sz] = shape;

  const cells: VoxelCell[] = [];
  const seen = new Set<number>();
  let truncated = voxel.truncated === true;
  const rawLimit = Math.min(rawCells.length, MAX_RAW_CELLS);
  if (rawCells.length > MAX_RAW_CELLS) truncated = true;

  for (let index = 0; index < rawLimit; index += 1) {
    const cell = rawCells[index];
    if (!Array.isArray(cell) || cell.length < 4) continue;
    const x = readInt(cell[0]);
    const y = readInt(cell[1]);
    const z = readInt(cell[2]);
    const color = readInt(cell[3]);
    if (x === null || y === null || z === null || color === null) continue;
    if (color <= 0) continue; // 0 is the empty marker
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
    const key = (x * sy + y) * sz + z;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ x, y, z, color });
    if (cells.length >= MAX_CELLS && index < rawLimit - 1) {
      truncated = true;
      break;
    }
  }

  return {
    shape: [sx, sy, sz],
    cells,
    truncated,
    scanned: safeCount(voxel.scanned, cells.length),
    totalCells: safeCount(voxel.totalCells, sx * sy * sz),
    parts: Array.isArray(outer.parts) ? outer.parts : [],
  };
}

function axisOf(cell: VoxelCell, axis: 0 | 1 | 2): number {
  return axis === 0 ? cell.x : axis === 1 ? cell.y : cell.z;
}

function emptyGrid(size: number): number[][] {
  const grid: number[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: number[] = [];
    for (let column = 0; column < size; column += 1) line.push(0);
    grid.push(line);
  }
  return grid;
}

/**
 * Renders one orthographic layer. `flipV` puts max V on row 0 (front/side
 * views look at the model upright); the top view keeps Z ascending downward.
 */
function renderGrid(
  shape: [number, number, number],
  cells: VoxelCell[],
  uAxis: 0 | 1 | 2,
  vAxis: 0 | 1 | 2,
  depthAxis: 0 | 1 | 2,
  size: number,
  flipV: boolean,
): number[][] {
  const grid = emptyGrid(size);
  const uExtent = shape[uAxis];
  const vExtent = shape[vAxis];
  if (uExtent <= 0 || vExtent <= 0 || !cells.length) return grid;

  const scaleU = uExtent > size ? size / uExtent : 1;
  const scaleV = vExtent > size ? size / vExtent : 1;
  const usedU = Math.min(size, uExtent);
  const usedV = Math.min(size, vExtent);
  const offsetU = Math.floor((size - usedU) / 2);
  const offsetV = Math.floor((size - usedV) / 2);

  const buckets: Array<Map<number, Map<number, number>> | undefined> = new Array(size * size);

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const u = Math.min(usedU - 1, Math.floor(axisOf(cell, uAxis) * scaleU));
    const vRaw = Math.min(usedV - 1, Math.floor(axisOf(cell, vAxis) * scaleV));
    const v = offsetV + (flipV ? usedV - 1 - vRaw : vRaw);
    const target = v * size + offsetU + u;
    let depthMap = buckets[target];
    if (!depthMap) {
      depthMap = new Map<number, Map<number, number>>();
      buckets[target] = depthMap;
    }
    const depth = axisOf(cell, depthAxis);
    let colors = depthMap.get(depth);
    if (!colors) {
      colors = new Map<number, number>();
      depthMap.set(depth, colors);
    }
    colors.set(cell.color, (colors.get(cell.color) || 0) + 1);
  }

  for (let index = 0; index < buckets.length; index += 1) {
    const depthMap = buckets[index];
    if (!depthMap) continue;
    let nearest = Infinity;
    depthMap.forEach((_colors, depth) => {
      if (depth < nearest) nearest = depth;
    });
    const colors = depthMap.get(nearest);
    if (!colors) continue;
    let bestColor = 0;
    let bestCount = -1;
    colors.forEach((count, color) => {
      if (count > bestCount || (count === bestCount && color < bestColor)) {
        bestColor = color;
        bestCount = count;
      }
    });
    grid[Math.floor(index / size)][index % size] = bestColor;
  }

  return grid;
}

/** Builds maxSize x maxSize color-id projections; 0 means empty. Never throws. */
export function buildProjections(context: unknown, maxSize: number = DEFAULT_MAX_SIZE): Projections {
  const size = clampSize(maxSize);
  const { shape, cells } = normalizeContext(context);
  return {
    front: renderGrid(shape, cells, 0, 1, 2, size, true),
    side: renderGrid(shape, cells, 2, 1, 0, size, true),
    top: renderGrid(shape, cells, 0, 2, 1, size, false),
  };
}

const NEIGHBOR_OFFSETS: number[][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function computeComponents(
  shape: [number, number, number],
  cells: VoxelCell[],
): { components: number; largest: number } {
  const [sx, sy, sz] = shape;
  const indexByKey = new Map<number, number>();
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    indexByKey.set((cell.x * sy + cell.y) * sz + cell.z, index);
  }
  const visited = new Uint8Array(cells.length);
  const stack: number[] = [];
  let components = 0;
  let largest = 0;
  for (let start = 0; start < cells.length; start += 1) {
    if (visited[start]) continue;
    components += 1;
    let size = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length) {
      const current = stack.pop() as number;
      size += 1;
      const cell = cells[current];
      for (let neighbor = 0; neighbor < NEIGHBOR_OFFSETS.length; neighbor += 1) {
        const offset = NEIGHBOR_OFFSETS[neighbor];
        const nx = cell.x + offset[0];
        const ny = cell.y + offset[1];
        const nz = cell.z + offset[2];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const found = indexByKey.get((nx * sy + ny) * sz + nz);
        if (found === undefined || visited[found]) continue;
        visited[found] = 1;
        stack.push(found);
      }
    }
    if (size > largest) largest = size;
  }
  return { components, largest };
}

/** Mirrors across the shape's X center: x + x' = sx - 1. Color-agnostic. */
function computeSymmetryX(shape: [number, number, number], cells: VoxelCell[]): number {
  if (!cells.length) return 0;
  const [sx, sy, sz] = shape;
  const occupied = new Set<number>();
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    occupied.add((cell.x * sy + cell.y) * sz + cell.z);
  }
  let matched = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const mirrorX = sx - 1 - cell.x;
    if (occupied.has((mirrorX * sy + cell.y) * sz + cell.z)) matched += 1;
  }
  return matched / cells.length;
}

function boundsOfCells(cells: VoxelCell[]): QualityBounds | null {
  if (!cells.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.z < minZ) minZ = cell.z;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
    if (cell.z > maxZ) maxZ = cell.z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function normalizeBounds(
  value: unknown,
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (Array.isArray(value) && value.length >= 6) {
    const nums: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const parsed = readInt(value[index]);
      if (parsed === null) return null;
      nums.push(parsed);
    }
    return {
      min: [Math.min(nums[0], nums[3]), Math.min(nums[1], nums[4]), Math.min(nums[2], nums[5])],
      max: [Math.max(nums[0], nums[3]), Math.max(nums[1], nums[4]), Math.max(nums[2], nums[5])],
    };
  }
  const record = asRecord(value);
  if (
    record &&
    Array.isArray(record.min) &&
    Array.isArray(record.max) &&
    record.min.length >= 3 &&
    record.max.length >= 3
  ) {
    const min: number[] = [];
    const max: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const low = readInt(record.min[index]);
      const high = readInt(record.max[index]);
      if (low === null || high === null) return null;
      min.push(Math.min(low, high));
      max.push(Math.max(low, high));
    }
    return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
  }
  return null;
}

function boundsOfRawCells(
  raw: unknown[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const limit = Math.min(raw.length, MAX_CELLS);
  for (let index = 0; index < limit; index += 1) {
    const cell = raw[index];
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const x = readInt(cell[0]);
    const y = readInt(cell[1]);
    const z = readInt(cell[2]);
    if (x === null || y === null || z === null) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (maxX < 0 || maxY < 0 || maxZ < 0) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Parts may carry bounds directly or their own voxel context; otherwise skipped. */
function partBounds(context: NormalizedContext): PartBounds[] {
  const result: PartBounds[] = [];
  const limit = Math.min(context.parts.length, 64);
  for (let index = 0; index < limit; index += 1) {
    const record = asRecord(context.parts[index]);
    if (!record) continue;
    const nested = asRecord(record.voxelContext);
    const rawCells = Array.isArray(record.cells)
      ? record.cells
      : nested && Array.isArray(nested.cells)
        ? nested.cells
        : [];
    const bounds = normalizeBounds(record.bounds) || boundsOfRawCells(rawCells);
    if (!bounds) continue;
    result.push({
      id: typeof record.id === 'string' ? record.id : null,
      min: bounds.min,
      max: bounds.max,
    });
  }
  return result;
}

function paletteUsage(cells: VoxelCell[]): PaletteUsageEntry[] {
  const counts = new Map<number, number>();
  for (let index = 0; index < cells.length; index += 1) {
    const color = cells[index].color;
    counts.set(color, (counts.get(color) || 0) + 1);
  }
  const usage: PaletteUsageEntry[] = [];
  counts.forEach((count, colorId) => usage.push({ colorId, count }));
  usage.sort((left, right) => right.count - left.count || left.colorId - right.colorId);
  return usage.slice(0, PALETTE_LIMIT);
}

/** Shape quality metrics over the provided (possibly truncated) cells. */
export function buildQuality(context: unknown): ModelingQuality {
  const normalized = normalizeContext(context);
  const cells = normalized.cells;
  const { components, largest } = computeComponents(normalized.shape, cells);
  const result: ModelingQuality = {
    shape: normalized.shape,
    occupiedCells: cells.length,
    scanned: normalized.scanned,
    totalCells: normalized.totalCells,
    truncated: normalized.truncated,
    bounds: boundsOfCells(cells),
    symmetryX: computeSymmetryX(normalized.shape, cells),
    components,
    floatingComponents: components > 0 ? components - 1 : 0,
    largestComponentShare: cells.length ? largest / cells.length : 0,
    paletteUsage: paletteUsage(cells),
    partCount: normalized.parts.length,
  };
  const parts = partBounds(normalized);
  if (parts.length) result.partBounds = parts;
  return result;
}

function normalizeGrid(value: unknown): number[][] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const size = Math.min(value.length, MAX_GRID_SIZE);
  const grid: number[][] = [];
  for (let row = 0; row < size; row += 1) {
    const source = Array.isArray(value[row]) ? value[row] : [];
    const line: number[] = [];
    for (let column = 0; column < size; column += 1) {
      const item = readInt(source[column]);
      line.push(item !== null && item > 0 ? item : 0);
    }
    grid.push(line);
  }
  return grid;
}

function readUsage(value: unknown): PaletteUsageEntry[] {
  if (!Array.isArray(value)) return [];
  const usage: PaletteUsageEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = asRecord(value[index]);
    if (!record) continue;
    const colorId = readInt(record.colorId);
    const count = readInt(record.count);
    if (colorId === null || colorId <= 0 || count === null || count < 0) continue;
    usage.push({ colorId, count });
  }
  usage.sort((left, right) => right.count - left.count || left.colorId - right.colorId);
  return usage.slice(0, PALETTE_LIMIT);
}

function usageFromGrids(grids: Array<ProjectionGrid | null>): PaletteUsageEntry[] {
  const counts = new Map<number, number>();
  for (let gridIndex = 0; gridIndex < grids.length; gridIndex += 1) {
    const grid = grids[gridIndex];
    if (!grid) continue;
    for (let row = 0; row < grid.length; row += 1) {
      for (let column = 0; column < grid[row].length; column += 1) {
        const color = grid[row][column];
        if (color > 0) counts.set(color, (counts.get(color) || 0) + 1);
      }
    }
  }
  const usage: PaletteUsageEntry[] = [];
  counts.forEach((count, colorId) => usage.push({ colorId, count }));
  usage.sort((left, right) => right.count - left.count || left.colorId - right.colorId);
  return usage.slice(0, PALETTE_LIMIT);
}

function percent(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const bounded = Math.max(0, Math.min(1, parsed));
  return `${Math.round(bounded * 1000) / 10}%`;
}

function renderBlock(
  name: string,
  grid: ProjectionGrid,
  note: string,
  symbolOf: Map<number, string>,
): string {
  let minRow = grid.length;
  let maxRow = -1;
  let minColumn = grid.length;
  let maxColumn = -1;
  for (let row = 0; row < grid.length; row += 1) {
    for (let column = 0; column < grid[row].length; column += 1) {
      if (grid[row][column] <= 0) continue;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (column < minColumn) minColumn = column;
      if (column > maxColumn) maxColumn = column;
    }
  }
  if (maxRow < 0) return `${name} ${note} (empty)`;
  const lines: string[] = [`${name} ${maxColumn - minColumn + 1}x${maxRow - minRow + 1} ${note}`];
  for (let row = minRow; row <= maxRow; row += 1) {
    let line = '';
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const color = grid[row][column];
      line += color > 0 ? symbolOf.get(color) || OTHER_SYMBOL : '.';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Compact prompt fragment: dimensions, quality metrics, palette usage and the
 * three trimmed grids (palette color ids mapped to single-char symbols).
 * Always <= MODELING_BRIEF_LIMIT characters.
 */
export function formatModelingBrief(projections: Projections, quality: ModelingQuality): string {
  const source = (asRecord(projections) || {}) as Record<string, unknown>;
  const record = asRecord(quality) || {};
  const shape = readShape(record.shape) || [0, 0, 0];
  const occupied = safeCount(record.occupiedCells, 0);
  const totalCells = safeCount(record.totalCells, shape[0] * shape[1] * shape[2]);
  const scanned = safeCount(record.scanned, occupied);
  const truncated = record.truncated === true;
  const partCount = safeCount(record.partCount, 0);

  const sections = [
    { name: 'FRONT', note: 'top=maxY left=X0 depth=Z', grid: normalizeGrid(source.front) },
    { name: 'SIDE', note: 'top=maxY left=Z0 depth=X', grid: normalizeGrid(source.side) },
    { name: 'TOP', note: 'top=Z0 left=X0 depth=Y', grid: normalizeGrid(source.top) },
  ];

  let usage = readUsage(record.paletteUsage);
  if (!usage.length) usage = usageFromGrids(sections.map((section) => section.grid));

  const legend: string[] = [];
  const symbolOf = new Map<number, string>();
  for (let index = 0; index < usage.length && legend.length < SYMBOLS.length; index += 1) {
    const colorId = usage[index].colorId;
    const symbol = SYMBOLS.charAt(legend.length);
    symbolOf.set(colorId, symbol);
    legend.push(`${symbol}=${colorId}`);
  }
  let hasOther = false;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const grid = sections[sectionIndex].grid;
    if (!grid) continue;
    for (let row = 0; row < grid.length; row += 1) {
      for (let column = 0; column < grid[row].length; column += 1) {
        const color = grid[row][column];
        if (color <= 0 || symbolOf.has(color)) continue;
        if (legend.length < SYMBOLS.length) {
          const symbol = SYMBOLS.charAt(legend.length);
          symbolOf.set(color, symbol);
          legend.push(`${symbol}=${color}`);
        } else {
          hasOther = true;
        }
      }
    }
  }

  const lines: string[] = [
    `MODEL shape=${shape[0]}x${shape[1]}x${shape[2]} occupied=${occupied}/${totalCells} scanned=${scanned} truncated=${truncated ? 'yes' : 'no'} parts=${partCount}`,
    'AXES front: x=X y=Y depth=Z(nearest) | side: x=Z y=Y depth=X | top: x=X y=Z depth=Y',
    `QUALITY symmetryX=${percent(record.symmetryX)} components=${safeCount(record.components, 0)} floating=${safeCount(record.floatingComponents, 0)} largest=${percent(record.largestComponentShare)}`,
    `PALETTE ${usage.map((entry) => `${entry.colorId}=${entry.count}`).join(' ') || 'none'}`,
    `LEGEND ${legend.join(' ') || 'none'}${hasOther ? ` ${OTHER_SYMBOL}=other` : ''} .=empty`,
  ];

  let text = lines.join('\n');
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section.grid) {
      text += `\n${section.name} unavailable`;
      continue;
    }
    const block = renderBlock(section.name, section.grid, section.note, symbolOf);
    if (text.length + block.length + 1 <= MODELING_BRIEF_LIMIT) text += `\n${block}`;
    else text += `\n${section.name} omitted (brief limit)`;
  }
  if (text.length > MODELING_BRIEF_LIMIT) {
    text = `${text.slice(0, MODELING_BRIEF_LIMIT - 18)}\n(brief truncated)`;
  }
  return text;
}
