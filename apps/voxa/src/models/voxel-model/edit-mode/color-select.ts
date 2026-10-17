import { vec3 } from 'gl-matrix';
import { traverseVoxels } from '@box/utils/helper';
import { forEachAdjacent } from '../../../utils/forEachAdjacent';
import type { Pointer } from '../../pointer';
import type { Model } from '../model';

type ColorSelectParams = {
  out: { lo: vec3; hi: vec3 };
  textureId: number;
};

type Models = Record<'destination' | 'editing' | 'selection', Model>;

/**
 * TODO Move it to ediitng
 */
export class ColorSelectMode {
  private models: Models;
  private pointer: Pointer;

  constructor(options: { models: Models; pointer: Pointer }) {
    const { models, pointer } = options;

    this.models = models;
    this.pointer = pointer;
  }

  /**
   * 选中相邻且颜色相同的体素
   */
  public selectAdjacent(params: ColorSelectParams) {
    const { out, textureId: paramTextureId } = params;

    const { editing, destination, selection } = this.models;

    const hitPos = this.pointer.getVoxelPos();

    const dimension = editing.voxels.getDimension();

    /**
     * 从选中的体素点开始，遍历相邻的体素点，如果等于指定颜色，则执行选中。
     */
    forEachAdjacent({
      out,
      voxelView: destination.voxels,
      startPos: hitPos,
      axis: [1, 1, 1],
      onVoxel: ({ index, textureId }) => {
        if (textureId !== paramTextureId) {
          return false;
        }

        selection.voxels.data[index] = paramTextureId;
        destination.voxels.data[index] = 0;

        return true;
      },
      maximum: dimension,
    });
  }

  /**
   * 选中所有颜色相同的体素
   */
  public selectAll(params: ColorSelectParams) {
    const { textureId: selectedColor } = params;

    const { destination, selection } = this.models;

    const dimension = destination.voxels.getDimension();

    traverseVoxels(
      destination.voxels,
      [0, 0, 0],
      dimension,
      (i, j, k, d, ptr) => {
        if (d === selectedColor) {
          selection.voxels.data[ptr] = d;
          destination.voxels.data[ptr] = 0;
        }
      },
    );
  }
}
