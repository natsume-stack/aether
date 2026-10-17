import type { PayloadAction } from '@reduxjs/toolkit';
import { nanoid } from 'nanoid';
import { clamp, clone } from 'ramda';
import {
  everyNodeKeyframe,
  parseNodeKeyframeTimes,
} from '../../models/animator-app/motion-manager/util';
import {
  everyKeyframe,
  KEYFRAME_STEP,
  MAX_KEYFRAME_TIME,
  timeToFrame,
} from '../../models/animator-app/util';
import type { DropType } from '@box/box-design';
import type {
  AddMotionData,
  AnimatorState,
  MotionData,
  InterpolationType,
  MotionKeyframe,
  SetMotionNodesData,
  NodeKeyframeIds,
  Motion,
  MotionKeyframes,
  NodeKeyframes,
  MotionNode,
} from './state';

export function loadMotionsReducer(
  state: AnimatorState,
  action: PayloadAction<MotionData>,
): void {
  state.motionData = action.payload;
}

export function setActiveMotionIdReducer(
  state: AnimatorState,
  action: PayloadAction<string>,
): void {
  state.activeMotionId = action.payload;
}

export function addMotionReducer(
  state: AnimatorState,
  action: PayloadAction<AddMotionData>,
) {
  const { id, name } = action.payload;

  state.motionData.motionIds.unshift(id);
  state.motionData.motions[id] = {
    id,
    name,
    nodes: {},
  };
}

export function prependMotionsReducer(
  state: AnimatorState,
  action: PayloadAction<MotionData>,
) {
  const { motionIds, motions } = action.payload;

  state.motionData.motionIds.splice(0, 0, ...motionIds);
  Object.assign(state.motionData.motions, motions);
}

export type MoveMotionData = {
  /**
   * 被拖拽的动作id
   */
  id: string;
  /**
   * 拖拽到该目标的id
   */
  dropTargetId: string;
  dropType: DropType;
};

export function moveMotionReducer(
  state: AnimatorState,
  action: PayloadAction<MoveMotionData>,
) {
  const { motionIds } = state.motionData;
  const { id, dropTargetId, dropType } = action.payload;

  const idx = motionIds.indexOf(id);

  if (idx === -1) {
    return;
  }

  motionIds.splice(idx, 1);

  const dropIdx = motionIds.indexOf(dropTargetId);

  let spliceIdx = idx;

  if (dropIdx > -1) {
    spliceIdx = dropType === 'bottom' ? dropIdx + 1 : dropIdx;

    spliceIdx = clamp(0, motionIds.length, spliceIdx);
  }

  motionIds.splice(spliceIdx, 0, id);
}

export function setMotionNodesReducer(
  state: AnimatorState,
  action: PayloadAction<SetMotionNodesData>,
) {
  const { motionId, nodes } = action.payload;

  const { motions } = state.motionData;

  const motion = motions[motionId];

  if (!motion) {
    return;
  }

  nodes.forEach((node) => {
    motion.nodes[node.nodeId] = node;
  });
}

export function setActiveKeyframesReducer(
  state: AnimatorState,
  action: PayloadAction<NodeKeyframeIds>,
) {
  state.activeKeyframes = action.payload;
}

export function setKeyframesInterpolationReducer(
  state: AnimatorState,
  action: PayloadAction<{
    motionId: string;
    nodeKeyframeIds: NodeKeyframeIds;
    type: InterpolationType;
  }>,
) {
  const { motionId, nodeKeyframeIds, type } = action.payload;
  const motion = state.motionData.motions[motionId];

  if (!motion) {
    return;
  }

  const nodeKeyframes = parseNodeKeyframeTimes(motion.nodes, nodeKeyframeIds);

  Object.keys(nodeKeyframes).forEach((nodeId) => {
    if (!motion.nodes[nodeId]) {
      return;
    }

    const { keyframes } = motion.nodes[nodeId];

    nodeKeyframes[nodeId].forEach((keyframe) => {
      if (!keyframes[keyframe.time]) {
        return;
      }

      keyframes[keyframe.time].interpolation = type;
    });
  });
}

