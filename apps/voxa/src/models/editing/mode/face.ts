import { vec3 } from 'gl-matrix';
import { forEachAdjacent, onVoxelParams } from '../../../utils/forEachAdjacent';
import type { VoxelView } from '@box/utils/voxel';
import type { Operation } from './interfaces';

type ParseParams = {
  operation: Operation;
  voxelView: VoxelView;
  hitNormal: vec3;
  startPos: vec3;
  options: Options;
};

type Options =
  | {
      /**
       * 忽略体素区别，只要是同个平面都处理。
       * 双击填充平面时会使用。
       */
      type: 'ignoreTextureId';
    }
  | {
      /**
       * 需要区分体素，只有与hitTextureId相同才进行处理。
       */
      type: 'hitTextureId';
      hitTextureId: number;
    }
  | {
      /**
       * 忽略体素区别，只要是同个平面，且非空体素，都处理。
       */
      type: 'hasTextureId';
    };

const BOUNDARY = {
  lo: vec3.fromValues(0, 0, 0),
  hi: vec3.fromValues(0, 0, 0),
};

export class Face {
  public parse({
    hitNormal,
    voxelView,
    operation,
    startPos,
    options,
  }: ParseParams) {
    const toContinue = this.getCondition(options, startPos);

    const axis = this.getAdjacentAxis(hitNormal);

    forEachAdjacent({
      out: BOUNDARY,
      voxelView,
      startPos,
      axis,
      hitNormal,
      onVoxel: (params) => {
        if (!toContinue(params)) {
          return false;
        }

        const { pos } = params;

        operation({ pos });

        return true;
      },
    });
  }

  private getCondition(
    options: Options,
    startPos: vec3,
  ): (params: onVoxelParams) => boolean {
    switch (options.type) {
      case 'ignoreTextureId':
        return () => true;
      case 'hitTextureId':
        return ({ textureId, pos }) =>
          textureId === options.hitTextureId || vec3.exactEquals(pos, startPos);
      case 'hasTextureId':
        return ({ textureId }) => textureId !== -1;
    }
  }

  /**
   * 计算出与hitNormal垂直的方向。
   * 用于遍历同一个面的体素点。
   */
  private getAdjacentAxis(hitNormal: vec3): vec3 {
    const [nx, ny, nz] = hitNormal;

    return [nx === 0 ? 1 : 0, ny === 0 ? 1 : 0, nz === 0 ? 1 : 0];
  }
}
