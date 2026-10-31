import { clamp } from 'ramda';
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Actions as ActionsType, EditingMode } from '@box/utils/helper';
import type { SerializedVec2 } from '@box/box-design';
import { useAppSelector } from '../../../redux/store';
import { AppMode, PointerAction } from '../../../redux/app-slice';
import { useEventListener } from '../../hooks';
import { VoxelEditorContext } from '../../../internals';
import type { VoxelEditor } from '../../../models/editor';
import styleNames from './style.module.scss';
import { LONG_PRESS_DURATION } from '../../../defs';

export type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type SelectRectOptions = {
  /**
   * mousedown时的位置
   */
  position: SerializedVec2;
  /**
   * 框选区域的坐标限制
   */
  min: SerializedVec2;
  max: SerializedVec2;
  /**
   * 拖拽完框选区域的回调
   * @param rect 框选区域，如果undefined则表示未框出有效区域
   */
  onSelect: (rect?: Rect) => void;
  /**
   * 中断拖拽时的回调
   */
  onAbort: () => void;
  /**
   * mouseMove时的处理
   */
  onUpdate?: (rect?: Rect) => void;
};

export function SelectRect(props: SelectRectOptions) {
  const { min, max, onSelect, position: startPos, onAbort, onUpdate } = props;

  const [rect, setRect] = useState<Rect | undefined>(undefined);

  const editor = useContext(VoxelEditorContext);

  const calculateRect = useCallback(
    (params: {
      start: SerializedVec2;
      end: SerializedVec2;
      max: SerializedVec2;
      min: SerializedVec2;
    }) => {
      const { start, end, max, min } = params;

      const [sx, sy] = start;
      const [ex, ey] = end;
      const [minX, minY] = min;
      const [maxX, maxY] = max;

      const verticals: SerializedVec2 = sy <= ey ? [sy, ey] : [ey, sy];
      const horizontals: SerializedVec2 = sx <= ex ? [sx, ex] : [ex, sx];

      const [top, bottom] = verticals.map((y) => {
        return clamp(minY, maxY, y);
      });
      const [left, right] = horizontals.map((x) => {
        return clamp(minX, maxX, x);
      });

      const width = right - left;
      const height = bottom - top;

      return { top, left, width, height };
    },
    [],
  );

  useEffect(() => {
    editor?.events.addListener('abort', onAbort);
    editor?.stage.setPointerAction(PointerAction.Dragging);

    return () => {
      editor?.events.removeListener('abort', onAbort);
      editor?.stage.setPointerAction(PointerAction.Idle);
    };
  }, [editor, onAbort]);

  const onPointerMove = useCallback(
    ([targetClientX, targetClientY]: [number, number]) => {
      const rect = calculateRect({
        start: startPos,
        end: [targetClientX, targetClientY],
        min,
        max,
      });

      setRect(rect);

      onUpdate && onUpdate(rect);
    },
    [onUpdate, calculateRect, startPos, max, min],
  );

  const onPointerUp = useCallback(() => {
    onSelect(rect);
  }, [onSelect, rect]);

  useEventListener('pointermove', (e) => {
    onPointerMove([e.clientX, e.clientY]);
  });
  useEventListener('pointerup', onPointerUp);

  const style = rect ? rect : { display: 'none' };

  const child = <div className={styleNames.selectRect} style={style} />;

  return createPortal(child, document.body);
}

/**
 * 体素工具 - 选择工具 - 框选 - 绘制二维矩形框的组件
 * 动画工具 - 框选 - 多选部件
 */
export function useGlobalSelectRect(editor?: VoxelEditor) {
  const pointers = useRef<PointerEvent[]>([]);
  const pointerDownTimer = useRef<number | undefined>(undefined);

  const { appMode, pivotMode, pointerAction, mode, toolType } = useAppSelector(
    (state) => ({
      appMode: state.app.mode,
      pivotMode: state.animator.pivotMode,
      pointerAction: state.app.pointerAction,
      mode: state.editing.mode,
      toolType: state.editing.toolType,
    }),
  );

  const [position, setPosition] = useState<SerializedVec2 | undefined>();

  const onPointerDown = useCallback(
    (evt: PointerEvent) => {
      pointers.current.push(evt);

      if (
        !editor ||
        !editor.voxelApp.veController.mouseDetect(evt.target) ||
        pointerAction !== PointerAction.Idle
      ) {
        setPosition(undefined);
        return;
      }

      if (evt.pointerType === 'mouse') {
        // pc端按下左键才显示框选
        if (evt.button !== 0) {
          setPosition(undefined);
          return;
        }
        setPosition([evt.clientX, evt.clientY]);
      } else {
        // 移动端长按才会触发框选
        if (pointerDownTimer.current) {
          clearTimeout(pointerDownTimer.current);
        }
        pointerDownTimer.current = window.setTimeout(() => {
          if (
            pointers.current.length === 1 &&
            // 移动端框选和触发条件和transformControl拖动的条件一样
            // 所以需要判断框选时是否正在拖动
            !editor.animatorApp.nodeManager.transform.isSelected()
          ) {
            setPosition([evt.clientX, evt.clientY]);
          }
        }, LONG_PRESS_DURATION);
      }
    },
    [editor, pointerAction],
  );

  const onPointerCancel = useCallback((event: PointerEvent) => {
    const pointerIds = pointers.current.map((pointer) => pointer.pointerId);
    const index = pointerIds.indexOf(event.pointerId);
    pointers.current.splice(index, 1);
    if (pointerDownTimer.current) {
      clearTimeout(pointerDownTimer.current);
    }
  }, []);

  const onTouchMove = useCallback(
    (event: TouchEvent) => {
      // 没有position，即:在长按到300ms之前，就开始移动
      if (!position && pointerDownTimer.current) {
        clearTimeout(pointerDownTimer.current);
      }
    },
    [position],
  );

  // 绑定mousedown回被touchdown触发
  useEventListener('pointerdown', onPointerDown);

  // 移动端长按才回触发框选
  useEventListener('pointerup', onPointerCancel);
  useEventListener('pointerleave', onPointerCancel);
  useEventListener('pointercancel', onPointerCancel);
  // 不使用pointermove是因为在移动端，只要手指按下就会触发pointermove
  useEventListener('touchmove', onTouchMove);

  const onSelect = useCallback(
    (rect?: Rect) => {
      setPosition(undefined);

      if (!editor || !rect || (!rect.width && !rect.height)) {
        return;
      }

      const { top, left, width, height } = rect;

      editor.selectBox.select({
        start: [left, top],
        end: [left + width, top + height],
        appMode,
      });
    },
    [appMode, editor],
  );

  const onAbort = useCallback(() => {
    setPosition(undefined);
  }, []);

  const enableSelectRect = useMemo(() => {
    const showAnimatorRect = appMode === AppMode.Animator && !pivotMode;

    const showVoxelRect =
      appMode === AppMode.Voxel &&
      mode === EditingMode.rect &&
      toolType === ActionsType.Select;

    return showAnimatorRect || showVoxelRect;
  }, [appMode, pivotMode, mode, toolType]);

  return enableSelectRect && position ? (
    <SelectRect
      position={position}
      onSelect={onSelect}
      onAbort={onAbort}
      min={[0, 0]}
      max={[window.innerWidth, window.innerHeight]}
    />
  ) : null;
}
