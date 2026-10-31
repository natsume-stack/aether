/** Explicit migration of legacy Aether source into a NEW bundle. Runtime data,
 * palette, voxel bytes, animation channels and existing part transforms stay exact.
 * No existing workspace model or original bundle is overwritten. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeBundle, nodeJson } from '../../aether/aether/src/chisel/run-model-v3.mjs';
const require = createRequire(new URL('../apps/voxa/package.json', import.meta.url));
const JSZip = require('jszip');
const vp = require('@box/voxa-project');
const input = path.resolve(process.argv[2] || '../runs/bat/夜翼蝙蝠.voxaproject');
const output = path.resolve(process.argv[3] || '../_corpus/model-continuation/夜翼蝙蝠-编辑源修复.voxaproject');
await fs.access(output).then(() => { throw new Error('Output exists; choose a new file'); }, e => { if (e.code !== 'ENOENT') throw e; });
const zip = await JSZip.loadAsync(await fs.readFile(input));
const sourceBytes = await zip.file('project.bin').async('nodebuffer');
const decoded = vp.projectBytesToSchema(sourceBytes);
assert.equal(decoded.version, 10);
const source = vp.projectV10.ProjectDataV10Schema.toJSON(decoded.schema);
const before = structuredClone(source);
const actions = [];
for (const [id, voxel] of Object.entries(source.voxels)) {
  if (voxel.id !== id) { actions.push({ action: 'restore-voxel-resource-id', id }); voxel.id = id; }
}
for (const bone of Object.values(source.nodes).filter(node => node.type === 3)) {
  const skins = (bone.childrenIds || []).filter(id => [1, 2].includes(source.nodes[id]?.type));
  if (!skins.length) continue;
  assert.ok(!bone.skinId, `Refuse ambiguous existing binding on ${bone.id}`);
  const id = `${bone.id}__skin`;
  assert.ok(!source.nodes[id], 'Generated group ID must be new');
  const group = nodeJson({ id, name: `${bone.name}Skin`, type: 2, parentId: '', childrenIds: skins });
  group.boneId = bone.id;
  source.nodes[id] = group;
  bone.skinId = id;
  bone.childrenIds = bone.childrenIds.filter(child => !skins.includes(child));
  for (const child of skins) source.nodes[child].parentId = id;
  actions.push({ action: 'bind-skin-group', boneId: bone.id, groupId: id, parts: skins });
}
for (const [id, node] of Object.entries(before.nodes)) {
  for (const key of ['position', 'quaternion', 'pivot', 'scale', 'voxelId']) assert.deepEqual(source.nodes[id][key], node[key]);
}
assert.deepEqual(source.animations, before.animations);
assert.deepEqual(source.palette, before.palette);
for (const id of Object.keys(before.voxels)) assert.deepEqual(source.voxels[id].encodedView, before.voxels[id].encodedView);
const runtime = await zip.file('model-data.bin').async('nodebuffer');
const modelSchema = vp.modelBytesToSchema(runtime).schema;
const meta = JSON.parse(await zip.file('model-meta.bin').async('string'));
meta.projectName = path.basename(output, '.voxaproject');
await fs.mkdir(path.dirname(output), { recursive: true });
const result = await writeBundle({ projectSchema: vp.projectV10.ProjectDataV10Schema.fromJSON(source), modelSchema,
  meta, previewPng: await zip.file('preview.bin').async('nodebuffer'), outFile: output });
assert.deepEqual(result.dataBytes, runtime, 'Runtime geometry and animations must remain byte exact');
console.log(JSON.stringify({ input, output, actions, runtimeBytesUnchanged: true,
  originalNodeCount: Object.keys(before.nodes).length, nodeCount: Object.keys(source.nodes).length,
  animationCount: source.animations.length, note: 'Explicit source binding repair; not artistic improvement or proof of bake equivalence.' }, null, 2));