export function moveKeyframesReducer(
  state: AnimatorState,
  action: PayloadAction<{
    sourceMotion: Motion;
    sourceKeyframes: NodeKeyframes;
    offsetFrames: number;
  }>,
) {
  let { offsetFrames, sourceMotion, sourceKeyframes } = action.payload;

  Object.keys(sourceKeyframes).forEach((nodeId) => {
    const keyframeList = sourceKeyframes[nodeId];
    const node = sourceMotion.nodes[nodeId];

    if (!keyframeList || !node) {
      return;
    }

    const keyframes = clone(node.keyframes);

    keyframeList.forEach((keyframe) => {
      if (!keyframe || keyframe.time === 0) {
        return;
      }

      const newFrame = timeToFrame(keyframe.time) + offsetFrames;
      const newTime = clamp(0, MAX_KEYFRAME_TIME, newFrame * KEYFRAME_STEP);

      if (newTime === keyframe.time) {
        return;
      }

      removeKeyframe(keyframes, keyframe);

      const newKeyframe: MotionKeyframe = {
        time: newTime,
        id: keyframe.id,
        offset: keyframe.offset,
        interpolation: keyframe.interpolation,
      };

      upsertKeyframe(keyframes, newKeyframe);
    });

    state.motionData.motions[sourceMotion.id].nodes[nodeId].keyframes =
      keyframes;
  });
}

/**
 * 插入或者更新关键帧
 * @param out 会被更新的关键帧字典
 * @param keyframeData 关键帧数据
 * @returns
 */
function upsertKeyframe(
  out: MotionKeyframes,
  keyframeData: Omit<MotionKeyframe, 'nextTime' | 'prevTime'>,
) {
  const { override, insertBefore, insertAfter } = findUpsertTarget(
    keyframeData.time,
    out,
    0,
  );

  let newKeyframe: MotionKeyframe = keyframeData;

  if (override) {
    newKeyframe = {
      ...override,
      ...newKeyframe,
    };
  } else if (insertBefore) {
    newKeyframe = {
      ...keyframeData,
      prevTime: insertBefore.prevTime,
      nextTime: insertBefore.time,
    };

    if (insertBefore.prevTime !== undefined && out[insertBefore.prevTime]) {
      out[insertBefore.prevTime].nextTime = newKeyframe.time;
    }

    insertBefore.prevTime = keyframeData.time;
  } else if (insertAfter) {
    newKeyframe = {
      ...keyframeData,
      prevTime: insertAfter.time,
    };

    insertAfter.nextTime = newKeyframe.time;
  }

  out[newKeyframe.time] = newKeyframe;

  return newKeyframe;
}

/**
 * 新增关键帧时，查找如何处理，可能是在insertBefore前插入、在latest后新增
 * @param time 查找的时间点
 * @param keyframes
 * @returns 3个字段, override，覆盖该关键帧，insertBefore，在该关键帧前插入。insertAfter，在该关键帧之后新增
 */
function findUpsertTarget(
  time: number,
  keyframes: MotionKeyframes,
  searchTime: number,
) {
  let override: MotionKeyframe | undefined;
  let insertBefore: MotionKeyframe | undefined;
  let insertAfter: MotionKeyframe | undefined;

  if (keyframes[time]) {
    override = keyframes[time];
  } else {
    everyKeyframe(searchTime, keyframes, (keyframe) => {
      // 存在更后的时间点，在此时间点前插入
      if (keyframe.time > time) {
        insertBefore = keyframe;
        return false;
      }

      if (keyframe.nextTime === undefined) {
        insertAfter = keyframe;
      }

      return true;
    });
  }

  return { override, insertBefore, insertAfter };
}

/**
 * 删除关键帧
 */
function removeKeyframe(out: MotionKeyframes, keyframe: MotionKeyframe) {
  const { id, time } = keyframe;

  if (out[time] && out[time].id === id) {
    const { prevTime, nextTime } = out[time];

    if (prevTime !== undefined && out[prevTime]) {
      out[prevTime].nextTime = nextTime;
    }
    if (nextTime !== undefined && out[nextTime]) {
      out[nextTime].prevTime = prevTime;
    }

    delete out[time];
  }
}

