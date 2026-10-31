import { ReactNode, useMemo } from 'react';
import { useClassName } from '@box/box-design';
import { everyKeyframe } from '../../../../models/animator-app/util';
import type { MotionKeyframe } from '../../../../redux/animator-slice';
import { ChannelView } from './channel-view';
import { KeyframeView } from './keyframe-view';
import styles from './style.module.scss';
import { useAppSelector } from '../../../../redux/store';

/**
 * 单个时间轴
 */
export function Timeline(options: { nodeId: string; className: string }) {
  const { nodeId, className: optionClassName } = options;

  const { keyframes, selectedIds } = useAppSelector(({ animator }) => {
    const { activeMotionId, motionData, activeKeyframes } = animator;
    const motion = motionData.motions[activeMotionId];

    let keyframes: Record<string, MotionKeyframe> = {};

    if (motion) {
      const motionNode = motion.nodes[nodeId];

      if (motionNode) {
        keyframes = motionNode.keyframes;
      }
    }

    return {
      keyframes,
      selectedIds: activeKeyframes[nodeId] || [],
    };
  });

  const { keyframeNodes, channelNodes } = useMemo(() => {
    const keyframeNodes: ReactNode[] = [];
    const channelNodes: ReactNode[] = [];

    const idSet = new Set(selectedIds);

    everyKeyframe(0, keyframes, (keyframe) => {
      const keyframeSelected = idSet.has(keyframe.id);

      keyframeNodes.push(
        <KeyframeView
          key={keyframe.id}
          id={keyframe.id}
          time={keyframe.time}
          nodeId={nodeId}
          selected={keyframeSelected}
        />,
      );

      // 如果有nextTime，说明有帧段
      if (keyframe.nextTime !== undefined && keyframes[keyframe.nextTime]) {
        const nextKeyframe = keyframes[keyframe.nextTime];

        const channelSelected = keyframeSelected && idSet.has(nextKeyframe.id);

        channelNodes.push(
          <ChannelView
            key={keyframe.id}
            ids={[keyframe.id, nextKeyframe.id]}
            timeList={[keyframe.time, nextKeyframe.time]}
            nodeId={nodeId}
            selected={channelSelected}
            interpolation={keyframe.interpolation}
          />,
        );
      }

      return true;
    });

    return { keyframeNodes, channelNodes };
  }, [keyframes, nodeId, selectedIds]);

  const className = useClassName(
    [styles.timeline, optionClassName],
    [optionClassName],
  );

  return (
    <div className={className}>
      <div>{channelNodes}</div>
      <div>{keyframeNodes}</div>
    </div>
  );
}
