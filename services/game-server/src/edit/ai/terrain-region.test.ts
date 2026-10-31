import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore Native Node runner requires explicit extensions.
import { readTerrainRegion } from './terrain-region.ts';

test('a tiny read of a huge region touches only requested cells', () => {
  let reads = 0;
  const view = { shape: [1024, 1024, 1024], getVoxel: () => { reads++; return 3; } };
  const result = readTerrainRegion(view, { min: [0, 0, 0], max: [1023, 1023, 1023] }, 7, true);
  assert.equal(result.total, 1024 ** 3);
  assert.equal(result.cells.length, 7);
  assert.equal(reads, 7);
});

test('oversized mutation fails before allocating or touching voxel data', () => {
  const view = { shape: [256, 64, 256], getVoxel: () => { throw new Error('must not be called'); } };
  assert.throws(() => readTerrainRegion(view, { min: [0, 0, 0], max: [255, 63, 255] }), { code: 'REGION_TOO_LARGE' });
});

test('clipped region total and traversal stay consistent', () => {
  const view = { shape: [2, 2, 2], getVoxel: (x: number, y: number, z: number) => x + y + z };
  const result = readTerrainRegion(view, { min: [1, 1, 1], max: [20, 20, 20] });
  assert.equal(result.total, 1);
  assert.deepEqual(result.cells, [{ x: 1, y: 1, z: 1, b: 3 }]);
});
