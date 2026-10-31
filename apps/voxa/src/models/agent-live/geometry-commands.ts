/**
 * Pure voxel geometry for the live agent executor.
 *
 * No DOM and no editor imports: every helper is deterministic and returns
 * integer cells in workspace coordinates. Bounds and budget policy stay in the
 * executor (`agent-live/index.ts`); this module only does the math so it can be
 * unit-tested from `scripts/check-agent-geometry.ts`.
 */

export type Vec3 = [number, number, number];
export type Cell = [number, number, number];
/** [x, y, z, colorId] — colorId is carried through mirror/copy untouched. */
export type ColoredCell = [number, number, number, number];
export type Axis = 'x' | 'y' | 'z';

export type Box = {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
  volume: number;
};

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

function requireInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} 必须是 ${min}..${max} 的整数（收到 ${value}）`);
  }
  return value;
}

function requireCoordinate(value: Vec3, label: string, min = -4096, max = 4096): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RangeError(`${label} 需要 [x,y,z]`);
  }
  const rounded: Vec3 = [
    Math.round(Number(value[0])),
    Math.round(Number(value[1])),
    Math.round(Number(value[2])),
  ];
  if (rounded.some((n) => !Number.isSafeInteger(n) || n < min || n > max)) {
    throw new RangeError(`${label} 超出范围 ${min}..${max}`);
  }
  return rounded;
}

function requireAxis(axis: Axis, label = 'axis'): Axis {
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
    throw new RangeError(`${label} 必须是 x、y 或 z（收到 ${String(axis)}）`);
  }
  return axis;
}

/**
 * Normalize a from/to pair into min/max/size/center/volume. Both corners must
 * be integer voxel coordinates (inclusive).
 */
export function normalizeBox(from: Vec3, to: Vec3): Box {
  const a = requireCoordinate(from, 'from');
  const b = requireCoordinate(to, 'to');
  const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  const size: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  return {
    min,
    max,
    size,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    volume: size[0] * size[1] * size[2],
  };
}

/**
 * Walk an inclusive integer bounding box and keep the cells accepted by
 * `inside`. When `hollow` is set only cells with at least one of their six face
 * neighbours outside the solid are kept, i.e. a 1-voxel shell (same convention
 * as `fill_box` with `hollow`).
 */
function voxelize(
  min: Vec3,
  max: Vec3,
  inside: (x: number, y: number, z: number) => boolean,
  hollow: boolean,
): Cell[] {
  const cells: Cell[] = [];
  for (let x = min[0]; x <= max[0]; x += 1) {
    for (let y = min[1]; y <= max[1]; y += 1) {
      for (let z = min[2]; z <= max[2]; z += 1) {
        if (!inside(x, y, z)) continue;
        if (
          hollow &&
          inside(x - 1, y, z) &&
          inside(x + 1, y, z) &&
          inside(x, y - 1, z) &&
          inside(x, y + 1, z) &&
          inside(x, y, z - 1) &&
          inside(x, y, z + 1)
        ) {
          continue;
        }
        cells.push([x, y, z]);
      }
    }
  }
  return cells;
}

/** Integer solid sphere: dx² + dy² + dz² <= r². */
export function sphereCells(center: Vec3, radius: number, hollow = false): Cell[] {
  const c = requireCoordinate(center, 'sphere center');
  const r = requireInteger(radius, 1, 64, 'sphere radius');
  const r2 = r * r;
  const inside = (x: number, y: number, z: number) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const dz = z - c[2];
    return dx * dx + dy * dy + dz * dz <= r2;
  };
  return voxelize(
    [c[0] - r, c[1] - r, c[2] - r],
    [c[0] + r, c[1] + r, c[2] + r],
    inside,
    hollow,
  );
}

/** Integer ellipsoid: (dx/rx)² + (dy/ry)² + (dz/rz)² <= 1. */
export function ellipsoidCells(center: Vec3, radii: Vec3, hollow = false): Cell[] {
  const c = requireCoordinate(center, 'ellipsoid center');
  if (!Array.isArray(radii) || radii.length !== 3) {
    throw new RangeError('ellipsoid radii 需要 [rx,ry,rz]');
  }
  const rx = requireInteger(Math.round(Number(radii[0])), 1, 64, 'ellipsoid rx');
  const ry = requireInteger(Math.round(Number(radii[1])), 1, 64, 'ellipsoid ry');
  const rz = requireInteger(Math.round(Number(radii[2])), 1, 64, 'ellipsoid rz');
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const rz2 = rz * rz;
  const inside = (x: number, y: number, z: number) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const dz = z - c[2];
    return dx * dx * ry2 * rz2 + dy * dy * rx2 * rz2 + dz * dz * rx2 * ry2 <= rx2 * ry2 * rz2;
  };
  return voxelize(
    [c[0] - rx, c[1] - ry, c[2] - rz],
    [c[0] + rx, c[1] + ry, c[2] + rz],
    inside,
    hollow,
  );
}

/**
 * Integer cylinder. `base` is the first slice of the axis (inclusive); the
 * cylinder runs from `base[axis]` to `base[axis] + height - 1`. The cross
 * section is a disc of `radius` in the two remaining axes.
 */
export function cylinderCells(
  base: Vec3,
  radius: number,
  height: number,
  axis: Axis = 'y',
  hollow = false,
): Cell[] {
  const b = requireCoordinate(base, 'cylinder base');
  const r = requireInteger(radius, 1, 64, 'cylinder radius');
  const h = requireInteger(height, 1, 128, 'cylinder height');
  const a = requireAxis(axis);
  const axisIndex = AXIS_INDEX[a];
  const crossAxes = [0, 1, 2].filter((index) => index !== axisIndex) as [number, number];
  const start = b[axisIndex];
  const end = start + h - 1;
  const r2 = r * r;
  const inside = (x: number, y: number, z: number) => {
    const p = [x, y, z];
    const along = p[axisIndex];
    if (along < start || along > end) return false;
    const da = p[crossAxes[0]] - b[crossAxes[0]];
    const db = p[crossAxes[1]] - b[crossAxes[1]];
    return da * da + db * db <= r2;
  };
  const min: Vec3 = [b[0] - r, b[1] - r, b[2] - r];
  const max: Vec3 = [b[0] + r, b[1] + r, b[2] + r];
  min[axisIndex] = start;
  max[axisIndex] = end;
  return voxelize(min, max, inside, hollow);
}

/**
 * Mirror every cell across `plane` along `axis`: x' = round(2 * plane - x).
 * A fractional plane is allowed (0.5 offsets mirror between voxel centres).
 */
export function mirrorCells(
  cells: ReadonlyArray<ColoredCell>,
  axis: Axis,
  plane: number,
): ColoredCell[] {
  const a = requireAxis(axis);
  if (!Number.isFinite(plane)) throw new RangeError(`mirror plane 必须是有限数字（收到 ${plane}）`);
  const index = AXIS_INDEX[a];
  return cells.map((cell) => {
    const out: ColoredCell = [cell[0], cell[1], cell[2], cell[3]];
    out[index] = Math.round(2 * plane - out[index]);
    return out;
  });
}

export type CopyRegionOptions = {
  /** Mirror the source around `center` along this axis before offsetting. */
  mirrorAxis?: Axis;
  /** Region centre used for the optional mirror (required with mirrorAxis). */
  center?: Vec3;
};

/**
 * Copy cells by an integer offset. With `mirrorAxis` the copy is first mirrored
 * around the region centre and then offset, so a mirrored copy can be placed
 * next to the original. Colors are preserved.
 */
export function copyRegionCells(
  cells: ReadonlyArray<ColoredCell>,
  offset: Vec3,
  options: CopyRegionOptions = {},
): ColoredCell[] {
  if (!Array.isArray(offset) || offset.length !== 3) {
    throw new RangeError('copy offset 需要 [dx,dy,dz]');
  }
  const d: Vec3 = [
    Math.round(Number(offset[0])),
    Math.round(Number(offset[1])),
    Math.round(Number(offset[2])),
  ];
  if (d.some((n) => !Number.isSafeInteger(n))) throw new RangeError('copy offset 必须是整数');
  let mirrorIndex = -1;
  let center: Vec3 | undefined;
  if (options.mirrorAxis !== undefined) {
    mirrorIndex = AXIS_INDEX[requireAxis(options.mirrorAxis, 'mirrorAxis')];
    if (!options.center) throw new RangeError('mirrorAxis 需要 center（区域中心）');
    center = options.center;
  }
  return cells.map((cell) => {
    const out: ColoredCell = [cell[0], cell[1], cell[2], cell[3]];
    if (mirrorIndex >= 0 && center) out[mirrorIndex] = Math.round(2 * center[mirrorIndex] - out[mirrorIndex]);
    out[0] += d[0];
    out[1] += d[1];
    out[2] += d[2];
    return out;
  });
}

/** Drop repeated coordinates (first occurrence wins, color preserved). */
export function dedupeCells(cells: ReadonlyArray<ColoredCell>): ColoredCell[] {
  const seen = new Set<string>();
  const out: ColoredCell[] = [];
  for (const cell of cells) {
    const key = `${cell[0]},${cell[1]},${cell[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
  }
  return out;
}

/** Keep cells inside [0, shape-1]; out-of-bounds cells are clipped, not wrapped. */
export function filterCellsInBounds<T extends ColoredCell | Cell>(
  cells: ReadonlyArray<T>,
  shape: Vec3,
): T[] {
  return cells.filter(
    (cell) =>
      cell[0] >= 0 &&
      cell[1] >= 0 &&
      cell[2] >= 0 &&
      cell[0] < shape[0] &&
      cell[1] < shape[1] &&
      cell[2] < shape[2],
  );
}
