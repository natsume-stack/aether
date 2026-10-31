import assert from 'node:assert/strict';
import { vec3 } from 'gl-matrix';
import {
  AssetEntry,
  AssetType,
} from '@box/schema/project/project-rda';
import { appendProjectAssetRecovery } from '../src/client/edit/state-controller/project-asset-trash';

for (const type of [AssetType.AUDIO, AssetType.PICTURE]) {
  const asset: AssetEntry = {
    ownerId: 0,
    contentId: 42,
    hash: `hash-${type}`,
    previewImage: `preview-${type}`,
    type,
    size: 1234,
    bounds: vec3.create(),
    animated: false,
  };
  const recovered: Record<string, unknown> = {};
  const transaction = {
    push(callback: (action: any) => unknown) {
      callback({
        deleteAssets: {
          splice() {
            // Reproduce MuRDA list removal: the removed value is freed in-place.
            asset.hash = '';
            asset.previewImage = '';
            asset.size = 0;
          },
        },
        audioAssets: { set: (_name: string, value: unknown) => (recovered.audio = value) },
        pictureAssets: { set: (_name: string, value: unknown) => (recovered.picture = value) },
        assets: { set: (_name: string, value: unknown) => (recovered.asset = value) },
      });
      return this;
    },
    commit() {},
  };

  appendProjectAssetRecovery(transaction, 0, 'restored', asset);
  const value = (type === AssetType.AUDIO ? recovered.audio : recovered.picture) as {
    hash: string;
    previewImage: string;
    size: number;
  };
  assert.equal(value.hash, `hash-${type}`);
  assert.equal(value.previewImage, `preview-${type}`);
  assert.equal(value.size, 1234);
}

console.log('project audio/picture trash recovery regression passed');
