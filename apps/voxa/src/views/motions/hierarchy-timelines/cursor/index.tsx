import { useAppSelector } from '../../../../redux/store';
import { useContext, useMemo } from 'react';
import { TIMELINE_PADDING, TIME_CONTROLS_HEIGHT } from '../const';
import { TimelineContext } from '../context';
import styles from './style.module.scss';
import Cap from './cap.svg';
import { MotionsContext } from '../../context';

export function TimelineCursor() {
  const currentTime = useAppSelector(({ app }) => app.motionPanel.currentTime);
  const { height } = useContext(MotionsContext);
  const { secondWidth } = useContext(TimelineContext);

  const style = useMemo(
    () => ({
      left: currentTime * secondWidth + TIMELINE_PADDING,
      height: height - TIME_CONTROLS_HEIGHT,
    }),
    [currentTime, secondWidth, height],
  );

  return (
    <div className={styles.cursor} style={style}>
      <Cap />
      <div className={styles.pole} />
    </div>
  );
}
