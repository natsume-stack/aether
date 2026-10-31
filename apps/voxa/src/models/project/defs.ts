export {
  Uint16Vec3Schema,
  Uint8Vec3Schema,
  Vec3Schema,
  Vec4Schema,
  Mat3Schema,
  ChannelNodePath,
  SamplerSchema,
  ProjectNodeType,
  VoxelDimension,
  HitBoxMode,
} from '@box/voxa-project';

import { modelV7, skinV3, projectV10 } from '@box/voxa-project';

export const {
  ProjectDataV10Schema: ProjectDataSchema,
  PaletteItemSchema,
  PaletteGroupsSchema,
  NodeSchema,
  ProjectInterpolationType,
  ProjectAnimationSchema,
  KeyframeOffsetSchema,
  KeyframeSchema,
  KeyframeListSchema,
  MotionNodeSchema,
  MotionNodesSchema,
  HitBoxSchema,
  HitBoxDataSchema,
} = projectV10;

export const {
  ModelDataV7Schema: ModelDataSchema,
  ModelNodeSchema,
  ModelNodesSchema,
  AnimationSchema,
  ChannelSchema,
} = modelV7;

export const { BodyPartDataV3Schema: BodyPartDataSchema } = skinV3;

/**
 * 保存作品失败的type
 */
export enum SaveErrorType {
  /**
   * 离线
   */
  Offline = 'Offline',
  /**
   * 超时
   */
  Timeout = 'Timeout',
  /**
   * 生成保存数据时出错，比如预览图
   */
  GetDataError = 'GetDataError',
  /**
   * 未授权。无登录态或对id无修改权限。
   */
  Unauthorized = 'Unauthorized',

  /**
   * 名称重复
   */
  NameAlreadyExists = 'NameAlreadyExists',
  /**
   * 未知 / 未定义
   */
  Unknown = 'Unknown',
}

/**
 * 保存作品的超时时间
 */
export const SAVE_TIMEOUT = 30 * 1000;

/**
 * 加载作品的超时时间
 */
export const LOAD_TIMEOUT = 10 * 1000;
