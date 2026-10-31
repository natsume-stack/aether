import {
  MouseEventHandler,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDispatch } from 'react-redux';
import { clamp } from 'ramda';
import {
  SerializedVec2,
  Tree,
  TreeNode,
  TreeNodeType,
  isMetaKeyPressed,
  MousePosEvent,
} from '@box/box-design';
import { VoxelEditorContext } from '../../../internals';
import {
  Motion,
  moveKeyframes,
  NodeKeyframeIds,
  NodeKeyframes,
  setActiveKeyframes,
} from '../../../redux/animator-slice';
import { RootState, store, useAppSelector } from '../../../redux/store';
import { MotionsContext } from '../context';
import { MotionHeader } from '../header';
import { BottomControls } from './bottom';
import {
  HIERARCHY_WIDTH,
  MAX_ZOOM_WIDTH,
  TIMELINE_HEIGHT,
  TIMELINE_PADDING,
  TIME_SCALE_HEIGHT,
} from './const';
import {
  CalculateFrameByClientX,
  OnItemSelect,
  Scrollbar,
  TimelineContext,
  TimelineContextType,
  TimelineState,
} from './context';
import { TimelineContextMenu } from './contextmenu';
import { TimeScale } from './time-scale';
import { Timeline } from './timeline';
import styles from './style.module.scss';
import {
  everyKeyframe,
  frameToTime,
  KEYFRAME_PER_SEC,
  MAX_KEYFRAME_TIME,
  timeToFrame,
} from '../../../models/animator-app/util';
import { setCurrentTime, setTimelineZoomWidth } from '../../../redux/app-slice';
import { useAppDraggable, useResizeObserver } from '../../hooks';
import { Rect, SelectRect } from '../../components/select-rect';
import { debounce } from '../../../utils/debounce-throttle';
import { parseNodeKeyframeTimes } from '../../../models/animator-app/motion-manager/util';
import { useIntl } from 'react-intl';

const RESIZE_DEBOUNCE = 50;

