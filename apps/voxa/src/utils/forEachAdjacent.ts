import { vec3 } from 'gl-matrix';
import type { VoxelView } from '@box/utils/voxel';
import { inRange } from '@box/utils/helper';
import { isEmptyVoxel } from '../models/editing/util';

export type onVoxelParams = {
  pos: vec3;
  index: number;
  textureId: number;
};

/**
 * 从指定体素点开始，遍历相邻的体素点
 * @param params
 */
export function forEachAdjacent(params: {
  /**
   * 遍历结束后，返回最低点与最高点
   */
  out: {
    lo: vec3;
    hi: vec3;
  };
  /**
   * 执行遍历的体素视图
   */
  voxelView: VoxelView;
  /**
   * 遍历起始位置
   */
  startPos: vec3;
  /**
   * 沿着某个轴方向遍历
   */
  axis: vec3;
  /**
   * 方向向量。如果传入，会测试体素点在该方向上，是否被遮挡。
   */
  hitNormal?: vec3;
  /**
   * 遍历的回调。返回值决定是否沿着该点继续遍历。
   */
  onVoxel: (params: onVoxelParams) => boolean;
  /**
   * 遍历的最小值
   * @default [0, 0, 0]
   */
  minimum?: vec3;
  /**
   * 遍历的最大值
   * @default voxelView.getDimension()
   */
  maximum?: vec3;
}) {
  const {
    out,
    voxelView,
    startPos,
    onVoxel,
    axis,
    hitNormal,
    minimum = MINIMUM,
    maximum = vec3.clone(voxelView.getDimension()),
  } = params;

  const { lo, hi } = out;

  const queue: vec3[] = [startPos];

  let cache: Record<string, boolean> = {};

  const getPositions = extend(axis);

  while (queue.length) {
    const pos = queue.pop();

    if (!pos) {
      continue;
    }

    const [x, y, z] = pos;

    const key = `${x}-${y}-${z}`;

    if (cache[key]) {
      continue;
    }

    cache[key] = true;

    if (!inRange(pos, minimum, maximum)) {
      continue;
    }

    if (
      hitNormal &&
      hasUpperVoxel({
        hitNormal,
        pos,
        min: minimum,
        max: maximum,
        voxelView,
      })
    ) {
      continue;
    }

    const index = voxelView.index(x, y, z);

    const textureId = voxelView.data[index];

    const res = onVoxel({ pos, index, textureId });

    if (!res) {
      continue;
    }

    vec3.min(lo, lo, pos);
    vec3.max(hi, hi, pos);

    const positions = getPositions(pos);

    queue.push(...positions);
  }
}

const MINIMUM: vec3 = [0, 0, 0];

/**
 * 生成一个沿着指定轴方向的扩展的函数
 */
function extend(axis: vec3): (pos: vec3) => vec3[] {
  const [x, y, z] = axis;

  let extendX: ((pos: vec3) => vec3[]) | undefined = undefined;
  let extendY: ((pos: vec3) => vec3[]) | undefined = undefined;
  let extendZ: ((pos: vec3) => vec3[]) | undefined = undefined;

  if (x !== 0) {
    extendX = (pos: vec3) => [
      [pos[0] + 1, pos[1], pos[2]],
      [pos[0] - 1, pos[1], pos[2]],
    ];
  }

  if (y !== 0) {
    extendY = (pos: vec3) => [
      [pos[0], pos[1] + 1, pos[2]],
      [pos[0], pos[1] - 1, pos[2]],
    ];
  }

  if (z !== 0) {
    extendZ = (pos: vec3) => [
      [pos[0], pos[1], pos[2] + 1],
      [pos[0], pos[1], pos[2] - 1],
    ];
  }

  return (pos: vec3) => {
    const result: vec3[] = [];

    if (extendX) {
      result.push(...extendX(pos));
    }

    if (extendY) {
      result.push(...extendY(pos));
    }

    if (extendZ) {
      result.push(...extendZ(pos));
    }

    return result;
  };
}

const UPPER_VOXEL = vec3.create();

/**
 * 检测体素点叠加方向向量后，是否还存在体素。
 */
function hasUpperVoxel(params: {
  hitNormal: vec3;
  pos: vec3;
  min: vec3;
  max: vec3;
  voxelView: VoxelView;
}): boolean {
  const { hitNormal, pos, min, max, voxelView } = params;

  vec3.add(UPPER_VOXEL, pos, hitNormal);

  const [ux, uy, uz] = UPPER_VOXEL;

  return (
    inRange(UPPER_VOXEL, min, max) &&
    !isEmptyVoxel(voxelView.getVoxel(ux, uy, uz))
  );
}
