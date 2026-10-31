import assert from 'node:assert/strict';

import { batRecipe } from '../server/modeling-recipes';
import { buildProjections, buildQuality, formatModelingBrief } from '../server/modeling-context';
import { ellipsoidCells } from '../src/models/agent-live/geometry-commands';

const shape: [number, number, number] = [16, 16, 16];
const batches = batRecipe(shape);
const palette = new Map<string, number>();
const voxels = new Map<string, number>();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
let nextColor = 1;

function colorOf(value: unknown) {
  if (typeof value === 'string' && value.startsWith('$')) {
    const id = palette.get(value);
    if (!id) throw new Error(`unknown palette alias ${value}`);
    return id;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function write(x: number, y: number, z: number, color: number) {
  if (x < 0 || y < 0 || z < 0 || x >= shape[0] || y >= shape[1] || z >= shape[2]) return;
  if (color === 0) voxels.delete(key(x, y, z));
  else voxels.set(key(x, y, z), color);
}

for (const batch of batches) {
  for (const command of batch.commands) {
    const args = command.args as Record<string, any>;
    if (command.kind === 'palette_add') {
      palette.set(String(args.alias), nextColor++);
      continue;
    }
    if (command.kind === 'ellipsoid') {
      const color = colorOf(args.colorId);
      for (const cell of ellipsoidCells(args.center, args.radii, Boolean(args.hollow))) write(cell[0], cell[1], cell[2], color);
      continue;
    }
    if (command.kind === 'fill_box') {
      const color = colorOf(args.colorId);
      const min = args.from.map((value: number, index: number) => Math.min(value, args.to[index]));
      const max = args.from.map((value: number, index: number) => Math.max(value, args.to[index]));
      for (let x = min[0]; x <= max[0]; x += 1) for (let y = min[1]; y <= max[1]; y += 1) for (let z = min[2]; z <= max[2]; z += 1) write(x, y, z, color);
      continue;
    }
    if (command.kind === 'erase_box') {
      const min = args.from.map((value: number, index: number) => Math.min(value, args.to[index]));
      const max = args.from.map((value: number, index: number) => Math.max(value, args.to[index]));
      for (let x = min[0]; x <= max[0]; x += 1) for (let y = min[1]; y <= max[1]; y += 1) for (let z = min[2]; z <= max[2]; z += 1) write(x, y, z, 0);
      continue;
    }
    if (command.kind === 'paint') {
      write(args.at[0], args.at[1], args.at[2], colorOf(args.colorId));
      continue;
    }
    if (command.kind === 'paint_path') {
      const color = colorOf(args.colorId);
      for (const point of args.points) write(point[0], point[1], point[2], color);
      continue;
    }
    if (command.kind === 'mirror') {
      for (const [position, color] of [...voxels]) {
        const [x, y, z] = position.split(',').map(Number);
        write(shape[0] - 1 - x, y, z, color);
      }
      continue;
    }
  }
}

const cells = [...voxels.entries()].map(([position, color]) => {
  const [x, y, z] = position.split(',').map(Number);
  return [x, y, z, color];
});
const context = {
  voxelContext: { partId: 'bat', shape, cells, scanned: 4096, totalCells: 4096, truncated: false },
  parts: [{ id: 'bat', name: 'Bat' }],
  palette: [...palette.entries()].map(([alias, colorId]) => ({ alias, colorId })),
};
const quality = buildQuality(context);
const projections = buildProjections(context);
console.log('cells', quality.occupiedCells, 'symmetry', quality.symmetryX.toFixed(3), 'components', quality.components, 'floating', quality.floatingComponents, 'colors', quality.paletteUsage.length);
console.log(formatModelingBrief(projections, quality));
console.log('front:');
console.log(projections.front.map((row) => row.map((value) => value === 0 ? '.' : String(value)).join('')).join('\n'));
console.log('side:');
console.log(projections.side.map((row) => row.map((value) => value === 0 ? '.' : String(value)).join('')).join('\n'));
console.log('top:');
console.log(projections.top.map((row) => row.map((value) => value === 0 ? '.' : String(value)).join('')).join('\n'));

assert.ok(quality.occupiedCells > 150, `expected a detailed bat, got ${quality.occupiedCells}`);
assert.ok(quality.symmetryX > 0.95, `symmetry ${quality.symmetryX}`);
assert.equal(quality.floatingComponents, 0);
assert.equal(quality.components, 1);
assert.ok(quality.paletteUsage.length >= 5);
console.log('bat recipe quality passed');
