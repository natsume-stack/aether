import {
  useState,
  ReactNode,
  useMemo,
  DependencyList,
  RefObject,
  useEffect,
  useRef,
  useCallback,
  useContext,
} from 'react';
import { useDispatch } from 'react-redux';
import { VoxelEditorContext } from '../internals';
import { PointerAction, setPointerAction } from '../redux/app-slice';
import { RootState, store } from '../redux/store';
import {
  DraggableOptions,
  MousePosEvent,
  useDraggable,
  useSlider,
  UseSliderOptions,
  UseSliderReturnValue,
  SerializedVec2,
  CombinedTouchEvent,
} from '@box/box-design';

// ref: https://usehooks-ts.com/react-hook/use-event-listener
export function useEventListener<K extends keyof WindowEventMap>(
  eventName: K,
  handler: (event: WindowEventMap[K]) => void,
): void;
export function useEventListener<
  K extends keyof HTMLElementEventMap,
  T extends HTMLElement = HTMLDivElement,
>(
  eventName: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  element: RefObject<T>,
): void;

export function useEventListener<
  KW extends keyof WindowEventMap,
  KH extends keyof HTMLElementEventMap,
  T extends HTMLElement | void = void,
>(
  eventName: KW | KH,
  handler: (
    event: WindowEventMap[KW] | HTMLElementEventMap[KH] | Event,
  ) => void,
  element?: RefObject<T>,
) {
  // Create a ref that stores handler
  const savedHandler = useRef(handler);

  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    // Define the listening target
    const targetElement: T | Window = element?.current || window;
    if (!(targetElement && targetElement.addEventListener)) {
      return;
    }

    // Create event listener that calls handler function stored in ref
    const eventListener: typeof handler = (event) =>
      savedHandler.current(event);

    targetElement.addEventListener(eventName, eventListener);

    // Remove event listener on cleanup
    return () => {
      targetElement.removeEventListener(eventName, eventListener);
    };
  }, [eventName, element]);
}

const SHOW_VIEW_TIMEOUT = 500;

export type UseDelayViewResult = {
  /**
   * 组件
   */
  node: ReactNode;
  /**
   * 计时显示组件
   */
  setTimer: () => void;
  /**
   * 停止计时，隐藏组件
   */
  clear: () => void;
};

/**
 * 延迟展示组件
 */
export function useDelayView(
  options: {
    /**
     * 组件
     */
    node: ReactNode;
    /**
     * 计时多久开始出现
     * @default 500ms
     */
    timeout?: number;
  },
  /**
   * 触发组件更新的依赖
   */
  updateDeps: DependencyList = [],
  /**
   * 清理Hook的依赖
   */
  clearDeps: DependencyList = [],
): UseDelayViewResult {
  const { timeout = SHOW_VIEW_TIMEOUT, node } = options;
  const timer = useRef(-1);
  const [toShow, setToShow] = useState(false);

  const element = useMemo(() => {
    return toShow ? node : undefined;
  }, [node, toShow].concat(updateDeps));

  function setTimer() {
    clearTimeout(timer.current);

    if (timeout <= 0) {
      setToShow(true);
    } else {
      timer.current = window.setTimeout(() => {
        setToShow(true);
      }, timeout);
    }
  }

  function clear() {
    clearTimeout(timer.current);
    setToShow(false);
  }

  useEffect(() => {
    clear();
  }, clearDeps);

  return {
    node: element,
    setTimer,
    clear,
  };
}

/**
 * 通过Tab键在功能板块内的输入框之间跳转。
 */
export function useFocusTrap(
  focusGroup: React.MutableRefObject<HTMLDivElement | null>,
) {
  const focusableInputs = useRef<HTMLInputElement[]>([]);

  const getFocusableInputs = useCallback(() => {
    if (!focusGroup.current) {
      focusableInputs.current = [];
      return;
    }
    const inputs = focusGroup.current?.querySelectorAll<HTMLInputElement>(
      'input:not([disabled]',
    );
    focusableInputs.current = [...inputs];
  }, [focusGroup]);

  const onTabDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab') {
        return;
      }

      if (
        document.activeElement &&
        document.activeElement.tagName === 'INPUT'
      ) {
        getFocusableInputs();
        const inputs = focusableInputs.current;
        if (!inputs.length) {
          return;
        }
        const index = inputs.findIndex((ele) => ele === document.activeElement);
        if (index === -1) {
          return;
        }
        if (index === inputs.length - 1) {
          inputs[0].focus();
        } else {
          inputs[index + 1].focus();
        }
      }
    },
    [getFocusableInputs],
  );

  return {
    onTabDown,
  };
}

/**
 * 缓存ResizeObserver的回调，避免重复挂载监听
 */
export function useResizeObserver<
  T extends HTMLElement = HTMLDivElement,
  Handler extends Function = Function,
