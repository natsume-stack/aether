import assert from 'node:assert/strict';

import { getMeshPath } from '../internals/schema/project/hot-schema';
import { getLocalExtraProject } from '../services/game-server/src/project/project-extra';

const modelHash = process.argv[2];
const modelName = process.argv[3] || 'New-model';
const voxaURL = process.argv[4] || 'http://127.0.0.1:3001';

const logger = {
    info() {},
    error() {},
} as never;

function getLocalMeshPath(name:string, id:number) {
    return getMeshPath(`${name}__local_${id}`);
}

async function main() {
    const extra = await getLocalExtraProject(voxaURL, 0, logger);
    const assets = Object.values(extra.meshAssets).filter(
        (item) => item.hash === modelHash || !modelHash,
    );
    const asset = assets[0];
    assert.ok(asset, '当前地图的 extraProject 没有登记 VOXA 模型');
    assert.ok(asset.hash, 'extraProject 中的模型哈希为空');
    assert.ok(
        extra.meshAssets[getLocalMeshPath(modelName, asset.modelId)],
        '本地模型没有使用包含模型 ID 的唯一资源路径',
    );
    if (modelHash) {
        assert.equal(asset.hash, modelHash, 'extraProject 中的模型哈希不正确');
    }
    console.log('Local VOXA extra-project check passed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
