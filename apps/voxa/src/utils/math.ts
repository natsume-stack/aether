import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import {
  Uint16Vec3Schema,
  Uint8Vec3Schema,
  VoxelDimension,
} from '../models/project/defs';
import { VoxelDimensionType } from '../models/project/interfaces';
import { MIN_VOXEL_SIZE } from '../defs';

export type SerializedVec3 = [number, number, number];

export type SerializedQuat = [number, number, number, number];

export type SerializedMat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type SerializedMat4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * 把glMatrix的quat转换成可序列化的数组
 */
export function serializeQuat(q: quat): SerializedQuat {
  const [x, y, z, w] = q;

  return [x, y, z, w];
}

type Vec3Type =
  | vec3
  | typeof Uint8Vec3Schema.identity
  | typeof Uint16Vec3Schema.identity;

/**
 * 把glMatrix的vec3转换成可序列化的数组
 */
export function serializeVec3(v: Vec3Type): SerializedVec3 {
  const [x, y, z] = v;

  return [x, y, z];
}

/**
 * 取绝对值
 */
export function absVec3(out: vec3, v: vec3) {
  vec3.set(out, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
}

export function radToDegree(rad: number) {
  return (rad * 180) / Math.PI;
}

export function degreeToRad(degree: number) {
  return (degree * Math.PI) / 180;
}

export function serializeMat4(m: mat4): SerializedMat4 {
  return Array.from(m) as SerializedMat4;
}

export function serializeMat3(m: mat3): SerializedMat3 {
  return Array.from(m) as SerializedMat3;
}

/**
 * 体素尺寸转为部件尺寸
 * 体素尺寸最小为1，当渲染维度为2D时，部件被压缩的维度尺寸要设置为0
 * @param shape
 * @param dimension
 * @returns
 */
export function voxelShapeToObjSize(
  shape: SerializedVec3,
  dimension: VoxelDimensionType,
) {
  if (dimension === VoxelDimension.XYZ) {
    return shape;
  }
  const size: SerializedVec3 = [shape[0], shape[1], shape[2]];
  size[dimension] = 0;
  return size;
}

/**
 * 部件尺寸转为体素尺寸，并获取渲染维度
 * 体素尺寸最小为1，当渲染维度为2D时，部件尺寸为0
 * 查找出渲染维度以及更改为体素尺寸
 * @param size
 * @returns
 */
export function ObjSizeToVoxelShape(size: SerializedVec3): {
  shape: SerializedVec3;
  dimension: VoxelDimensionType;
} {
  const dimension = size.indexOf(0);
  if (dimension < 0 || dimension > 2) {
    return {
      shape: size,
      dimension: VoxelDimension.XYZ,
    };
  }

  const shape: SerializedVec3 = [size[0], size[1], size[2]];
  vec3.max(shape, shape, [MIN_VOXEL_SIZE, MIN_VOXEL_SIZE, MIN_VOXEL_SIZE]);
  return {
    shape,
    dimension,
  };
}

/**
 * 摄像机三视图的角度
 * 0 - 看向yz面，侧视图
 * 1 - 看向xz面，俯视图
 * 2 - 看向xy面，正视图
 *
 * 俯视图数值有微小调整
 * 若取整数[0,1,0]，摄像机lookAt计算会因为eye和target的z轴数值相等，算出矩阵第0个元素为0
 * 从而导致quat算出NAN
 */
export const DIMENSION_CAMERA_DIR: SerializedVec3[] = [
  [1, 0, 0],
  [0, 0.99999, 0.00001],
  [0, 0, 1],
];
