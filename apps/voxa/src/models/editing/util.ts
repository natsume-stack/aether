import { vec3 } from 'gl-matrix';
import type { MirrorMode } from '../../redux/editing-slice';
import { boundary } from '@box/utils/helper';
import type { Camera } from '../rendering/camera/base';
import { DEFAULT_POS } from './const';
import { BoxBoundary } from './interfaces';
import type { Collection, Operation } from './mode/interfaces';

export function isEmptyCollection(collection: Collection) {
  return collection.length === 0;
}

export function isSingleCollection(collection: Collection) {
  return collection.length === 1;
}

export function isEmptyVoxel(textureId: number) {
  return textureId === 0;
}

export function isInvalidPosition(pos: vec3) {
  return vec3.exactEquals(pos, DEFAULT_POS);
}

const none = () => {};

/**
 * 合成镜像对称的Operation函数。
 */
export function composeSymmetryOperation(params: {
  /**
   * 镜像模式配置。
   */
  opts: Partial<MirrorMode>;
  /**
   * 模型维度
   */
  range: vec3;
  /**
   * 操作函数
   */
  operation: Operation;
}): Operation {
  const {
    opts,
    range: [rangeX, rangeY, rangeZ],
    operation,
  } = params;

  const { X = false, Y = false, Z = false } = opts;

  /**
   * 如果全都不启用，则直接返回原有operation。
   */
  if (!X && !Y && !Z) {
    return operation;
  }

  const addX = X
    ? (list: vec3[]) => {
        list.forEach(([x, y, z]) => {
          const newPos = vec3.fromValues(rangeX - x, y, z);

          operation({ pos: newPos });

          list.push(newPos);
        });
      }
    : none;

  const addY = Y
    ? (list: vec3[]) => {
        list.forEach(([x, y, z]) => {
          const newPos = vec3.fromValues(x, rangeY - y, z);

          operation({ pos: newPos });

          list.push(newPos);
        });
      }
    : none;

  const addZ = Z
    ? (list: vec3[]) => {
        list.forEach(([x, y, z]) => {
          const newPos = vec3.fromValues(x, y, rangeZ - z);

          operation({ pos: newPos });

          list.push(newPos);
        });
      }
    : none;

  return function ({ pos }) {
    operation({ pos });

    const list: vec3[] = [pos];

    addX(list);
    addY(list);
    addZ(list);
  };
}

/**
 * 根据镜像模式配置，计算所有镜像点。
 */
export function getSymmetryPoints(params: {
  /**
   * 计算的原点
   */
  point: vec3;
  /**
   * 模型的维度
   */
  range: vec3;
  /**
   * 镜像模式配置
   */
  opts: Partial<MirrorMode>;
}): vec3[] {
  const list: vec3[] = [];

  const { point, ...others } = params;

  const operation = composeSymmetryOperation({
    ...others,
    operation: ({ pos }) => {
      list.push(pos);
    },
  });

  operation({ pos: point });

  return list;
}

export function getSymmetryBoundaries(params: {
  /**
   * 计算对称的源boundary
   */
  boxBoundary: BoxBoundary;
  /**
   * 模型的维度
   */
  range: vec3;
  /**
   * 镜像模式配置
   */
  opts: Partial<MirrorMode>;
}) {
  const { boxBoundary, range, opts } = params;

  const { X = false, Y = false, Z = false } = opts;

  const [rangeX, rangeY, rangeZ] = range;
  const origin = vec3.fromValues(0, 0, 0);
  const result: BoxBoundary[] = [boxBoundary];

  X &&
    result.forEach(({ start, end }) => {
      result.push(
        boundary(
          [rangeX - start[0], start[1], start[2]],
          [rangeX - end[0], end[1], end[2]],
          origin,
          range,
        ),
      );
    });

  Y &&
    result.forEach(({ start, end }) => {
      result.push(
        boundary(
          [start[0], rangeY - start[1], start[2]],
          [end[0], rangeY - end[1], end[2]],
          origin,
          range,
        ),
      );
    });

  Z &&
    result.forEach(({ start, end }) => {
      result.push(
        boundary(
          [start[0], start[1], rangeZ - start[2]],
          [end[0], end[1], rangeZ - end[2]],
          origin,
          range,
        ),
      );
    });

  return result;
}

/**
 * 计算顶点在裁剪空间下的坐标
 */
export function vertexToClipPos(out: vec3, vertex: vec3, camera: Camera) {
  return vec3.transformMat4(out, vertex, camera.viewProjection);
}

/**
 * 传入两个坐标，生成长方体的各个顶点。
 */
export function getCubeVertices(start: vec3, end: vec3): vec3[] {
  return [
    [start[0], start[1], start[2]],
    [start[0], start[1], end[2]],
    [start[0], end[1], start[2]],
    [start[0], end[1], end[2]],
    [end[0], start[1], start[2]],
    [end[0], start[1], end[2]],
    [end[0], end[1], start[2]],
    [end[0], end[1], end[2]],
  ];
}
