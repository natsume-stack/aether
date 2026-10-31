import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDispatch } from 'react-redux';
import type { SerializedVec2 } from '@box/box-design';
import { TimelineContext } from '../context';
import { useAppSlider } from '../../../hooks';
import { useAppSelector } from '../../../../redux/store';
import { MAX_ZOOM_WIDTH } from '../const';
import { setTimelineZoomWidth } from '../../../../redux/app-slice';
import { AppSlider } from '../../../components/slider';
import styles from './style.module.scss';

/**
 * 底部控制栏
 */
export function BottomControls() {
  return (
    <div className={styles.bottom}>
      <ButtonSlider />
      <Scrollbar />
    </div>
  );
}

function Scrollbar() {
  const { scrollbar, setScrollbar } = useContext(TimelineContext);

  const { visibleRatio, scrollLeft, range } = scrollbar;

  const [style, setStyle] = useState({
    width: 0,
    left: 0,
  });

  const ref = useRef<HTMLDivElement>(null);

  const onChange = useCallback(
    ([x]: SerializedVec2) => {
      const newScrollLeft = Math.ceil(x);

      setScrollbar((state) => ({
        ...state,
        scrollLeft: newScrollLeft,
      }));
    },
    [setScrollbar],
  );

  const [max, setMax] = useState<SerializedVec2>([0, 0]);

  useEffect(() => {
    if (!ref.current) {
      return;
    }

    const { offsetWidth } = ref.current;

    const thumbWidth = Math.ceil(visibleRatio * offsetWidth);

    let left = 0;

    if (range > 0) {
      left = (scrollLeft / range) * (offsetWidth - thumbWidth);
    }

    setStyle({
      width: thumbWidth,
      left,
    });

    /**
     * 更新可滚动的最大值
     */
    setMax([range, 0]);
  }, [visibleRatio, range, scrollLeft]);

  const { onMouseDown: onMouseDown } = useAppSlider({
    railRef: ref,
    min: [0, 0],
    max,
    onChange,
  });

  return (
    <div ref={ref} className={styles.scrollbar} onMouseDown={onMouseDown}>
      <div className={styles.thumb} style={style} />
    </div>
  );
}

function ButtonSlider() {
  const { zoomWidth } = useAppSelector(({ app }) => {
    const { motionPanel } = app;

    return {
      zoomWidth: motionPanel.zoomWidth,
    };
  });

  const { minZoomWidth } = useContext(TimelineContext);

  const dispatch = useDispatch();

  const onChange = useCallback(
    (newZoom: number) => {
      dispatch(setTimelineZoomWidth(newZoom));
    },
    [dispatch],
  );

  return (
    <div className={styles.zoomControls}>
      <AppSlider
        type="withButton"
        className={styles.slider}
        sliderClassName={styles.sliderContent}
        max={MAX_ZOOM_WIDTH}
        min={minZoomWidth}
        value={zoomWidth}
        onChange={onChange}
        buttonSteps={20}
        buttonDecIcon="#icon-zoomin"
        buttonIncIcon="#icon-zoomout"
      />
    </div>
  );
}