export function HierarchyTimelines() {
  const intl = useIntl();
  const { hierarchyData } = useAppSelector(({ animator }) => {
    return {
      hierarchyData: animator.hierarchyData,
    };
  });
  const { boneIds, activeBoneIds } = useContext(MotionsContext);

  const treeData = useMemo(() => {
    const data: TreeNode[] = [];

    boneIds.forEach((boneId) => {
      const boneNode = hierarchyData[boneId];

      if (!boneNode) {
        return;
      }

      data.push({
        id: boneId,
        name: boneNode.name,
        type: TreeNodeType.Attachable,
        icon: '#icon-tool-joint-tool',
        className: styles.treeNode,
        disableExpand: true,
        disableDragging: true,
        disableRename: true,
      });
    });

    return data;
  }, [hierarchyData, boneIds]);

  const timelines = useMemo(() => {
    return boneIds.map((boneId) => {
      return (
        <Timeline key={boneId} nodeId={boneId} className={styles.timeline} />
      );
    });
  }, [boneIds]);

  const editor = useContext(VoxelEditorContext);

  const { selectedKeyframes, motion, zoomWidth } = useAppSelector(
    ({ animator, app }) => {
      const { motionData, activeMotionId, activeKeyframes } = animator;

      return {
        selectedKeyframes: activeKeyframes,
        motion: motionData.motions[activeMotionId],
        zoomWidth: app.motionPanel.zoomWidth,
      };
    },
  );

  const { contextMenu, onContextMenu, setContextMenuState } = useContextMenu();

  // 直接选中
  const select = useCallback(
    (ids: string[], nodeId: string) => {
      editor?.history.saveAction({
        action: setActiveKeyframes({
          [nodeId]: ids,
        }),
      });
    },
    [editor],
  );

  /**
   * 多选 & 反选（按住meta键的选择逻辑）
   */
  const multiSelect = useCallback(
    (ids: string[], nodeId: string, selected: boolean) => {
      const nodeSelectedKeyframes = selectedKeyframes[nodeId] || [];

      const idSet = new Set(nodeSelectedKeyframes);

      // selected === true，需要变成false, 新数组不能含有任何timeList里的成员
      if (selected) {
        ids.forEach((time) => {
          idSet.delete(time);
        });
      } else {
        // selected === false，需要变成true, 新数组必须含有全部timeList里的成员
        ids.forEach((time) => {
          idSet.add(time);
        });
      }

      editor?.history.saveAction({
        action: setActiveKeyframes({
          ...selectedKeyframes,
          [nodeId]: Array.from(idSet),
        }),
      });
    },
    [editor, selectedKeyframes],
  );

  const onItemSelect = useCallback<OnItemSelect>(
    (evt, ids, nodeId, selected) => {
      setContextMenuState({ visible: false });

      if (!editor) {
        return;
      }

      // 右键 -> 视情况更新选中 -> 呼出右键菜单
      if (evt.button === 2) {
        if (!selected) {
          select(ids, nodeId);
        }
        return;
      }

      // meta键 -> 视情况更新选中 -> 已选中的取消选中，未选中的设置为选中
      if (isMetaKeyPressed(evt)) {
        multiSelect(ids, nodeId, selected);
        return;
      }

      select(ids, nodeId);
    },
    [editor, multiSelect, select, setContextMenuState],
  );

  const scrollableElement = useRef<HTMLDivElement>(null);

  const dispatch = useDispatch();

  const [scrollThresholdX, setScrollThresholdX] = useState<SerializedVec2>([
    0, 0,
  ]);

  const [timelineState, setTimelineState] = useState<TimelineState>({
    minZoomWidth: 0,
    secondWidth: 1,
    height: 0,
    keyframe: {
      width: 7,
      offsetLeft: 3,
      gap: 9,
    },
  });

  const [scrollbar, setScrollbar] = useState<Scrollbar>({
    visibleRatio: 1,
    range: 0,
    scrollLeft: 0,
    scrollWidth: 0,
    left: 0,
  });

  useEffect(() => {
    const element = scrollableElement.current;

    if (!element) {
      return;
    }

    const onScroll = () => {
      setScrollbar((state) => ({
        ...state,
        scrollLeft: element.scrollLeft,
      }));
    };

    element.addEventListener('scroll', onScroll);

    return () => {
      element.removeEventListener('scroll', onScroll);
    };
  }, [setScrollbar]);

  const onPanelResize = useMemo(
    () =>
      debounce(() => {
        if (!scrollableElement.current) {
          return;
        }

        const { scrollWidth, scrollLeft, offsetWidth, offsetHeight } =
          scrollableElement.current;

        // 可滚动的区域需要减去本身宽度
        const range = scrollWidth - offsetWidth;

        // 可视区域占比计算需要用原本完整的宽度计算
        const visibleRatio = offsetWidth / scrollWidth;

        const { left, height } =
          scrollableElement.current.getBoundingClientRect();

        setScrollbar(() => ({
          range,
          visibleRatio,
          scrollLeft,
          scrollWidth,
          left,
        }));

        const threshold = 0.05 * offsetWidth;

        setScrollThresholdX([threshold + HIERARCHY_WIDTH, threshold]);

        const minZoomWidth =
          offsetWidth - HIERARCHY_WIDTH - 2 * TIMELINE_PADDING;

        setTimelineState((state) => ({
          ...state,
          minZoomWidth,
          height,
        }));

        if (zoomWidth < minZoomWidth) {
          dispatch(setTimelineZoomWidth(minZoomWidth));
        }
      }, RESIZE_DEBOUNCE),
    [dispatch, zoomWidth],
  );

  useResizeObserver(scrollableElement.current, onPanelResize);

  useEffect(() => {
    onPanelResize();
  }, [onPanelResize]);

  const onZoomWidthChange = useCallback(
    (newZoomWidth: number) => {
      const zoomWidth = clamp(
        timelineState.minZoomWidth,
        MAX_ZOOM_WIDTH,
        newZoomWidth,
      );

      /**
       * 这里计算的是每一秒的平均宽度。
       * 因为最后一段要多画一个1px的刻度线（60s），所以减去1px
       */
      const secondWidth = (zoomWidth - 1) / MAX_KEYFRAME_TIME;

      const keyframeGap = zoomWidth / (KEYFRAME_PER_SEC * MAX_KEYFRAME_TIME);
      const keyframeWidth = clamp(1, 7, keyframeGap + 1);
      const keyframeOffsetLeft =
        keyframeWidth % 2 === 0 ? keyframeWidth / 2 : (keyframeWidth - 1) / 2;

      dispatch(setTimelineZoomWidth(zoomWidth));

      setTimelineState((state) => ({
        ...state,
        secondWidth,
        keyframe: {
          gap: keyframeGap,
          width: keyframeWidth,
          offsetLeft: keyframeOffsetLeft,
        },
      }));
    },
    [dispatch, timelineState.minZoomWidth],
  );

  useEffect(() => {
    onZoomWidthChange(zoomWidth);
  }, [zoomWidth, onZoomWidthChange]);

  useEffect(() => {
    if (scrollableElement.current) {
      scrollableElement.current.scrollLeft = scrollbar.scrollLeft;
    }
  }, [scrollbar.scrollLeft]);

  /**
   * 通过鼠标事件中的横坐标（clientX）计算对应的关键帧
   */
  const calculateFrameByClientX = useCallback(
    (clientX: number) => {
      if (!scrollableElement.current) {
        return 0;
      }

      const offset =
        clientX -
        scrollbar.left +
        scrollableElement.current.scrollLeft -
        TIMELINE_PADDING -
        HIERARCHY_WIDTH;

      const time = clamp(
        0,
        MAX_KEYFRAME_TIME,
        offset / timelineState.secondWidth,
      );

      return timeToFrame(time);
    },
    [scrollbar.left, timelineState.secondWidth],
  );

  const onDragItemStart = useDragKeyframes({
    calculateFrameByClientX,
    element: scrollableElement,
    scrollThresholdX,
  });

  const timelineContext = useMemo<TimelineContextType>(() => {
    return {
      ...timelineState,
      scrollbar,
      setScrollbar,
      onItemSelect,
      onDragItemStart: onDragItemStart,
      setTimelineState,
      calculateFrameByClientX,
    };
  }, [
    timelineState,
    scrollbar,
    setScrollbar,
    onItemSelect,
    onDragItemStart,
    calculateFrameByClientX,
  ]);

  const { selectRect, onMouseDown: onSelectRectMouseDown } = useSelectRect({
    element: scrollableElement,
    calculateFrameByClientX,
    boneIds,
    motion,
    scrollbar,
  });

  const onTimeScaleMouseDown = useUpdateTime({
    calculateFrameByClientX,
    scrollableElement,
    scrollThresholdX,
  });

  const onTimelinesMouseDown = useCallback(
    (evt: React.MouseEvent) => {
      setContextMenuState({ visible: false });

      onSelectRectMouseDown(evt);
    },
    [onSelectRectMouseDown, setContextMenuState],
  );

  const onTreeNodeSelect = useCallback(
    ([boneId]: string[]) => {
      editor?.animatorApp.nodeManager.setActiveIds([boneId]);
    },
    [editor],
  );

  return (
    <TimelineContext.Provider value={timelineContext}>
      <div className={styles.hierarchyTimelines}>
        <div className={styles.scrollable} ref={scrollableElement}>
          <MotionHeader
            title={intl.formatMessage({
              description: 'Hierarchy Timelines',
              defaultMessage: 'Hierarchies',
            })}
            className={styles.title}
          />
          <div
            className={styles.timelines}
            onMouseDown={onTimelinesMouseDown}
            onContextMenu={onContextMenu}
          >
            {timelines}
          </div>
          {selectRect}
          {contextMenu}
          <TimeScale
            onMouseDown={onTimeScaleMouseDown}
            onResize={onPanelResize}
          />
          <Tree
            className={styles.tree}
            expandIcon=""
            treeData={treeData}
            selectedIds={activeBoneIds}
            onSelect={onTreeNodeSelect}
          />
        </div>
        <BottomControls />
      </div>
    </TimelineContext.Provider>
  );
}

