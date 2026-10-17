import type { defaultMotions } from './defs';
import type {
  IKRig,
  IKPose,
  IKPoints,
  IKConfiguration,
  IKPalette,
} from '@box/schema/animation/ik-schema';

export { IKRig, IKPose, IKPoints, IKConfiguration, IKPalette };

/**
 * avatar工具使用的IKState数据
 * 跟地图中IKStateSchema的区别是没有其他业务动画buff叠加的数据，比如蹲下，推墙，呼吸等等
 * 只提取了只播放一个动作的时候需要的通用数据
 */
export interface AvatarIKState {
  groundEmotePhase: number;
  jitterPhase: number;
  breathPhase: number;
  pose: IKPose;
  points: IKPoints;
  configuration: IKConfiguration;
}
