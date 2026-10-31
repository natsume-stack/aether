import { createHash } from 'node:crypto';

export type AgentContext = {
  voxelContext: {
    partId: string | null;
    shape: number[];
    cells: number[][];
    scanned: number;
    totalCells: number;
    truncated: boolean;
  };
  parts: Array<Record<string, unknown>>;
  palette: Array<Record<string, unknown>>;
};

function round(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return Math.round(value * 10000) / 10000;
}

function sortedCells(value: unknown) {
  if (!Array.isArray(value)) return [];
  const cells = value
    .filter((cell) => Array.isArray(cell) && cell.length >= 4)
    .map((cell) => [Number(cell[0]), Number(cell[1]), Number(cell[2]), Number(cell[3])])
    .filter((cell) => cell.every((item) => Number.isFinite(item)))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || left[3] - right[3]);
  return cells.slice(0, 4096);
}

function canonicalPart(value: Record<string, unknown>) {
  const part: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'type', 'parentId', 'position', 'scale', 'pivot', 'rotationDegrees', 'alpha']) {
    if (value[key] === undefined) continue;
    const item = value[key];
    part[key] = Array.isArray(item) ? item.map(round) : round(item);
  }
  return part;
}

function canonicalPalette(value: Record<string, unknown>) {
  const color: Record<string, unknown> = {};
  for (const key of ['id', 'colorId', 'rgb', 'hsv', 'emissive', 'name']) {
    if (value[key] === undefined) continue;
    const item = value[key];
    color[key] = Array.isArray(item) ? item.map(round) : round(item);
  }
  return color;
}

export function canonicalContext(value: unknown): AgentContext {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  const voxel = (source.voxelContext && typeof source.voxelContext === 'object' ? source.voxelContext : {}) as Record<string, any>;
  const parts = Array.isArray(source.parts)
    ? source.parts.map(canonicalPart).sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')))
    : [];
  const palette = Array.isArray(source.palette)
    ? source.palette.map(canonicalPalette).sort((left, right) => Number(left.colorId ?? left.id ?? 0) - Number(right.colorId ?? right.id ?? 0))
    : [];
  return {
    voxelContext: {
      partId: typeof voxel.partId === 'string' ? voxel.partId : null,
      shape: Array.isArray(voxel.shape) ? voxel.shape.slice(0, 3).map((item: unknown) => Number(item) || 0) : [],
      cells: sortedCells(voxel.cells),
      scanned: Number(voxel.scanned) || 0,
      totalCells: Number(voxel.totalCells) || 0,
      truncated: voxel.truncated === true,
    },
    parts,
    palette,
  };
}

export function contextHash(context: AgentContext) {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex').slice(0, 16);
}

function cellKey(cell: number[]) {
  return `${cell[0]},${cell[1]},${cell[2]},${cell[3]}`;
}

/**
 * Full context for the first turn; later turns only describe voxel changes so the
 * miss tokens stay small while the conversation history keeps the previous state.
 */
export function buildContextPayload(current: AgentContext, previous?: AgentContext) {
  if (!previous) return { mode: 'full' as const, payload: { context: current }, contextChars: 0 };
  const shapeChanged = JSON.stringify(current.voxelContext.shape) !== JSON.stringify(previous.voxelContext.shape);
  const partChanged = current.voxelContext.partId !== previous.voxelContext.partId;
  const truncationChanged = current.voxelContext.truncated !== previous.voxelContext.truncated;
  if (shapeChanged || partChanged || truncationChanged) {
    return { mode: 'full' as const, payload: { context: current }, contextChars: 0 };
  }

  const before = new Set(previous.voxelContext.cells.map(cellKey));
  const after = new Set(current.voxelContext.cells.map(cellKey));
  const added = current.voxelContext.cells.filter((cell) => !before.has(cellKey(cell)));
  const removed = previous.voxelContext.cells.filter((cell) => !after.has(cellKey(cell)));
  const changed = added.length + removed.length;
  if (changed > 700 || changed > Math.max(64, current.voxelContext.cells.length)) {
    return { mode: 'full' as const, payload: { context: current }, contextChars: 0 };
  }

  const partsChanged = JSON.stringify(current.parts) !== JSON.stringify(previous.parts);
  const paletteChanged = JSON.stringify(current.palette) !== JSON.stringify(previous.palette);
  const delta: Record<string, unknown> = {
    partId: current.voxelContext.partId,
    shape: current.voxelContext.shape,
    cellCount: current.voxelContext.cells.length,
    scanned: current.voxelContext.scanned,
    totalCells: current.voxelContext.totalCells,
    truncated: false,
    added,
    removed,
  };
  if (partsChanged) delta.parts = current.parts;
  if (paletteChanged) delta.palette = current.palette;
  if (!changed && !partsChanged && !paletteChanged) delta.unchanged = true;
  const payload = { contextDelta: delta };
  return { mode: 'delta' as const, payload, contextChars: 0 };
}
