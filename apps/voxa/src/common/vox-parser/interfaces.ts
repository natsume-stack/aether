import type { mat3, vec3 } from 'gl-matrix';
import type { VoxelView } from '@box/utils/voxel';

/**
 * TODO .vox文件的类型应该在parseMagicaVoxel中返回。
 */
export interface VoxFile {
  /**
   * .vox文件的id。雀食在末尾有个空格。
   */
  'VOX ': number;
  /**
   * 一组（255）色板数据。
   * TODO 不确定是哪一组。有可能是第一组，也有可能是当前组。
   */
  'RGBA': (Rgba | null)[];
  /**
   * 材质相关。与RGBA对应。
   */
  'MATL'?: Material[];
  /**
   * 模型尺寸的数组。
   */
  'SIZE': Size[];
  /**
   * 模型的体素点信息数组。
   */
  'XYZI': VoxelPoint[][];
  /**
   * 节点群组数组
   * 单部件vox没有该字段
   */
  'nGRP'?: GroupNode[];
  /**
   * 记录对应的模型
   * 单部件vox没有该字段
   */
  'nSHP'?: ShapeNode[];
  /**
   * 记录旋转、位移等信息的节点。
   * 单部件vox没有该字段
   */
  'nTRN'?: TransformNode[];
}

export type Rgba = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type Size = {
  x: number;
  y: number;
  z: number;
};

export type VoxelPoint = {
  x: number;
  y: number;
  z: number;
  c: number;
};

export type GroupNode = {
  id: number;
  child_ids: number[];
  num_of_children: number;
  /**
   * 节点属性，空的。
   */
  attributes: {};
};

export type ShapeNode = {
  id: number;
  models: ShapeModel[];
  num_of_models: number;
  /**
   * 节点属性，空的。
   */
  attributes: {};
};

export type ShapeModelAttributes = {
  id: number;
  attributes: {
    /**
     * frame index, start from 0
     */
    _f: number;
  };
};

export type ShapeModel = {
  id: number;
  attributes: ShapeModelAttributes;
};

export type TransformNode = {
  id: number;
  attributes?: TransformAttributes;
  /**
   * TODO 为啥这又是驼峰规则
   */
  childId: number;
  frames: Frame[];
  numFrames: number;
};

export type TransformAttributes = {
  /**
   * 旋转
   */
  _name: string;
  _hidden: 0 | 1;
};

export type Frame = {
  /**
   * 形如`23 -17 20`的字符串.
   */
  _t?: string;
  /**
   * 旋转矩阵
   */
  _r?: mat3;
  /**
   * frame index, start from 0
   */
  _f?: number;
};

export type Material = {
  _type: '_diffuse' | '_metal' | '_glass' | '_emit';
  /**
   * 0 ~ 1
   */
  _weight: number;
  _rough: number;
  _spec: number;
  _ior: number;
  _att: number;
  _flux: number;
  _plastic: number;
};

export type VoxelInfo = {
  /**
   * 已旋转、已调整朝向、已裁剪的体素视图。
   */
  voxels: VoxelView;
  /**
   * 已旋转、已调整朝向，但未裁剪前的体素起点
   */
  boundaryStart: vec3;
  /**
   * 已旋转、已调整朝向，但未裁剪前的大小
   */
  originShape: vec3;
};

export type OnParseSingleVox = (params: {
  /**
   * nodeId
   * 随机生成，作为vox单部件的唯一标识符
   */
  nodeId: string;
  /**
   * 名字，可能没有
   */
  name?: string;
  /**
   * 父节点ID，父节点的nodeId
   * 如果为undefined说明是根节点
   */
  parentId?: string;
  /**
   * vox位移
   */
  position: vec3;
  /**
   * vox旋转矩阵
   * 如果有体素文件，则直接作用于体素旋转+翻转
   */
  rotation: mat3;
  /**
   * 如果是体素文件，有体素信息
   */
  voxelInfo?: VoxelInfo;
}) => void;

export type GetColorIdx = (oldColorIdx: number) => number;
