import assert from 'node:assert/strict';

import { shouldSaveAsMapModel } from '../apps/voxa/src/models/project/save-target';
import { matchesMapFilter } from '../apps/voxa/server/local-voxa-store';

assert.equal(
    shouldSaveAsMapModel(0, true),
    true,
    '嵌入创作端的本地地图 mapId=0 必须保存为地图模型',
);
assert.equal(shouldSaveAsMapModel(0, false), false, '独立打开 VOXA 时不应把模型绑定到地图');
assert.equal(shouldSaveAsMapModel(123, true), true, '非零地图 ID 仍应保存为地图模型');
assert.equal(
    matchesMapFilter({ modelType: 2 }, 0),
    true,
    '升级前未写入 mapId 的地图模型必须继续显示',
);
assert.equal(matchesMapFilter({ modelType: 2 }, 8), false, '旧模型不能被错误关联到非零地图');

console.log('Local VOXA map linkage check passed.');