>(element: T | null, handler: Handler) {
  const cachedHandler = useRef<Handler>(handler);

  useMemo(() => {
    cachedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      cachedHandler.current();
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [element]);

  return cachedHandler;
}

/**
 * 生成拖拽开始和拖拽结束的函数，处理了mouseAction和拖拽中断。
 */
export function useDragAbort() {
  const dispatch = useDispatch();

  const abortRef = useRef<(oldState?: RootState) => void>(() => {});

  const oldStateRef = useRef<RootState | undefined>();

  const editor = useContext(VoxelEditorContext);

  const onEditorAbort = useCallback(() => {
    abortRef.current(oldStateRef.current);

    oldStateRef.current = undefined;
    editor?.events.removeListener('abort', onEditorAbort);
  }, [editor]);

  const dragStart = useCallback(() => {
    dispatch(setPointerAction(PointerAction.Dragging));

    oldStateRef.current = store.getState();
    editor?.events.addListener('abort', onEditorAbort);
  }, [onEditorAbort, editor, dispatch]);

  const dragEnd = useCallback(() => {
    dispatch(setPointerAction(PointerAction.Idle));

    oldStateRef.current = undefined;
    editor?.events.removeListener('abort', onEditorAbort);
  }, [onEditorAbort, editor, dispatch]);

  useEffect(() => {
    return () => {
      editor?.events.removeListener('abort', onEditorAbort);
    };
  }, [editor, onEditorAbort]);

  return {
    /**
     * - 设置mouseAction为拖拽中
     * - 监听拖拽中断事件
     */
    dragStart,
    /**
     * - 设置mouseAction为闲置中
     * - 移除拖拽中断事件的监听
     */
    dragEnd,
    oldStateRef,
    abortRef,
  };
}

export type onAppSliderAbort = (oldState: RootState | undefined) => void;

interface UseAppSliderOptions extends UseSliderOptions {
  onAbort?: (oldState?: RootState) => void;
  onAfterChange?: (value: SerializedVec2, oldState?: RootState) => void;
}

/**
 * 基于useSlider封装的钩子
 * - 拖拽开始/结束时，更新mouseAction
 * - 监听中断
 * - 中断时传入oldState
 */
export function useAppSlider(
  options: UseAppSliderOptions,
): UseSliderReturnValue {
  const {
    onChange,
    onAfterChange: optionAfterChange,
    onAbort,
    ...remain
  } = options;

  const { dragStart, dragEnd, oldStateRef, abortRef } = useDragAbort();

  const onAfterChange = useCallback(
    (value: SerializedVec2) => {
      optionAfterChange?.(value, oldStateRef.current);

      dragEnd();
    },
    [optionAfterChange, oldStateRef, dragEnd],
  );

  const {
    onMouseDown: sliderMouseDown,
    abort: sliderAbort,
    calculate,
    railRect,
  } = useSlider({
    ...remain,
    onChange,
    onAfterChange,
  });

  const abort = useCallback(() => {
    sliderAbort();

    onAbort?.(oldStateRef.current);
  }, [sliderAbort, onAbort, oldStateRef]);

  abortRef.current = abort;

  const onMouseDown = useCallback(
    (evt: MousePosEvent | CombinedTouchEvent) => {
      dragStart();

      sliderMouseDown(evt);
    },
    [sliderMouseDown, dragStart],
  );

  return {
    onMouseDown,
    abort,
    calculate,
    railRect,
  };
}

export interface AppDraggableOptions extends DraggableOptions {
  onDrag: (evt: MousePosEvent, oldState?: RootState) => void;
  onDragEnd: (evt: MousePosEvent, oldState?: RootState) => void;
  onDragCancel: (oldState?: RootState) => void;
}

export function useAppDraggable(options: AppDraggableOptions) {
  const {
    onDrag: optionDrag,
    onDragEnd: optionDragEnd,
    onDragCancel: optionDragCancel,
    ...remain
  } = options;

  const { dragStart, dragEnd, abortRef, oldStateRef } = useDragAbort();

  const onDragEnd = useCallback(
    (evt: MousePosEvent) => {
      optionDragEnd(evt, oldStateRef.current);

      dragEnd();
    },
    [optionDragEnd, oldStateRef, dragEnd],
  );

  const onDrag = useCallback(
    (evt: MousePosEvent) => {
      optionDrag(evt, oldStateRef.current);
    },
    [optionDrag, oldStateRef],
  );

  const onDragCancel = useCallback(() => {
    optionDragCancel(oldStateRef.current);
  }, [optionDragCancel, oldStateRef]);

  const { onMouseDown: draggableMouseDown, abort } = useDraggable({
    ...remain,
    onDrag,
    onDragEnd,
    onDragCancel,
  });

  abortRef.current = abort;

  const onMouseDown = useCallback(
    (evt: MousePosEvent) => {
      dragStart();

      draggableMouseDown(evt);
    },
    [draggableMouseDown, dragStart],
  );

  return { onMouseDown, abort };
}