/**
 * 在时间轴上点击、拖拽时，更新当前时间
 */
function useUpdateTime(params: {
  calculateFrameByClientX: CalculateFrameByClientX;
  scrollableElement: RefObject<HTMLDivElement>;
  scrollThresholdX: SerializedVec2;
}) {
  const { calculateFrameByClientX, scrollableElement, scrollThresholdX } =
    params;

  const dispatch = useDispatch();

  const editor = useContext(VoxelEditorContext);

  const calculateTime = useCallback(
    (x: number) => {
      const frame = calculateFrameByClientX(x);

      return frameToTime(frame);
    },
    [calculateFrameByClientX],
  );

  const onUpdateTimeAbort = useCallback(
    (oldState?: RootState) => {
      if (oldState) {
        dispatch(setCurrentTime(oldState.app.motionPanel.currentTime));

        editor?.animatorApp.motionManager.poseAtTime(
          oldState.app.motionPanel.currentTime,
        );
      }
    },
    [dispatch, editor],
  );

  const updateTime = useCallback(
    ({ clientX: x }: MousePosEvent) => {
      const currentTime = calculateTime(x);

      dispatch(setCurrentTime(currentTime));

      editor?.motionPlayer.pause();

      editor?.animatorApp.motionManager.poseAtTime(currentTime);
    },
    [dispatch, calculateTime, editor],
  );

  const onUpdateTimeEnd = useCallback(
    ({ clientX: x }: MousePosEvent, oldState?: RootState) => {
      if (!editor) {
        return;
      }

      const newCurrentTime = calculateTime(x);

      editor.history.saveAction({
        action: setCurrentTime(newCurrentTime),
        oldState,
      });
    },
    [calculateTime, editor],
  );

  const { onMouseDown: draggableTrigger } = useAppDraggable({
    containerRef: scrollableElement,
    onDragStart: updateTime,
    onDrag: updateTime,
    onDragEnd: onUpdateTimeEnd,
    onDragCancel: onUpdateTimeAbort,
    scroll: {
      thresholdX: scrollThresholdX,
      scrollY: false,
    },
  });

  return useCallback(
    (evt: MousePosEvent) => {
      draggableTrigger(evt);

      updateTime(evt);
    },
    [draggableTrigger, updateTime],
  );
}

