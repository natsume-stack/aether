import { useContext, useMemo } from 'react';
import { timeToFrame } from '../../../../models/animator-app/util';
import { useAppSelector } from '../../../../redux/store';
import { TimelineContext } from '../context';
import styles from './keyframe.module.scss';
import { useItemHandlers } from './util';

type KeyframeViewProps = {
  id: string;
  /**
   * 关键帧的时间节点
   */
  time: number;
  /**
   * 关键帧所属的节点id
   */
  nodeId: string;
  /**
   * 关键帧当前是否被选中
   */
  selected: boolean;
};

/**
 * 关键帧组件
 */
export function KeyframeView(props: KeyframeViewProps) {
  const { id, time: keyframeTime, nodeId, selected } = props;

  const { keyframe } = useContext(TimelineContext);

  const { gap } = keyframe;

  const ids = useMemo(() => [id], [id]);

  const frame = useMemo(() => timeToFrame(keyframeTime), [keyframeTime]);

  const left = gap * frame;

  const { currentTime } = useAppSelector(({ app }) => {
    return {
      currentTime: app.motionPanel.currentTime,
    };
  });

  // 游标是否停在当前时间
  const isMatchingTime = currentTime === keyframeTime;

  const className = useMemo(() => {
    const list = [styles.keyframe];

    if (selected) {
      list.push(styles.selected);
    } else if (isMatchingTime) {
      list.push(styles.matchingTime);
    }

    return list.join(' ');
  }, [isMatchingTime, selected]);

  const { onMouseDown, onMouseMove, onClick } = useItemHandlers(
    nodeId,
    ids,
    selected,
  );

  return (
    <div className={className} style={{ left }}>
      <div
        className={styles.shape}
        style={{
          width: keyframe.width,
          transform: `translateX(-${keyframe.offsetLeft}px)`,
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onClick={onClick}
      />
    </div>
  );
}
