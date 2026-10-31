import { vec2 } from 'gl-matrix';
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDispatch } from 'react-redux';
import { VoxelEditorContext } from '../../internals';
import { PaletteHSV, setPaletteItem } from '../../redux/palette-slice';
import { RootState, store, useAppSelector } from '../../redux/store';
import { hsvToRGB } from '../../utils/color';
import styles from './settings.module.scss';
import { isPaletteItemValid } from '../../models/palette/util';
import { useAppSlider } from '../hooks';

const HUE_MAX = 360;

const SATURATION_MAX = 100;

const VALUE_MAX = 100;

const HALF_THUMB_SIZE = 9;

export function HueSlider() {
  const { hsv, selectedIdx } = useHSV();

  const [hue, saturation, value] = hsv;

  const trackRef = useRef<HTMLDivElement | null>(null);

  const hueRGBStr = useHueRGB(hue);

  const { setHSV, onEnd, onAbort } = usePaletteUpdate();

  const update = useCallback(
    ([x]: [number, number]) => {
      const ratio = x / HUE_MAX;

      const newHue = Math.floor(HUE_MAX * ratio);

      setHSV(selectedIdx, [newHue, saturation, value]);
    },
    [setHSV, selectedIdx, saturation, value],
  );

  const { onMouseDown: trigger, railRect } = useAppSlider({
    onChange: update,
    onAfterChange: onEnd,
    onAbort,
    railRef: trackRef,
    min: [0, 0],
    max: [HUE_MAX, 0],
  });

  const [thumbOffset, setThumbOffset] = useState<string>('');

  useEffect(() => {
    if (!railRect.current) {
      return;
    }

    const offset = (hue / HUE_MAX) * railRect.current.width - 9;
    setThumbOffset(`translateX(${offset}px)`);
  }, [hue, railRect]);

  return (
    <div
      className={styles.bar}
      ref={trackRef}
      onMouseDown={trigger}
      onTouchStart={trigger}
    >
      <div
        className={styles.thumb}
        style={{ transform: thumbOffset, backgroundColor: hueRGBStr }}
      />
    </div>
  );
}

export function SaturationValueSketch() {
  const { hsv, selectedIdx } = useHSV();

  const { setHSV, onEnd, onAbort } = usePaletteUpdate();

  const [hue, saturation, value] = hsv;

  const hueRGBStr = useHueRGB(hue);

  const rgb = useMemo(() => {
    const [r, g, b] = hsvToRGB(hue, saturation, value);

    return `rgb(${r}, ${g}, ${b})`;
  }, [hue, saturation, value]);

  const railRef = useRef<HTMLDivElement | null>(null);

  const update = useCallback(
    (pos: vec2) => {
      const [x, y] = pos;

      const newS = x;

      const newV = 100 - y;

      setHSV(selectedIdx, [hue, newS, newV]);
    },
    [hue, setHSV, selectedIdx],
  );

  const { onMouseDown: trigger, railRect } = useAppSlider({
    railRef,
    min: [0, 0],
    max: [SATURATION_MAX, VALUE_MAX],
    onChange: update,
    onAfterChange: onEnd,
    onAbort,
  });

  const [thumbOffset, setThumbOffset] = useState<string>('');

  useEffect(() => {
    if (!railRect.current) {
      return;
    }

    const { width, height } = railRect.current;

    const offsetX = (saturation / SATURATION_MAX) * width - HALF_THUMB_SIZE;
    const offsetY =
      ((VALUE_MAX - value) / VALUE_MAX) * height - HALF_THUMB_SIZE;

    setThumbOffset(`translate(${offsetX}px, ${offsetY}px)`);
  }, [saturation, railRect, value]);

  return (
    <div className={styles.picker}>
      <div
        ref={railRef}
        className={styles.background}
        style={{ backgroundColor: hueRGBStr }}
        onMouseDown={trigger}
        onTouchStart={trigger}
      />
      <div className={styles.backgroundSaturation} />
      <div className={styles.backgroundValue} />
      <div
        className={styles.thumb}
        style={{ transform: thumbOffset, backgroundColor: rgb }}
      ></div>
    </div>
  );
}

/**
 * 根据Hue值，计算[Hue, S_MAX, V_MAX]的RGB。
 */
function useHueRGB(hue: number): string {
  return useMemo(() => {
    const [r, g, b] = hsvToRGB(hue, SATURATION_MAX, VALUE_MAX);

    return `rgb(${r}, ${g}, ${b})`;
  }, [hue]);
}

function useHSV() {
  return useAppSelector((state) => {
    const { items, selectedId: selectedIdx } = state.palette;

    const item = items[selectedIdx];

    if (!isPaletteItemValid(item)) {
      return {
        hsv: [0, 0, 0],
        selectedIdx,
        id: '',
      };
    }

    return {
      hsv: item.hsv,
      selectedIdx,
    };
  });
}

function usePaletteUpdate() {
  const editor = useContext(VoxelEditorContext);

  const dispatch = useDispatch();

  const setHSV = useCallback(
    (id: number, hsv: PaletteHSV) => {
      const [h, s, v] = hsv;

      const rgb = hsvToRGB(h, s, v);

      dispatch(setPaletteItem({ id, rgb, hsv }));

      editor?.palette.updateMeshTexture(id);
    },
    [editor, dispatch],
  );

  const updateHueByState = useCallback(
    (state: RootState, isAborting: boolean, oldState?: RootState) => {
      if (!editor) {
        return;
      }

      const { palette } = state;

      const item = palette.items[palette.selectedId];

      if (!isPaletteItemValid(item)) {
        return;
      }

      const action = setPaletteItem({
        id: palette.selectedId,
        hsv: item.hsv,
        rgb: item.rgb,
        material: item.material,
      });

      if (isAborting) {
        dispatch(action);

        editor.palette.updateMeshTexture(palette.selectedId);
      } else {
        editor.history.saveAction({
          action,
          oldState,
        });
      }
    },
    [dispatch, editor],
  );

  const onEnd = useCallback(
    (value: [number, number], oldState: RootState | undefined) => {
      updateHueByState(store.getState(), false, oldState);
    },
    [updateHueByState],
  );

  const onAbort = useCallback(
    (oldState?: RootState) => {
      oldState && updateHueByState(oldState, true);
    },
    [updateHueByState],
  );

  return {
    setHSV,
    updateHueByState,
    onEnd,
    onAbort,
  };
}
