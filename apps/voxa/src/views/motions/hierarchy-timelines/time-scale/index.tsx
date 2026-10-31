import React, { memo, ReactNode, useContext, useMemo, useRef } from 'react';
import {
  KEYFRAME_PER_SEC,
  MAX_KEYFRAME_TIME,
} from '../../../../models/animator-app/util';
import { SKIP_TIME_WIDTH } from '../const';
import styles from './style.module.scss';
import { nanoid } from 'nanoid';
import { TimelineContext } from '../context';
import { TimelineCursor } from '../cursor';
import { useResizeObserver } from '../../../hooks';

/**
 * 时间刻度
 */
function TimeScaleView(props: {
  onMouseDown: (evt: React.MouseEvent) => void;
  onResize: () => void;
}) {
  const { onMouseDown, onResize } = props;
  const { secondWidth } = useContext(TimelineContext);

  const secondIds = useMemo(() => {
    const ids: string[] = [];

    for (let i = 0; i < 60; i++) {
      ids.push(nanoid());
    }

    return ids;
  }, []);

  const seconds = useMemo(() => {
    const seconds: ReactNode[] = [];

    let frameNum = KEYFRAME_PER_SEC;

    while (secondWidth / frameNum < 4) {
      const newFrameNum = Math.ceil(frameNum / 2);

      if (newFrameNum < 1 || newFrameNum === frameNum) {
        break;
      }

      frameNum = newFrameNum;
    }

    const skipTime = secondWidth < SKIP_TIME_WIDTH;

    for (let i = 0; i < MAX_KEYFRAME_TIME; i++) {
      const value = [i];
      let width = secondWidth;

      if (i === MAX_KEYFRAME_TIME - 1) {
        value.push(i + 1);
        width += 1;
      }

      seconds.push(
        <Second
          key={secondIds[i]}
          width={width}
          value={value}
          frameNum={frameNum}
          hideFirstValue={skipTime && i % 2 === 1}
        />,
      );
    }

    return seconds;
  }, [secondIds, secondWidth]);

  const ref = useRef<HTMLDivElement>(null);

  useResizeObserver(ref.current, onResize);

  return (
    <div ref={ref} className={styles.timeScale} onMouseDown={onMouseDown}>
      {seconds}
      <TimelineCursor />
    </div>
  );
}

export const TimeScale = memo(TimeScaleView);

/**
 * 绘制每一秒的刻度、刻度值
 */
function SecondView(options: {
  /**
   * 每秒的宽度
   */
  width: number;
  /**
   * 每秒绘制的帧数
   */
  frameNum: number;
  /**
   * 刻度值数组，第一位会作为起始的刻度值，第二位作为结束的刻度值。
   * 只有最后一秒会绘制结束的刻度值。
   */
  value: number[];
  /**
   * 是否隐藏第一位刻度值。当每秒的宽度太小时，要跳秒显示。
   */
  hideFirstValue: boolean;
}) {
  const { width, value = [], frameNum, hideFirstValue } = options;

  const marks: ReactNode[] = [];

  const [firstValue, lastValue] = value;

  const markNum = lastValue === undefined ? frameNum : frameNum + 1;

  // 如果没有最后一个刻度值，需要用刻度之间的间距填充右侧，由于刻度值本身占1px，所以减去1px后再均分
  let paddingRight = lastValue === undefined ? (width - markNum) / frameNum : 0;

  const highlightIdx = frameNum % 2 === 0 ? frameNum / 2 : -1;

  for (let i = 0; i < markNum; i++) {
    if (i === 0) {
      marks.push(
        <Mark
          key={`firstValue-${i}`}
          highlight={false}
          value={hideFirstValue ? undefined : firstValue}
          isValue={true}
        />,
      );

      continue;
    }
    if (i === markNum - 1 && value[1]) {
      marks.push(
        <Mark
          key={`lastValue-${i}`}
          highlight={false}
          value={lastValue}
          isValue={true}
        />,
      );

      break;
    }

    marks.push(<Mark key={i} highlight={i === highlightIdx} isValue={false} />);
  }

  return (
    <div className={styles.second} style={{ width, paddingRight }}>
      {marks}
    </div>
  );
}

const Second = memo(SecondView);

/**
 * 刻度
 */
function MarkView(options: {
  highlight: boolean;
  isValue: boolean;
  value?: number;
}) {
  const { highlight, value: scaleValue, isValue: isScaleValue } = options;

  const className = useMemo(() => {
    const names = [styles.mark];

    if (isScaleValue) {
      names.push(styles.scaleValue);
    } else if (highlight) {
      names.push(styles.highlight);
    }

    return names.join(' ');
  }, [highlight, isScaleValue]);

  const value = scaleValue !== undefined ? `${scaleValue}s` : undefined;

  return (
    <div className={className}>
      {value && <span className={styles.value}>{value}</span>}
      <span className={styles.pole} />
    </div>
  );
}

const Mark = memo(MarkView);
