import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildProjectJson } from './run-model-v3.mjs';
import { Palette, Sculptor, hsvToRgb } from './model-sculpt.mjs';

const require = createRequire(new URL('../../../../box3-local-engine/apps/voxa/package.json', import.meta.url));
const vp = require('@box/voxa-project');
const { restoreVoxels } = require('@box/utils/voxel');
const { MuReadStream } = require('@box/mudb/stream');

test('generated editable source survives native loader contracts: voxel IDs, skin bindings and nested bones', () => {
  const palette = new Palette(); palette.add('#8040c0');
  const sculptor = new Sculptor(3, 3, 3); sculptor.set(1, 1, 1, 1);
  const model = { palette, groups: [
    { id: 'wing', name: 'Wing', bone: 'tip', position: [12, 3, 0], sculptor },
    { id: 'body', name: 'Body', position: [0, 0, 0], sculptor },
  ], bones: [
    { id: 'base', name: 'Base', position: [10, 0, 0] },
    { id: 'tip', name: 'Tip', parent: 'base', position: [12, 3, 0] },
  ] };
  const { project } = buildProjectJson(model);
  const decoded = vp.projectBytesToSchema(vp.projectSchemaToBytes(vp.projectV10.ProjectDataV10Schema.fromJSON(project))).schema;
  assert.deepEqual(decoded.nodes.ROOT_BONE.childrenIds, ['base']);
  assert.deepEqual(decoded.nodes.base.childrenIds, ['tip']);
  assert.deepEqual(Array.from(decoded.nodes.tip.position), [2, 3, 0]);
  assert.equal(decoded.nodes.tip.skinId, 'tip__skin');
  assert.equal(decoded.nodes.tip__skin.boneId, 'tip');
  assert.equal(decoded.nodes.tip__skin.parentId, '');
  assert.equal(decoded.nodes.wing.parentId, 'tip__skin');
  assert.deepEqual(Array.from(decoded.palette.items[0].hsv), [270, 67, 75]);
  assert.deepEqual(Array.from(decoded.nodes.wing.position), [0, 0, 0]);
  for (const [id, resource] of Object.entries(decoded.voxels)) {
    assert.equal(resource.id, id, 'native loader indexes by value.id, not dictionary key');
    const { voxels, isEmpty } = restoreVoxels(new MuReadStream(new Uint8Array(resource.encodedView)));
    assert.equal(isEmpty, false);
    assert.equal(voxels.getVoxel(1, 1, 1), 1);
  }
});

test('overbright ramps clamp rather than wrapping purple highlights into green/yellow', () => {
  const bright = hsvToRgb([270, 0.5, 1.2]);
  assert.ok(Math.abs(bright[0] - 229.5) <= 0.5);
  assert.deepEqual(bright.slice(1), [153, 255]);
  const palette = new Palette();
  palette.ramp('highlight', '#eeaaff', { vRange: [0.95, 1.2] });
  assert.ok(palette.items.every(item => item.rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)));
});
