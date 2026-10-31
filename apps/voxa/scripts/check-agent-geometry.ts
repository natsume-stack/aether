import assert from 'node:assert/strict';

import {
  copyRegionCells,
  cylinderCells,
  dedupeCells,
  ellipsoidCells,
  filterCellsInBounds,
  mirrorCells,
  normalizeBox,
  sphereCells,
} from '../src/models/agent-live/geometry-commands';

function bounds(cells: Array<[number, number, number]>) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const cell of cells) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], cell[axis]);
      max[axis] = Math.max(max[axis], cell[axis]);
    }
  }
  return { min, max };
}

// ---- sphere ---------------------------------------------------------------
const smallSphere = sphereCells([0, 0, 0], 1);
assert.equal(smallSphere.length, 7, 'radius 1 solid sphere = centre + 6 neighbours');
assert.deepEqual(bounds(smallSphere), { min: [-1, -1, -1], max: [1, 1, 1] });
assert.ok(smallSphere.some((cell) => cell.join() === '1,0,0'));

const sphere2 = sphereCells([0, 0, 0], 2);
assert.equal(sphere2.length, 33, 'radius 2 lattice sphere');
assert.deepEqual(bounds(sphere2), { min: [-2, -2, -2], max: [2, 2, 2] });
assert.ok(sphere2.every((cell) => cell[0] ** 2 + cell[1] ** 2 + cell[2] ** 2 <= 4));

const hollow1 = sphereCells([0, 0, 0], 1, true);
assert.equal(hollow1.length, 6, 'hollow radius 1 keeps the 6-cell shell');
assert.ok(!hollow1.some((cell) => cell.join() === '0,0,0'));

const hollow2 = sphereCells([0, 0, 0], 2, true);
assert.equal(hollow2.length, 26, 'hollow radius 2 keeps the 1-voxel shell (33 - 7 interior)');
assert.ok(!hollow2.some((cell) => cell.join() === '0,0,0'));

const offsetSphere = sphereCells([10, 20, 30], 1);
assert.deepEqual(bounds(offsetSphere), { min: [9, 19, 29], max: [11, 21, 31] });

// ---- ellipsoid ------------------------------------------------------------
const ellipsoid = ellipsoidCells([0, 0, 0], [1, 1, 3]);
assert.equal(ellipsoid.length, 11, 'rx=ry=1, rz=3 lattice ellipsoid');
assert.deepEqual(bounds(ellipsoid), { min: [-1, -1, -3], max: [1, 1, 3] });
assert.ok(ellipsoid.some((cell) => cell.join() === '0,0,3'));
assert.ok(!ellipsoid.some((cell) => cell.join() === '1,1,0'));

const hollowEllipsoid = ellipsoidCells([0, 0, 0], [1, 1, 3], true);
assert.equal(hollowEllipsoid.length, 10, 'hollow ellipsoid drops the centre only');
assert.ok(!hollowEllipsoid.some((cell) => cell.join() === '0,0,0'));

// ---- cylinder -------------------------------------------------------------
const cylinderY = cylinderCells([0, 0, 0], 1, 3, 'y');
assert.equal(cylinderY.length, 15, 'radius 1 disc (5 cells) x height 3');
assert.deepEqual(bounds(cylinderY), { min: [-1, 0, -1], max: [1, 2, 1] });
assert.ok(cylinderY.some((cell) => cell.join() === '0,0,0'));
assert.ok(cylinderY.some((cell) => cell.join() === '0,2,0'));
assert.ok(!cylinderY.some((cell) => cell[1] === 3));

const cylinderX = cylinderCells([0, 0, 0], 1, 2, 'x');
assert.equal(cylinderX.length, 10, 'axis x: two yz discs');
assert.deepEqual(bounds(cylinderX), { min: [0, -1, -1], max: [1, 1, 1] });

const cylinderZ = cylinderCells([0, 0, 0], 1, 2, 'z');
assert.equal(cylinderZ.length, 10);
assert.deepEqual(bounds(cylinderZ), { min: [-1, -1, 0], max: [1, 1, 1] });

const hollowCylinder = cylinderCells([0, 0, 0], 1, 3, 'y', true);
assert.equal(hollowCylinder.length, 14, 'hollow cylinder keeps rims and lateral wall');
assert.ok(!hollowCylinder.some((cell) => cell.join() === '0,1,0'));
assert.ok(hollowCylinder.some((cell) => cell.join() === '0,0,0'));

// ---- mirror ---------------------------------------------------------------
const mirrorSource: Array<[number, number, number, number]> = [
  [0, 0, 0, 5],
  [1, 2, 3, 7],
];
assert.deepEqual(mirrorCells(mirrorSource, 'x', 1.5), [
  [3, 0, 0, 5],
  [2, 2, 3, 7],
]);
assert.deepEqual(mirrorCells(mirrorSource, 'z', 0), [
  [0, 0, 0, 5],
  [1, 2, -3, 7],
]);
assert.deepEqual(mirrorCells([], 'y', 2.5), []);

// ---- copy_region ----------------------------------------------------------
const region = normalizeBox([0, 0, 0], [3, 0, 0]);
assert.equal(region.volume, 4);
assert.deepEqual(region.center, [1.5, 0, 0]);

const copySource: Array<[number, number, number, number]> = [
  [0, 0, 0, 4],
  [1, 0, 0, 9],
];
assert.deepEqual(copyRegionCells(copySource, [0, 1, 0]), [
  [0, 1, 0, 4],
  [1, 1, 0, 9],
]);
assert.deepEqual(copyRegionCells(copySource, [0, 1, 0], { mirrorAxis: 'x', center: region.center }), [
  [3, 1, 0, 4],
  [2, 1, 0, 9],
]);

// ---- dedupe / bounds ------------------------------------------------------
assert.deepEqual(dedupeCells([[1, 1, 1, 2], [1, 1, 1, 3], [2, 1, 1, 4]]), [
  [1, 1, 1, 2],
  [2, 1, 1, 4],
]);
assert.deepEqual(
  filterCellsInBounds([[-1, 0, 0, 1], [0, 0, 0, 2], [4, 0, 0, 3]], [4, 4, 4]),
  [[0, 0, 0, 2]],
);

// ---- validation -----------------------------------------------------------
assert.throws(() => sphereCells([0, 0, 0], 0), RangeError);
assert.throws(() => sphereCells([0, 0, 0], 65), RangeError);
assert.throws(() => ellipsoidCells([0, 0, 0], [1, 0, 1]), RangeError);
assert.throws(() => cylinderCells([0, 0, 0], 1, 1, 'w' as never), RangeError);
assert.throws(() => cylinderCells([0, 0, 0], 1, 129), RangeError);
assert.throws(() => mirrorCells(mirrorSource, 'x', Number.NaN), RangeError);
assert.throws(() => copyRegionCells(copySource, [0, 0] as never), RangeError);
assert.throws(() => copyRegionCells(copySource, [0, 0, 0], { mirrorAxis: 'x' }), RangeError);

process.stdout.write(
  'check-agent-geometry: ok (sphere/ellipsoid/cylinder/mirror/copy/box/dedupe/bounds/validation)\n',
);
