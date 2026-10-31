import assert from 'node:assert/strict';
import {
  buildProjections,
  buildQuality,
  formatModelingBrief,
  MODELING_BRIEF_LIMIT,
} from '../server/modeling-context';

function context(cells: unknown[], shape: number[], extra: Record<string, any> = {}) {
  return {
    voxelContext: {
      partId: 'p1',
      shape,
      cells,
      scanned: extra.scanned === undefined ? cells.length : extra.scanned,
      totalCells: shape[0] * shape[1] * shape[2],
      truncated: extra.truncated === true,
    },
    parts: extra.parts === undefined ? [{ id: 'p1', name: 'body' }] : extra.parts,
    palette: [{ id: 5, colorId: 5, rgb: [255, 0, 0] }],
  };
}

function cube(size: number, color = 5): number[][] {
  const cells: number[][] = [];
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let z = 0; z < size; z += 1) cells.push([x, y, z, color]);
    }
  }
  return cells;
}

function filled(grid: number[][]): number {
  let total = 0;
  for (const row of grid) for (const cell of row) if (cell > 0) total += 1;
  return total;
}

function checkCube(): void {
  const ctx = context(cube(3), [3, 3, 3]);
  const quality = buildQuality(ctx);
  assert.equal(quality.occupiedCells, 27);
  assert.deepEqual(quality.shape, [3, 3, 3]);
  assert.equal(quality.symmetryX, 1);
  assert.equal(quality.components, 1);
  assert.equal(quality.floatingComponents, 0);
  assert.equal(quality.largestComponentShare, 1);
  assert.deepEqual(quality.bounds, { min: [0, 0, 0], max: [2, 2, 2] });
  assert.deepEqual(quality.paletteUsage, [{ colorId: 5, count: 27 }]);
  assert.equal(quality.partCount, 1);
  assert.equal(quality.truncated, false);

  const projections = buildProjections(ctx);
  assert.equal(projections.front.length, 24);
  assert.ok(projections.front.every((row) => row.length === 24));
  assert.equal(filled(projections.front), 9);
  assert.equal(filled(projections.side), 9);
  assert.equal(filled(projections.top), 9);
  assert.deepEqual(projections.front, projections.side);
  assert.deepEqual(projections.front, projections.top);
  assert.ok(projections.front.every((row) => row.every((cell) => cell === 0 || cell === 5)));

  const brief = formatModelingBrief(projections, quality);
  assert.ok(brief.length <= MODELING_BRIEF_LIMIT);
  assert.ok(brief.includes('shape=3x3x3'));
  assert.ok(brief.includes('symmetryX=100%'));
  assert.ok(brief.includes('components=1'));
  assert.ok(brief.includes('PALETTE 5=27'));
  assert.ok(brief.includes('FRONT 3x3'));
  assert.ok(brief.includes('000'));

  const small = buildProjections(ctx, 8);
  assert.equal(small.front.length, 8);
  assert.equal(filled(small.front), 9);
  assert.equal(buildProjections(ctx, 0).front.length, 24);
  assert.equal(buildProjections(ctx, 999).front.length, 64);
}

function checkFloating(): void {
  const ctx = context(cube(3).concat([[6, 0, 0, 7]]), [8, 3, 3]);
  const quality = buildQuality(ctx);
  assert.equal(quality.occupiedCells, 28);
  assert.equal(quality.components, 2);
  assert.equal(quality.floatingComponents, 1);
  assert.ok(Math.abs(quality.largestComponentShare - 27 / 28) < 1e-12);
  assert.deepEqual(quality.bounds, { min: [0, 0, 0], max: [6, 2, 2] });
  assert.deepEqual(quality.paletteUsage, [
    { colorId: 5, count: 27 },
    { colorId: 7, count: 1 },
  ]);
  // The front view collapses the 3x3x3 block onto 9 screen cells; the stray
  // voxel at x=6 is a tenth one.
  assert.equal(filled(buildProjections(ctx).front), 10);
}