/**
 * 管理框选
 */
function useSelectRect(params: {
  element: RefObject<HTMLDivElement>;
  calculateFrameByClientX: CalculateFrameByClientX;
  boneIds: string[];
  motion: Motion;
  scrollbar: Scrollbar;
}) {
  const { element, calculateFrameByClientX, boneIds, motion } = params;
  const editor = useContext(VoxelEditorContext);

  const elementRect = useRef<Rect>({ left: 0, top: 0, width: 0, height: 0 });

  /**
   * 通过鼠标事件中的纵坐标（clientY）计算对应的节点索引
   */
  const calculateNodeByClientY = useCallback(
    (clientY: number) => {
      if (!element.current) {
        return 0;
      }

      const dist =
        clientY -
          elementRect.current.top -
          TIME_SCALE_HEIGHT +
          element.current.scrollTop || 0;

      return dist / TIMELINE_HEIGHT;
    },
    [element],
  );

  const [selectRectState, setSelectRectState] = useState<{
    visible: boolean;
    position?: SerializedVec2;
    min?: SerializedVec2;
    max?: SerializedVec2;
  }>({
    visible: false,
  });

  const closeSelectRect = useCallback(() => {
    setSelectRectState({ visible: false });
  }, [setSelectRectState]);

  const selectByRect = useCallback(
    (rect: Rect) => {
      const { top, left, width, height } = rect;

      // 横向计算出起始的帧和结束的帧
      const startTime = frameToTime(calculateFrameByClientX(left));
      const endTime = frameToTime(calculateFrameByClientX(left + width));

      /**
       * 纵向计算出起始的nodeId和结束的nodeId。
       * 因为节点有高度范围，所以分别用floor和ceil取整，这样才可以框到一点就算选中。
       */
      const startNodeIndex = Math.floor(calculateNodeByClientY(top));
      const endNodeIndex = Math.ceil(calculateNodeByClientY(top + height));

      const newNodeKeyframes: NodeKeyframeIds = {};

      for (let i = startNodeIndex; i < endNodeIndex; i++) {
        const boneId = boneIds[i];

        if (!boneId || !motion.nodes[boneId]) {
          continue;
        }

        if (!newNodeKeyframes[boneId]) {
          newNodeKeyframes[boneId] = [];
        }

        const node = motion.nodes[boneId];

        everyKeyframe(0, node.keyframes, ({ id, time }) => {
          if (time >= startTime && time <= endTime) {
            newNodeKeyframes[boneId].push(id);

            return true;
          }

          return time <= endTime;
        });
      }

      editor?.history.saveAction({
        action: setActiveKeyframes(newNodeKeyframes),
      });
    },
    [calculateFrameByClientX, calculateNodeByClientY, boneIds, motion, editor],
  );

  const selectRect = useMemo(() => {
    const { visible, position, min, max } = selectRectState;

    if (!visible || !position || !min || !max) {
      return;
    }

    const onUpdate = (rect?: Rect) => {
      rect && selectByRect(rect);
    };

    return (
      <SelectRect
        min={min}
        max={max}
        onUpdate={onUpdate}
        onSelect={(rect) => {
          onUpdate(rect);
          closeSelectRect();
        }}
        position={position}
        onAbort={closeSelectRect}
      />
    );
  }, [selectRectState, closeSelectRect, selectByRect]);

  const onMouseDown = useCallback(
    (evt: React.MouseEvent) => {
      if (evt.button !== 0 || !element.current) {
        return;
      }

      editor?.history.saveAction({
        action: setActiveKeyframes({}),
      });

      const { left, top, width, height } =
        element.current.getBoundingClientRect();

      elementRect.current = {
        left,
        top,
        width,
        height,
      };

      const min: SerializedVec2 = [
        left + HIERARCHY_WIDTH,
        top + TIME_SCALE_HEIGHT,
      ];
      const max: SerializedVec2 = [left + width, top + height];

      // 无任何选中，框选
      setSelectRectState({
        visible: true,
        min,
        max,
        position: [evt.clientX, evt.clientY],
      });
    },
    [editor, element],
  );

  return { selectRect, onMouseDown };
}

