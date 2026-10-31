import type {
  modelV7,
  projectV10 as currentProject,
  Vec3Schema,
  Vec4Schema,
  ModelMetaData,
  OutputSchema,
  SamplerSchema,
  MotionMetaData,
} from '@box/voxa-project';
import type { Mesher } from '@box/mesher';
import type { ModelResp, ModelType } from '@box/apis';
import type { SaveErrorType } from './defs';
import type { SerializedVec3 } from '../../utils/math';
import type { HierarchyNode } from '../../redux/animator-slice';

export type { VoxelDimension as VoxelDimensionType } from '@box/voxa-project';
export type ModelData = modelV7.ModelDataV7;
export { ModelMetaData, MotionMetaData };

export type ProjectData = currentProject.ProjectDataV10;

export type ProjectNodes = typeof currentProject.NodesSchema.identity;
export type ProjectNode = typeof currentProject.NodeSchema.identity;
export type ProjectVoxels = typeof currentProject.VoxelsSchema.identity;
export type ProjectVoxel = typeof currentProject.VoxelSchema.identity;
export type ProjectPaletteData =
  typeof currentProject.PaletteDataSchema.identity;
export type ProjectPaletteItems =
  typeof currentProject.PaletteItemsSchema.identity;
export type ProjectPaletteItem =
  typeof currentProject.PaletteItemSchema.identity;
export type ProjectAnimations =
  typeof currentProject.ProjectDataV10Schema.identity.animations;
export type ProjectAnimation =
  typeof currentProject.ProjectAnimationSchema.identity;
export type ProjectMotionNode =
  typeof currentProject.MotionNodesSchema.identity;
export type ProjectHitBox = typeof currentProject.HitBoxSchema.identity;
export type ProjectModelPivot = typeof currentProject.ModelPivotSchema.identity;

export type ModelNodes = typeof modelV7.ModelNodesSchema.identity;
export type ModelNode = typeof modelV7.ModelNodeSchema.identity;
export type ModelAnimations =
  typeof modelV7.ModelDataV7Schema.identity.animations;
export type ModelAnimation = typeof modelV7.AnimationSchema.identity;
export type ModelChannel = typeof modelV7.ChannelSchema.identity;

export type Vec4SchemaType = typeof Vec4Schema.identity;
export type Vec3SchemaType = typeof Vec3Schema.identity;
export type AnimationOutput = typeof OutputSchema.identity;
export type Sampler = typeof SamplerSchema.identity;

export type SaveResult =
  | {
      isSuccess: true;
      result: SaveSuccessResult;
    }
  | {
      isSuccess: false;
      result: SaveErrorResult;
    };

export interface SaveSuccessResult {
  /**
   * 模型返回值
   */
  modelResp: ModelResp;
  /**
   * 模型类型
   */
  modelType: ModelType;
  /**
   * 工程文件数据
   */
  projectData: ProjectData;

  /**
   * 模型文件数据
   */
  modelData?: ModelData;

  /**
   * 模型文件的meta data
   */
  modelMetaData?: ModelMetaData;
}

export interface SaveErrorResult {
  type: SaveErrorType;
}

export interface SaveProjectParams {
  /**
   * 是否为自动保存的类型
   */
  autoSave: boolean;
}

/**
 * 基础模型数据结构，可用于生成Voxa模型数据、GLTF数据等
 */
export interface BasicModelData
  extends Omit<ModelMetaData, 'version' | 'dataHash'> {
  /**
   * Mesher实例
   */
  mesher: Mesher;
  /**
   * 有效mesh个数
   */
  meshCount: number;
  /**
   * 颜色数组
   */
  paletteList: SerializedVec3[];
  /**
   * 发光数组
   */
  emissiveList: number[];
  /**
   * 模型节点数组
   */
  nodes: ModelNodes;
  /**
   * 列表节点数组，与模型节点数组一一对应
   */
  hierarchies: HierarchyNode[];
  /**
   * 模型动画数组
   */
  animations: ModelAnimations;
  /**
   * 外观框中心相对锚点的距离
   */
  renderBoxOffset: SerializedVec3;
}

/**
 * 以voxelId为key，解析出来对应的mesh的索引值，边界值等信息
 * 用于计算模型文件的物理边界和节点值
 */
export type MeshesIdDict = Record<
  string,
  {
    /**
     * 对应模型文件中meshes字段的索引值
     */
    index: number;
    /**
     * 模型去除空体素点后的长宽高
     */
    newBounds: SerializedVec3;
    /**
     * 模型去除空体素点后
     * 左下角体素起始点的位置
     */
    boundaryStart: SerializedVec3;
  }
>;