function checkLShapeAndColors(): void {
  const lShape = context([[0, 0, 0, 3], [1, 0, 0, 3], [0, 1, 0, 3]], [2, 2, 2]);
  const quality = buildQuality(lShape);
  assert.ok(quality.symmetryX < 1);
  assert.ok(Math.abs(quality.symmetryX - 2 / 3) < 1e-12);
  assert.equal(quality.components, 1);
  assert.equal(quality.floatingComponents, 0);
  assert.equal(quality.largestComponentShare, 1);

  const mixed = cube(3).map((cell, index) => [cell[0], cell[1], cell[2], index % 2 ? 5 : 9]);
  assert.equal(buildQuality(context(mixed, [3, 3, 3])).symmetryX, 1);
}

function checkAxes(): void {
  const vertical = buildProjections(context([[0, 2, 0, 9]], [1, 3, 1]));
  // A 3-tall block is centered in the 24 grid (rows 10..12); row 10 is maxY.
  assert.equal(vertical.front[10][11], 9);
  assert.equal(filled(vertical.front), 1);

  const layered = buildProjections(
    context([[0, 0, 0, 3], [0, 0, 1, 4]], [1, 1, 2]),
  );
  assert.equal(layered.front[11][11], 3); // nearest Z wins
  assert.equal(layered.side[11][11], 3);
  assert.equal(layered.side[11][12], 4);
  assert.equal(layered.top[11][11], 3);
  assert.equal(layered.top[12][11], 4);
}

function checkDownsampling(): void {
  const wide: number[][] = [];
  for (let x = 0; x < 48; x += 1) {
    for (let z = 0; z < 2; z += 1) {
      wide.push([x, 0, z, 1]);
      wide.push([x, 1, z, 2]);
    }
  }
  const ctx = context(wide, [48, 2, 2]);
  const quality = buildQuality(ctx);
  assert.equal(quality.occupiedCells, 192);
  assert.equal(quality.symmetryX, 1);
  assert.equal(quality.components, 1);

  const projections = buildProjections(ctx);
  assert.equal(projections.top.length, 24);
  assert.equal(projections.top[11][0], 1); // nearest Y
  assert.equal(projections.top[11][23], 1);
  // The bottom layer wins the top depth, so z=1 still shows the y=0 color.
  assert.equal(projections.top[12][0], 1);
  assert.equal(projections.front[12][0], 1); // y=0 row (flipped)
  assert.equal(projections.side[11][11], 2); // y=1 row, col0 = Z0
  assert.equal(projections.side[11][12], 2);
  for (let column = 0; column < 24; column += 1) {
    assert.ok(projections.top[11][column] > 0);
  }

  // A downsampled bucket spans several screen pixels: dominant color wins.
  const dominant = buildProjections(
    context([[0, 0, 0, 3], [1, 0, 0, 4], [2, 0, 0, 4]], [6, 1, 1]),
    2,
  );
  assert.equal(dominant.front[0][0], 4);
  assert.equal(dominant.front[0][1], 0);

  // Same nearest plane with equal counts: the smallest colorId wins.
  const tie = buildProjections(context([[0, 0, 0, 3], [1, 0, 0, 4]], [4, 1, 1]), 2);
  assert.equal(tie.front[0][0], 3);
}

function checkInvalidCells(): void {
  const invalid = context(
    [
      ['1', 0, 0, 4],
      [1.5, 0, 0, 4],
      [-1, 0, 0, 4],
      [0, 0, 0, 0],
      [0, 0, 0],
      [9, 9, 9, 4],
      null,
      [1, 1, 1, 6],
    ],
    [3, 3, 3],
  );
  const quality = buildQuality(invalid);
  assert.equal(quality.occupiedCells, 1);
  assert.deepEqual(quality.bounds, { min: [1, 1, 1], max: [1, 1, 1] });
  assert.equal(quality.symmetryX, 1);
  assert.equal(quality.components, 1);
  assert.equal(filled(buildProjections(invalid).front), 1);

  const duplicate = buildQuality(context([[1, 1, 1, 6], [1, 1, 1, 7]], [3, 3, 3]));
  assert.equal(duplicate.occupiedCells, 1);
  assert.deepEqual(duplicate.paletteUsage, [{ colorId: 6, count: 1 }]);
}

