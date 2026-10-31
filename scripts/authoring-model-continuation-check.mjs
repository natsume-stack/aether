// Read-only proof for an already native-saved continuation model. Does not
// mutate the model store, browser, bundle or original creator work.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { voxaContentHash } from '../tools/box3-voxa-mcp/src/bundle-integrity.js';
const require = createRequire(new URL('../apps/voxa/package.json', import.meta.url));
const vp = require('@box/voxa-project');
const JSZip = require('jszip');
const [root, rawId = '4', baseline = '../_corpus/model-continuation/夜翼蝙蝠-编辑源修复.voxaproject', exportFile] = process.argv.slice(2);
if (!root) throw new Error('usage: node scripts/authoring-model-continuation-check.mjs <VOXA data root> [modelId] [baseline bundle]');
const index = JSON.parse(await fs.readFile(path.join(root, 'models.json')));
const model = index.models.find(item => item.modelId === Number(rawId));
assert.ok(model);
assert.ok(model.revision >= 2, 'Native save must have advanced the imported revision');
const original = await JSZip.loadAsync(await fs.readFile(baseline));
const before = vp.projectV10.ProjectDataV10Schema.toJSON(vp.projectBytesToSchema(await original.file('project.bin').async('uint8array')).schema);
const bytes = await fs.readFile(path.join(root, 'blobs', model.projectFileHash));
const after = vp.projectV10.ProjectDataV10Schema.toJSON(vp.projectBytesToSchema(bytes).schema);
assert.deepEqual(Object.keys(after.nodes).sort(), Object.keys(before.nodes).sort());
for (const id of Object.keys(before.nodes)) {
  for (const field of ['type','name','parentId','childrenIds','skinId','boneId','voxelId','position','pivot','scale','quaternion'])
    // Native exporter omits transforms on the three bookkeeping roots.
    if (!(['ROOT','ROOT_BONE','ROOT_SKIN'].includes(id) && ['scale','quaternion'].includes(field)))
      assert.deepEqual(after.nodes[id][field], before.nodes[id][field], `${id}.${field} must survive material continuation`);
}
assert.deepEqual(after.voxels, before.voxels, 'All seven voxel resources must remain exact');
function canonicalAnimations(animations) {
  return animations.map(animation => ({ ...animation, nodes: Object.fromEntries(Object.entries(animation.nodes).map(([id,node]) =>
    [id, { ...node, keyframeList: node.keyframeList.map(key => ({ ...key, offset: {
      alpha: key.offset.alpha ?? 1, rotation: key.offset.rotation ?? [0,0,0,1],
      scale: key.offset.scale ?? [1,1,1], translation: key.offset.translation ?? [0,0,0],
    } })) }])) }));
}
assert.deepEqual(canonicalAnimations(after.animations), canonicalAnimations(before.animations), 'Animation channels and keyframes must survive semantically');
const changed = [];
for (const item of before.palette.items) {
  const next = after.palette.items.find(value => value.id === item.id);
  if (JSON.stringify(item) !== JSON.stringify(next)) changed.push({ id: item.id, before: item, after: next });
}
assert.deepEqual(changed.map(item => item.id), [24]);
assert.deepEqual(changed[0].after.rgb, [255,213,119]);
assert.equal(changed[0].after.material.emissive, 89);
const meta = JSON.parse(await fs.readFile(path.join(root, 'blobs', model.modelFileHash)));
const runtimeBytes = await fs.readFile(path.join(root, 'blobs', meta.dataHash));
const runtime = vp.modelBytesToSchema(runtimeBytes).schema;
// Native baker preserves palette ID 0 as air/reserved.
assert.equal(runtime.texture.palette[24] >>> 0, 0xffd57759);
assert.equal(runtime.animations.length, before.animations.length);
assert.equal(model.animated, true);
const proof = { stage: 'native-save-source-and-runtime-material-match', modelId: model.modelId,
  revision: model.revision, sourceNodeCount: Object.keys(after.nodes).length,
  voxelResources: Object.keys(after.voxels).length, animationCount: after.animations.length,
  changedPaletteIds: changed.map(item => item.id), nativeRuntimePalette24: runtime.texture.palette[24] >>> 0,
  nativeNormalization: 'bookkeeping root transforms omitted; identity animation offsets omitted, semantic defaults compared',
  sourceFileHash: model.projectFileHash, runtimeDataHash: meta.dataHash,
  scope: 'existing model material continuation; topology, voxels, transforms, animations preserved; not artistic quality or map binding acceptance' };
if (exportFile) {
  const resources = new Map([
    ['model-data.bin', runtimeBytes],
    ['model-meta.bin', await fs.readFile(path.join(root, 'blobs', model.modelFileHash))],
    ['preview.bin', await fs.readFile(path.join(root, 'blobs', model.modelPreviewHash))],
  ]);
  const bundle = new JSZip();
  bundle.file('manifest.json', JSON.stringify({ format: 'box-voxa-project', formatVersion: 1,
    projectName: model.modelName, editType: 0, exportedAt: new Date().toISOString(),
    resources: [...resources].map(([name, data]) => ({ name, hash: voxaContentHash(data), contentType: 'application/octet-stream' })),
  }, null, 2));
  bundle.file('project.bin', bytes);
  for (const [name, data] of resources) bundle.file(name, data);
  await fs.writeFile(exportFile, await bundle.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx' });
  proof.exportFile = path.resolve(exportFile);
}
await fs.writeFile('.local-evidence/model-continuation-native-save.json', JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
