import assert from 'node:assert/strict';
import { ExtraProjectInfoSchema } from '@box/schema/project/hot-schema';
import { summarizeExtraProjectChange } from '../src/client/edit/replica/extra-project-change';

const previous = ExtraProjectInfoSchema.clone(ExtraProjectInfoSchema.identity);
previous.scriptAssets.shared = {
  id: 'shared',
  name: 'shared.js',
  hash: 'old',
  isClient: false,
  isShare: true,
  order: 0,
  lockedMapTitle: '',
  lockedMapId: 0,
};
const next = ExtraProjectInfoSchema.clone(previous);
delete next.scriptAssets.shared;
next.meshAssets['mesh/new.vb'] = {
  modelId: 1,
  hash: 'model',
  modelPreviewHash: '',
  animated: false,
  updatedAt: '',
};

const change = summarizeExtraProjectChange(previous, next);
assert.equal(change.scripts.removed, 1);
assert.equal(change.models.added, 1);
assert.equal(change.skins.added, 0);
console.log('extra-project live-sync change summary regression passed');
