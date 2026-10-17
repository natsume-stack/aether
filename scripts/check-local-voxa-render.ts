import assert from 'node:assert/strict';

import { unpackMeshData } from '../packages/mesher/build';
import { getModelMetaData, migrateModel } from '../packages/voxa-project/build';

const modelHash = process.argv[2];
const creatorURL = process.argv[3] || 'http://127.0.0.1:3002';

assert.match(modelHash || '', /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/, '请提供要验证的模型哈希');

async function retrieve(hash:string) {
    const response = await fetch(`${creatorURL}/runtime/edit/block/${hash}`);
    assert.equal(response.status, 200, `创作端无法读取资源 ${hash}`);
    return new Uint8Array(await response.arrayBuffer());
}

async function main() {
    const metadataBytes = await retrieve(modelHash);
    const metadata = getModelMetaData(modelHash, metadataBytes);
    assert.ok(metadata, '引擎无法解析模型元数据');

    const modelBytes = await retrieve(metadata.dataHash);
    const model = await migrateModel(modelBytes);
    assert.ok(model, '引擎无法解析模型体素数据');
    assert.ok(model.meshes.length > 0, '模型没有可渲染网格');

    let vertexCount = 0;
    for (const mesh of model.meshes) {
        vertexCount += unpackMeshData(mesh, Uint8Array, Uint8Array).count;
    }
    assert.ok(vertexCount > 0, '模型网格的顶点数为 0');

    console.log(
        `Local VOXA render check passed: ${model.meshes.length} meshes, ${vertexCount} vertices.`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