export function removeKeyframesReducer(
  state: AnimatorState,
  action: PayloadAction<{
    motionId: string;
    nodeKeyframeIds: NodeKeyframeIds;
  }>,
) {
  const { motionId, nodeKeyframeIds } = action.payload;

  const nodes = state.motionData.motions[motionId]?.nodes;

  if (!nodes) {
    return;
  }

  everyNodeKeyframe(nodes, nodeKeyframeIds, (keyframe, nodeId) => {
    if (keyframe.time !== 0) {
      removeKeyframe(nodes[nodeId].keyframes, keyframe);
    }

    return true;
  });
}

export function upsertKeyframesReducer(
  state: AnimatorState,
  action: PayloadAction<{
    motionId: string;
    newNodeKeyframes: NodeKeyframes;
  }>,
) {
  const { motionId, newNodeKeyframes: nodeKeyframes } = action.payload;

  const nodes = state.motionData.motions[motionId]?.nodes;

  if (!nodes) {
    return;
  }

  Object.keys(nodeKeyframes).forEach((nodeId) => {
    const node = nodes[nodeId];

    if (!node) {
      return;
    }

    nodeKeyframes[nodeId].forEach((keyframe) => {
      upsertKeyframe(node.keyframes, keyframe);
    });
  });
}

export function removeMotionReducer(
  state: AnimatorState,
  action: PayloadAction<string>,
) {
  const motionId = action.payload;

  const { motionIds, motions } = state.motionData;

  const idx = motionIds.indexOf(motionId);

  motionIds.splice(idx, 1);

  if (motions[motionId]) {
    delete motions[motionId];
  }
}

export function copyMotionReducer(
  state: AnimatorState,
  action: PayloadAction<{
    sourceMotionId: string;
    newMotionId: string;
    newMotionName: string;
  }>,
) {
  const { sourceMotionId, newMotionId, newMotionName } = action.payload;

  const { motionIds, motions } = state.motionData;

  const sourceMotion = motions[sourceMotionId];
  const sourceIdx = motionIds.indexOf(sourceMotionId);

  if (sourceIdx < 0 || !sourceMotion) {
    return;
  }

  const newMotion: Motion = {
    id: newMotionId,
    name: newMotionName,
    nodes: {},
  };

  Object.keys(sourceMotion.nodes).forEach((nodeId) => {
    const motionNode = sourceMotion.nodes[nodeId];

    if (!motionNode) {
      return;
    }

    const newMotionNode: MotionNode = {
      nodeId,
      keyframes: {},
    };

    newMotion.nodes[nodeId] = newMotionNode;

    everyKeyframe(
      0,
      motionNode.keyframes,
      ({ time, nextTime, prevTime, interpolation, offset }) => {
        const newId = nanoid();

        newMotionNode.keyframes[time] = {
          id: newId,
          time: time,
          interpolation: interpolation,
          nextTime: nextTime,
          prevTime: prevTime,
          offset: {
            matrix: [...offset.matrix],
            alpha: offset.alpha,
          },
        };

        return true;
      },
    );
  });

  motions[newMotion.id] = newMotion;

  motionIds.splice(sourceIdx, 0, newMotion.id);
}

export function renameMotionReducer(
  state: AnimatorState,
  action: PayloadAction<{ motionId: string; newName: string }>,
) {
  const { motionId, newName } = action.payload;

  const motion = state.motionData.motions[motionId];

  if (!motion) {
    return;
  }

  motion.name = newName;
}

export function removeMotionsNodesReducer(
  state: AnimatorState,
  action: PayloadAction<string[]>,
) {
  const { motionIds, motions } = state.motionData;

  motionIds.forEach((motionId) => {
    const motion = motions[motionId];

    if (!motion) {
      return;
    }

    action.payload.forEach((nodeId) => {
      if (nodeId in motion.nodes) {
        delete motion.nodes[nodeId];
      }
    });
  });
}
