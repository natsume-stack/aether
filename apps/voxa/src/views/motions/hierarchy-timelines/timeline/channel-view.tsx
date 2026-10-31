import { useContext, useMemo } from 'react';
import { Icon } from '@box/box-design';
import type { InterpolationType } from '../../../../redux/animator-slice';
import { timeToFrame } from '../../../../models/animator-app/util';
import { INTERPOLATION_TO_ICON } from '../../../const';
import { TimelineContext } from '../context';
import styles from './channel.module.scss';
import { useItemHandlers } from './util';
import { HIDE_INTERPOLATION } from '../const';

type ChannelViewProp = {
  ids: [string, string];
  timeList: [number, number];
  nodeId: string;
  interpolation: InterpolationType;
  selected: boolean;
};

export function ChannelView(props: ChannelViewProp) {
  const { ids, timeList, nodeId, interpolation, selected } = props;

  const { keyframe } = useContext(TimelineContext);

  const [startFrame, endFrame] = useMemo(
    () => timeList.map(timeToFrame),
    [timeList],
  );
  const diff = endFrame - startFrame;

  const left = startFrame * keyframe.gap;
  const width = diff * keyframe.gap + 1;

  const { onMouseDown, onMouseMove, onClick } = useItemHandlers(
    nodeId,
    ids,
    selected,
  );

  const className = useMemo(() => {
    const name = [styles.channel];

    if (selected) {
      name.push(styles.selected);
    }

    return name.join(' ');
  }, [selected]);
  return (
    <div
      className={className}
      style={{ width, left }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onClick={onClick}
    >
      {width >= HIDE_INTERPOLATION && (
        <Icon symbolId={INTERPOLATION_TO_ICON[interpolation]} />
      )}
    </div>
  );
}
