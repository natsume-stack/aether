import { mat4 } from 'gl-matrix';
import {
  HierarchyData,
  MotionKeyframe,
  MotionKeyframes,
  MotionNode,
  MotionNodes,
  NodeKeyframeIds,
  NodeKeyframes,
} from '../../../redux/animator-slice';
import { ProjectInterpolationType, ProjectNodeType } from '../../project/defs';
import {
  everyKeyframe,
  getNodeDescendants,
  KEYFRAME_STEP,
  timeToFrame,
} from '../util';
import { ROOT_BONE_ID } from '../../../defs';

/**
 * 关键帧的默认补帧方式
 */
export const DEFAULT_INTERPOLATION = ProjectInterpolationType.Linear;

/**
 * 查询指定关键帧的前后关键帧
 * @param keyframe
 * @param keyframes
 */
export function searchRelativeKeyframes(
  keyframe: MotionKeyframe,
  keyframes: MotionKeyframes,
): {
  /**
   * 上一个关键帧
   */
  prevKeyframe?: MotionKeyframe;
  /**
   * 下一个关键帧
   */
  nextKeyframe?: MotionKeyframe;
} {
  const { prevTime, nextTime } = keyframe;

  let prevKeyframe: MotionKeyframe | undefined;
  let nextKeyframe: MotionKeyframe | undefined;

  if (prevTime !== undefined) {
    prevKeyframe = keyframes[prevTime];
  }

  if (nextTime !== undefined) {
    nextKeyframe = keyframes[nextTime];
  }

  return { nextKeyframe, prevKeyframe };
}

/**
 * 根据关键帧id字典遍历关键帧
 * @param nodeKeyframeIds 关键帧id字典
 * @param callback 回调函数，参数为关键帧的id，关键帧所属的节点id。返回值决定是否继续遍历。
 */
export function everyNodeKeyframe(
  nodes: MotionNodes,
  nodeKeyframeIds: NodeKeyframeIds,
  callback: (keyframe: MotionKeyframe, nodeId: string) => boolean,
) {
  Object.keys(nodeKeyframeIds).every((nodeId) => {
    let idList = nodeKeyframeIds[nodeId];
    const node = nodes[nodeId];

    if (!idList || idList.length === 0 || !node) {
      return true;
    }

    idList = idList.slice();

    let toContinue = true;

    everyKeyframe(0, node.keyframes, (keyframe) => {
      const index = idList.indexOf(keyframe.id);

      if (index > -1) {
        idList.splice(index, 1);

        toContinue = callback(keyframe, nodeId);

        if (!toContinue || idList.length === 0) {
          return false;
        }
      }

      return true;
    });

    return toContinue;
  });
}

/**
 * 根据关键帧id字典解析出关键帧字典
 */
export function parseNodeKeyframeTimes(
  nodes: Record<string, MotionNode>,
  nodeKeyframeIds: NodeKeyframeIds,
): NodeKeyframes {
  const res: NodeKeyframes = {};

  everyNodeKeyframe(nodes, nodeKeyframeIds, (keyframe, nodeId) => {
    if (!res[nodeId]) {
      res[nodeId] = [];
    }

    res[nodeId].push(keyframe);

    return true;
  });

  return res;
}

export function isEmptyNodeDict<T>(nodeKeyframeIds: Record<string, T[]>) {
  return !Object.keys(nodeKeyframeIds).some(
    (nodeId) => nodeKeyframeIds[nodeId] && nodeKeyframeIds[nodeId].length > 0,
  );
}

/**
 * 把关键帧的时间（time），转换为关键帧帧数，计算偏移后的结果。
 * 避免直接计算时间偏移会因小数计算而产生细微不一致的结果。
 * @param keyframeTime 关键帧原本的时间
 * @param offsetFrames 关键帧偏移数量
 */
export function calculateNewKeyframeTime(
  keyframeTime: number,
  offsetFrames: number,
) {
  const newFrame = timeToFrame(keyframeTime) + offsetFrames;

  return newFrame * KEYFRAME_STEP;
}

/**
 * 查找指定时间的上一个关键帧的时间点
 * @param time 指定时间
 * @param keyframes 关键帧字典
 * @returns 上一个关键帧的时间点，如果是undefined，表示没有找到
 */
export function findPrevKeyframeTime(time: number, keyframes: MotionKeyframes) {
  let target: number | undefined;

  everyKeyframe(0, keyframes, ({ time: keyframeTime }) => {
    if (keyframeTime < time) {
      target = keyframeTime;

      return true;
    }

    return false;
  });

  return target;
}

/**
 * 查找指定时间的下一个关键帧的时间点
 * @param time 指定时间
 * @param keyframes 关键帧字典
 * @returns 下一个关键帧的时间点，如果是undefined，表示没有找到
 */
export function findNextKeyframeTime(time: number, keyframes: MotionKeyframes) {
  let target: number | undefined;

  everyKeyframe(0, keyframes, ({ time: keyframeTime }) => {
    if (keyframeTime > time) {
      target = keyframeTime;

      return false;
    }

    return true;
  });

  return target;
}

/**
 * 查找最后一个关键帧的时间点
 * @param keyframes 关键帧字典
 * @returns 最后一个关键帧的时间点，如果是undefined，表示没有找到
 */
export function findLastKeyframeTime(keyframes: MotionKeyframes) {
  let target: number | undefined;

  everyKeyframe(0, keyframes, ({ time: keyframeTime, nextTime }) => {
    if (nextTime === undefined) {
      target = keyframeTime;
      return false;
    }

    return true;
  });

  return target;
}

const IDENTITY_MAT = mat4.create();

/**
 * 判断动作节点是否是空，可在保存作品时，判断是否需要存入该节点的数据
 * 空需要满足一下条件
 * - 没有关键帧或仅有第0帧
 * - 第0帧无偏移
 *
 * 如果是用于ProjectData的判断，还需要考虑以下条件
 * - 第0帧的补帧方式为默认补帧方式
 *
 * @param motionNode 要判断的动作节点
 * @param diffInterpolation 是否判断补帧方式，用于ProjectData判断时传入true
 */
export function isEmptyMotionNode(
  motionNode: MotionNode,
  diffInterpolation: boolean,
) {
  const firstKeyframe = motionNode.keyframes[0];

  if (!firstKeyframe) {
    return true;
  }

  const { nextTime, offset, interpolation } = firstKeyframe;

  if (nextTime !== undefined) {
    return false;
  }

  if (diffInterpolation && interpolation !== DEFAULT_INTERPOLATION) {
    return false;
  }

  const { matrix, alpha } = offset;

  return alpha === 0 && mat4.equals(matrix, IDENTITY_MAT);
}

/**
 * Motion需要查询当前选中或关联的骨骼，如果都没有则查询全部骨骼
 */
export function getMotionBoneIds(
  activeIds: string[],
  relativeIds: string[],
  hierarchyData: HierarchyData,
) {
  let boneIds: string[] = [];
  const activeBoneIds: string[] = [];

  activeIds.forEach((id) => {
    if (hierarchyData[id] && hierarchyData[id].type === ProjectNodeType.Bone) {
      boneIds.push(id);
      activeBoneIds.push(id);
    }
  });

  boneIds = boneIds.concat(relativeIds);

  if (boneIds.length === 0) {
    boneIds = getNodeDescendants(ROOT_BONE_ID);
  }

  return { boneIds, activeBoneIds };
}
