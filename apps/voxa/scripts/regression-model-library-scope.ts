import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'box-local-model-library-scope-'),
);
process.env.VOXA_DATA_PATH = dataRoot;

async function main() {
  const { listModels, saveModel } = await import('../server/local-voxa-store');

  const localModel = await saveModel({
    modelName: '本地模型',
    modelType: 0,
    creativeMode: 1,
  });
  const projectModel = await saveModel({
    modelName: '地图内模型',
    modelType: 2,
    creativeMode: 1,
    mapId: 1001,
  });
  const projectSkin = await saveModel({
    modelName: '地图内人物',
    modelType: 1,
    creativeMode: 2,
    mapId: 1001,
  });

  assert.deepEqual(
    listModels().map((model) => model.modelId),
    [localModel.modelId],
    'the server-wide work center must not list map-scoped models or skins',
  );
  assert.deepEqual(
    listModels({ mapId: 1001 }).map((model) => model.modelId).sort(),
    [projectModel.modelId, projectSkin.modelId].sort(),
    'a map-scoped query must still expose that map project records',
  );
  assert.deepEqual(
    listModels({ mapId: 2002 }),
    [],
    'map-scoped records must not leak into another map',
  );

  console.log('VOXA model library scope regression passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
