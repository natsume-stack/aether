import { RootState } from 'apps/voxa/src/redux/store';
import { useCallback, useRef } from 'react';
import { Slider, SliderOptions, useClassName } from '@box/box-design';
import { onAppSliderAbort, useDragAbort } from '../../hooks';
import styles from './style.module.scss';

export type AppSliderOnMouseDown = (oldState?: RootState) => void;

interface AppSliderOptions extends Omit<SliderOptions, 'abortRef'> {
  onMouseDown?: AppSliderOnMouseDown;
  onAfterChange?: (value: number, oldState?: RootState) => void;
  onAbort?: onAppSliderAbort;
}

/**
 * 基于box-design <Slider />组件封装的滑块组件，整合了业务侧的副作用
 *  - 更新mouseAction
 *  - 监听editor abort事件
 *  - 记录oldState，作为onAbort的入参
 */
export function AppSlider(options: AppSliderOptions) {
  const {
    onMouseDown: optionMouseDown,
    onAfterChange: optionAfterChange,
    onAbort,
    sliderClassName: optionSliderClassName,
    ...remain
  } = options;

  const sliderClassName = useClassName(
    [styles.sliderWrapper, optionSliderClassName],
    [optionSliderClassName],
  );

  const { dragStart, dragEnd, oldStateRef, abortRef } = useDragAbort();

  const onMouseDown = useCallback(() => {
    dragStart();

    optionMouseDown?.(oldStateRef.current);
  }, [optionMouseDown, dragStart, oldStateRef]);

  const onAfterChange = useCallback(
    (value: number) => {
      optionAfterChange?.(value, oldStateRef.current);

      dragEnd();
    },
    [optionAfterChange, dragEnd, oldStateRef],
  );

  const sliderAbortRef = useRef(() => {});

  abortRef.current = useCallback(() => {
    sliderAbortRef.current();

    onAbort?.(oldStateRef.current);
  }, [onAbort, oldStateRef]);

  return (
    <Slider
      {...remain}
      sliderClassName={sliderClassName}
      onMouseDown={onMouseDown}
      onAfterChange={onAfterChange}
      abortRef={sliderAbortRef}
    />
  );
}
