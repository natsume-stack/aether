import { vec3 } from 'gl-matrix';
import { store } from '../../../redux/store';
import { forEachAdjacent } from '../../../utils/forEachAdjacent';
import { traverseVoxels } from '@box/utils/helper';
import type { Model } from '../../voxel-model/model';
import { isEmptyVoxel } from '../util';
import { BasicTool } from './base';

/**
 * 填充的类型。
 * adjacent 仅填充相连的体素
 * all 填充所有体素
 */
type FillType = 'adjacent' | 'all';

const OUT = {
  lo: vec3.create(),
  hi: vec3.create(),
};

/**
 * 油漆桶工具
 */
export class PaintBucket extends BasicTool {
  protected ignoreMode = true;

  /**
   * 根据当前Pointer选中的体素点，更新所有相同体素点的texture为当前色板的texture
   * @params type ‘adjacent’ 仅填充相连的体素; ‘all’ 填充所有体素。
   */
  public fill(params: {
    type: FillType;
    voxelPos: vec3;
    selectionTextureId: number;
    destinationTextureId: number;
  }) {
    const { type, selectionTextureId, destinationTextureId, voxelPos } = params;

    let model: Model;
    let pickedTextureId = 0;

    if (!isEmptyVoxel(selectionTextureId)) {
      model = this.modelsDict.selection;

      pickedTextureId = selectionTextureId;
    } else if (!isEmptyVoxel(destinationTextureId)) {
      model = this.modelsDict.destination;

      pickedTextureId = destinationTextureId;
    } else {
      return;
    }

    const dimension = model.voxels.getDimension();

    const newTextureId = store.getState().palette.selectedId;

    if (pickedTextureId === newTextureId) {
      return;
    }

    let modelChanged = false;

    if (type === 'all') {
      traverseVoxels(
        model.voxels,
        [0, 0, 0],
        dimension,
        (x, y, z, textureId, index) => {
          if (textureId !== pickedTextureId) {
            return;
          }
          modelChanged = true;

          model.voxels.data[index] = newTextureId;
        },
      );
    } else {
      forEachAdjacent({
        out: OUT,
        voxelView: model.voxels,
        startPos: voxelPos,
        axis: [1, 1, 1],
        onVoxel({ pos: [x, y, z] }) {
          const textureId = model.voxels.getVoxel(x, y, z);

          if (textureId !== pickedTextureId) {
            return false;
          }

          modelChanged = true;

          model.voxels.setVoxel(x, y, z, newTextureId);

          return true;
        },
        minimum: [0, 0, 0],
        maximum: dimension,
      });
    }

    if (!modelChanged) {
      return;
    }

    model.bakeData();

    this.saveHistory();
  }
}
