type Region = { min: [number, number, number]; max: [number, number, number] };
type View = { shape: ArrayLike<number>; getVoxel(x: number, y: number, z: number): number };

/** Bound allocation and voxel accesses before traversing a user-selected region. */
export function readTerrainRegion(view: View, region: Region, limit = 500_000, truncate = false) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500_000) throw new Error('Invalid cell limit');
  const min = region.min.map(n => Math.max(0, n));
  const max = region.max.map((n, axis) => Math.min(view.shape[axis] - 1, n));
  const total = min.reduce((count, n, axis) => count * Math.max(0, max[axis] - n + 1), 1);
  if (!Number.isSafeInteger(total) || (!truncate && total > limit)) {
    throw Object.assign(new Error(`Region contains ${total} cells; maximum ${limit}`), { code: 'REGION_TOO_LARGE' });
  }
  const cells: { x: number; y: number; z: number; b: number }[] = [];
  scan:
  for (let x = min[0]; x <= max[0]; x++) {
    for (let y = min[1]; y <= max[1]; y++) {
      for (let z = min[2]; z <= max[2]; z++) {
        if (cells.length >= limit) break scan;
        cells.push({ x, y, z, b: view.getVoxel(x, y, z) });
      }
    }
  }
  return { cells, total };
}
