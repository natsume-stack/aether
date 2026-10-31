import assert from 'node:assert/strict';

import {
  buildModelProjectBundle,
  readModelProjectBundle,
} from '../server/local-voxa-project-bundle';

async function main() {
  const projectBytes = new Uint8Array([1, 2, 3]);
  const modelMetadataBytes = new Uint8Array([4, 5, 6]);
  const modelDataBytes = new Uint8Array([7, 8, 9]);
  const previewBytes = new Uint8Array([10, 11, 12]);
  const bundle = await buildModelProjectBundle({
    projectName: '可放置模型',
    editType: 0,
    projectBytes,
    resources: [
      { name: 'model-meta.bin', hash: 'QmModelMetadata', data: modelMetadataBytes },
      { name: 'model-data.bin', hash: 'QmModelData', data: modelDataBytes },
      { name: 'preview.bin', hash: 'QmPreview', data: previewBytes, contentType: 'image/png' },
    ],
  });

  const imported = await readModelProjectBundle(bundle);
  assert.equal(imported.projectName, '可放置模型');
  assert.equal(imported.editType, 0);
  assert.deepEqual(imported.projectBytes, projectBytes);
  assert.deepEqual(
    imported.resources.map((resource) => [resource.name, resource.hash, resource.data]),
    [
      ['model-meta.bin', 'QmModelMetadata', modelMetadataBytes],
      ['model-data.bin', 'QmModelData', modelDataBytes],
      ['preview.bin', 'QmPreview', previewBytes],
    ],
  );
  const mislabeled = await buildModelProjectBundle({ projectName: 'mislabel', editType: 1,
    projectBytes, resources: imported.resources });
  await assert.rejects(readModelProjectBundle(mislabeled), /VOXA_BUNDLE_MODE_MISMATCH/);
  const sourceSkin = await buildModelProjectBundle({ projectName: 'source skin', editType: 1, projectBytes });
  assert.equal((await readModelProjectBundle(sourceSkin)).editType, 1);
  console.log('model project bundle resource regression passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
