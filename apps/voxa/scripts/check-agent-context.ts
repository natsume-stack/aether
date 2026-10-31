import assert from 'node:assert/strict';

import { buildContextPayload, canonicalContext, contextHash } from '../server/agent-context';

const base = canonicalContext({
  voxelContext: { partId: 'p1', shape: [16, 16, 16], cells: [[2, 0, 0, 1], [1, 0, 0, 1]], scanned: 4096, totalCells: 4096, truncated: false },
  parts: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }],
  palette: [{ colorId: 2, rgb: [2, 2, 2] }, { colorId: 1, rgb: [1, 1, 1] }],
});
assert.deepEqual(base.voxelContext.cells, [[1, 0, 0, 1], [2, 0, 0, 1]]);
assert.deepEqual(base.parts.map((part) => part.id), ['a', 'b']);
assert.deepEqual(base.palette.map((color) => color.colorId), [1, 2]);
assert.equal(contextHash(base), contextHash(canonicalContext({
  parts: [{ name: 'B', id: 'b' }, { name: 'A', id: 'a' }],
  palette: [{ rgb: [2, 2, 2], colorId: 2 }, { rgb: [1, 1, 1], colorId: 1 }],
  voxelContext: { truncated: false, totalCells: 4096, scanned: 4096, cells: [[2, 0, 0, 1], [1, 0, 0, 1]], shape: [16, 16, 16], partId: 'p1' },
})));

assert.equal(buildContextPayload(base).mode, 'full');

const next = canonicalContext({
  voxelContext: { partId: 'p1', shape: [16, 16, 16], cells: [[1, 0, 0, 1], [3, 0, 0, 2]], scanned: 4096, totalCells: 4096, truncated: false },
  parts: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }],
  palette: [{ colorId: 2, rgb: [2, 2, 2] }, { colorId: 1, rgb: [1, 1, 1] }],
});
const delta = buildContextPayload(next, base);
assert.equal(delta.mode, 'delta');
assert.deepEqual((delta.payload as any).contextDelta.added, [[3, 0, 0, 2]]);
assert.deepEqual((delta.payload as any).contextDelta.removed, [[2, 0, 0, 1]]);
assert.equal((delta.payload as any).contextDelta.cellCount, 2);

const changedPart = canonicalContext({ ...next, voxelContext: { ...next.voxelContext, partId: 'p2' } });
assert.equal(buildContextPayload(changedPart, next).mode, 'full');

const shapeChanged = canonicalContext({ ...next, voxelContext: { ...next.voxelContext, shape: [32, 16, 16] } });
assert.equal(buildContextPayload(shapeChanged, next).mode, 'full');

const unchanged = buildContextPayload(next, next);
assert.equal(unchanged.mode, 'delta');
assert.equal((unchanged.payload as any).contextDelta.unchanged, true);

console.log('agent context canonicalization and delta passed');