/**
 * 管理右键菜单
 */
function useContextMenu() {
  const [contextMenuState, setContextMenuState] = useState<{
    visible: boolean;
    position?: SerializedVec2;
  }>({
    visible: false,
  });

  const onContextMenu = useCallback<MouseEventHandler>((evt) => {
    setContextMenuState({
      visible: true,
      position: [evt.clientX, evt.clientY],
    });
  }, []);

  const onContextMenuBlur = useCallback(() => {
    setContextMenuState({ visible: false });
  }, [setContextMenuState]);

  const contextMenu = useMemo(() => {
    if (!contextMenuState.visible) {
      return;
    }

    return (
      <TimelineContextMenu
        position={contextMenuState.position}
        onBlur={onContextMenuBlur}
      />
    );
  }, [contextMenuState, onContextMenuBlur]);

  return { contextMenu, onContextMenu, setContextMenuState };
}

function useDragKeyframes(params: {
  calculateFrameByClientX: CalculateFrameByClientX;
  element: RefObject<HTMLDivElement>;
  scrollThresholdX: SerializedVec2;
}) {
  const { calculateFrameByClientX, element, scrollThresholdX } = params;

  /**
   * 记录拖拽时，鼠标所在的关键帧位置，用于计算后续关键帧偏差
   */
  const dragStartFrame = useRef<number | undefined>(undefined);

  /**
   * 用于记录拖拽开始时，选中的关键帧
   */
  const sourceKeyframes = useRef<NodeKeyframes | undefined>();

  const editor = useContext(VoxelEditorContext);

  const dispatch = useDispatch();

  // 记录开始拖拽时的数据
  const updateDragStartFrame = useCallback(
    (x: number) => {
      const { activeKeyframes, activeMotionId, motionData } =
        store.getState().animator;

      const motion = motionData.motions[activeMotionId];

      if (!motion) {
        return;
      }

      const nodes = motion.nodes;

      const notEmpty = Object.keys(activeKeyframes).some((nodeId) => {
        const timeList = activeKeyframes[nodeId];
        const node = nodes[nodeId];

        return timeList && timeList.length && node;
      });

      if (!notEmpty) {
        return;
      }

      editor?.motionPlayer.pause();

      dragStartFrame.current = calculateFrameByClientX(x);
      sourceKeyframes.current = parseNodeKeyframeTimes(nodes, activeKeyframes);
    },
    [calculateFrameByClientX, editor],
  );

  const dragKeyframes = useCallback(
    (x: number, oldState: RootState, saveRecord?: boolean) => {
      if (
        !editor ||
        dragStartFrame.current === undefined ||
        sourceKeyframes.current === undefined
      ) {
        return;
      }

      const offsetFrames = calculateFrameByClientX(x) - dragStartFrame.current;

      const { activeMotionId, motionData } = oldState.animator;

      editor.history.saveAction({
        action: moveKeyframes({
          sourceMotion: motionData.motions[activeMotionId],
          sourceKeyframes: sourceKeyframes.current,
          offsetFrames,
        }),
        oldState,
        saveRecord,
      });

      editor.animatorApp.motionManager.poseAtTime(
        oldState.app.motionPanel.currentTime,
      );
    },
    [editor, calculateFrameByClientX],
  );

  const onDragStart = useCallback(
    ({ clientX }: MousePosEvent) => {
      updateDragStartFrame(clientX);
    },
    [updateDragStartFrame],
  );

  const onDrag = useCallback(
    ({ clientX }: MousePosEvent, oldState?: RootState) => {
      oldState && dragKeyframes(clientX, oldState, false);
    },
    [dragKeyframes],
  );

  const onDragEnd = useCallback(
    ({ clientX }: MousePosEvent, oldState?: RootState) => {
      oldState && dragKeyframes(clientX, oldState, true);

      dragStartFrame.current = undefined;
      sourceKeyframes.current = undefined;
    },
    [dragKeyframes],
  );

  const onDragCancel = useCallback<(oldState?: RootState) => void>(
    (oldState) => {
      if (oldState && sourceKeyframes.current) {
        const { activeMotionId, motionData, activeKeyframes } =
          oldState.animator;

        dispatch(
          moveKeyframes({
            sourceMotion: motionData.motions[activeMotionId],
            sourceKeyframes: sourceKeyframes.current,
            offsetFrames: 0,
          }),
        );
        dispatch(setActiveKeyframes(activeKeyframes));

        dragStartFrame.current = undefined;
        sourceKeyframes.current = undefined;

        editor?.animatorApp.motionManager.poseAtTime(
          oldState.app.motionPanel.currentTime,
        );
      }
    },
    [dispatch, editor],
  );

  const { onMouseDown: trigger } = useAppDraggable({
    containerRef: element,
    onDragStart,
    onDrag,
    onDragEnd,
    onDragCancel,
    scroll: {
      thresholdX: scrollThresholdX,
      scrollY: false,
    },
  });

  return trigger;
}