function checkMalformed(): void {
  const emptyProjections = buildProjections(null);
  assert.equal(filled(emptyProjections.front), 0);
  assert.equal(emptyProjections.front.length, 24);

  const emptyQuality = buildQuality(undefined);
  assert.deepEqual(emptyQuality.shape, [0, 0, 0]);
  assert.equal(emptyQuality.occupiedCells, 0);
  assert.equal(emptyQuality.bounds, null);
  assert.equal(emptyQuality.components, 0);
  assert.equal(emptyQuality.floatingComponents, 0);
  assert.equal(emptyQuality.symmetryX, 0);
  assert.equal(emptyQuality.largestComponentShare, 0);
  assert.deepEqual(emptyQuality.paletteUsage, []);
  assert.equal(emptyQuality.partCount, 0);
  assert.equal(emptyQuality.partBounds, undefined);

  assert.doesNotThrow(() => buildProjections({ voxelContext: { shape: ['a', 1, 1], cells: 'nope' } }));
  assert.doesNotThrow(() => buildQuality({ voxelContext: { shape: null, cells: [null, {}, 42] } }));
  assert.doesNotThrow(() => formatModelingBrief(null as any, null as any));

  const derived = buildQuality({
    voxelContext: { shape: [0, 0, 0], cells: [[0, 0, 0, 1], [1, 1, 1, 2]] },
  });
  assert.deepEqual(derived.shape, [2, 2, 2]);
  assert.equal(derived.occupiedCells, 2);
  assert.equal(derived.components, 2);
  assert.equal(derived.largestComponentShare, 0.5);

  assert.equal(buildQuality(context(cube(2), [2, 2, 2], { truncated: true })).truncated, true);

  const brief = formatModelingBrief(emptyProjections, emptyQuality);
  assert.ok(brief.length > 0 && brief.length <= MODELING_BRIEF_LIMIT);
  assert.ok(brief.includes('shape=0x0x0'));
}

function checkParts(): void {
  const partsCtx = context(cube(2), [2, 2, 2], {
    parts: [
      { id: 'a', bounds: [0, 0, 0, 2, 2, 2] },
      { id: 'b', cells: [[5, 0, 0, 7], [6, 1, 2, 7]] },
      { name: 'no-bounds' },
    ],
  });
  const quality = buildQuality(partsCtx);
  assert.equal(quality.partCount, 3);
  assert.equal(quality.partBounds?.length, 2);
  assert.deepEqual(quality.partBounds?.[0], { id: 'a', min: [0, 0, 0], max: [2, 2, 2] });
  assert.deepEqual(quality.partBounds?.[1], { id: 'b', min: [5, 0, 0], max: [6, 1, 2] });
}

function checkBounds(): void {
  const many: number[][] = [];
  for (let index = 0; index < 5000; index += 1) {
    const x = index % 50;
    const y = Math.floor(index / 50) % 50;
    const z = Math.floor(index / 2500);
    many.push([x, y, z, ((x + y + z) % 40) + 1]);
  }
  const ctx = context(many, [50, 50, 50]);
  const quality = buildQuality(ctx);
  assert.equal(quality.occupiedCells, 4096);
  assert.equal(quality.truncated, true);
  const brief = formatModelingBrief(buildProjections(ctx), quality);
  assert.ok(brief.length <= MODELING_BRIEF_LIMIT);
  assert.ok(brief.includes('truncated=yes'));
}

function main(): void {
  checkCube();
  checkFloating();
  checkLShapeAndColors();
  checkAxes();
  checkDownsampling();
  checkInvalidCells();
  checkMalformed();
  checkParts();
  checkBounds();
  console.log('modeling context: projections, quality, brief and malformed input checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
