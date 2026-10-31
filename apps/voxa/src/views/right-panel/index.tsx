import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Collapse,
  SharedTipsContext,
  useSharedTipsDelay,
} from '@box/box-design';
import { AnimatorMode, PivotMode } from '../../redux/animator-slice';
import { AppMode } from '../../redux/app-slice';
import { useAppSelector } from '../../redux/store';
import { debounce } from '../../utils/debounce-throttle';
import { isMobile } from '../../utils/devices';
import { Hierarchy } from '../hierarchy';
import { useEventListener, useFocusTrap, useResizeObserver } from '../hooks';
import { Palette } from '../palette';
import { ParamPanel } from '../param-panel';
import style from './style.module.scss';

enum PANEL_IDS {
  'palette',
  'list',
  'parameter',
}

const DEFAULT_ACTIVE_IDS = [
  PANEL_IDS.palette,
  PANEL_IDS.list,
  PANEL_IDS.parameter,
];

const PANEL_CONFIG: { [key: string]: PANEL_IDS[] } = {
  [`${AppMode.Voxel}`]: [PANEL_IDS.palette],
  [`${AppMode.Animator}-${AnimatorMode.Setup}`]: [
    PANEL_IDS.palette,
    PANEL_IDS.list,
    PANEL_IDS.parameter,
  ],
  [`${AppMode.Animator}-${AnimatorMode.Motion}`]: [
    PANEL_IDS.list,
    PANEL_IDS.parameter,
  ],
  [`${AppMode.Animator}-${AnimatorMode.HitBox}`]: [PANEL_IDS.parameter],
};

function getPanelConfigKey(appMode: AppMode, mode: AnimatorMode) {
  if (appMode === AppMode.Voxel) {
    return `${appMode}`;
  }

  return `${appMode}-${mode}`;
}

// 各个面板的最小高度
// 色板
const PALETTE_MIN_HEIGHT = 82;
// 节点列表
const HIERARCHY_MIN_HEIGHT = 101;
// 参数面板
const PARAM_MIN_HEIGHT = 178;

const MIN_HEIGHTS = [
  PALETTE_MIN_HEIGHT,
  HIERARCHY_MIN_HEIGHT,
  PARAM_MIN_HEIGHT,
];
const MIN_HEIGHTS_TOTAL = MIN_HEIGHTS.reduce((a, b) => a + b, 0);

// 各个面板的默认高度
// 色板
const PALETTE_DEFAULT_HEIGHT = 381;
// 参数面板
const PARAM_DEFAULT_HEIGHT = PARAM_MIN_HEIGHT;

// 面板被折叠后的高度
const COLLAPSED_HEIGHT = 41;
// 面板内容区域高度
const PANEL_CONTENT_HEIGHT = `calc(100% - ${COLLAPSED_HEIGHT}px)`;

// 触发resize时，防抖的时间间隔
const RESIZE_DEBOUNCE_TIME = 50;

type DragStartState = {
  /**
   * 拖拽杆上方可以改变高度的面板的序号
   */
  above: number[];
  /**
   * 拖拽杆下方可以改变高度的面板的序号
   */
  below: number[];
  /**
   * 开始拖拽时的鼠标位置
   */
  startY: number;
  /**
   * 开始拖拽时的面板高度
   */
  startHeights: number[];
};

export function RightPanel(props: { isShow: boolean }) {
  const { isShow } = props;
  const { appMode, pivotMode, mode } = useAppSelector((state) => ({
    appMode: state.app.mode,
    pivotMode: state.animator.pivotMode,
    mode: state.animator.mode,
  }));

  const panelConfig = useMemo(() => {
    return PANEL_CONFIG[getPanelConfigKey(appMode, mode)];
  }, [appMode, mode]);
  const isOnePanel = panelConfig.length === 1;

  const sharedTipsDelay = useSharedTipsDelay();

  const containerRef = useRef<HTMLDivElement | null>(null);

  const paletteRef = useRef<HTMLDivElement | null>(null);
  const { onTabDown: onPaletteTabDown } = useFocusTrap(paletteRef);

  const hierarchyRef = useRef<HTMLDivElement | null>(null);
  const { onTabDown: onHierarchyTabDown } = useFocusTrap(hierarchyRef);

  const paramRef = useRef<HTMLDivElement | null>(null);
  const { onTabDown: onParamTabDown } = useFocusTrap(paramRef);

  const [heights, setHeights] = useState<number[]>([]);
  const dragStartState = useRef<DragStartState>();
  // 面板折叠前的高度
  const heightCache = useRef<{
    [id: number]: number | undefined;
  }>({});

  const getPanelHeight = useCallback(
    (panelId: PANEL_IDS) => {
      if (isOnePanel) {
        return '100%';
      }

      return heights[panelId];
    },
    [heights, isOnePanel],
  );

  const isCollapsed = useCallback((h: number) => {
    return h === 0 || h === COLLAPSED_HEIGHT;
  }, []);

  const shrinkPanels = useCallback(
    (
      growPanel: number,
      diff: number,
      shrinkList: number[],
      curHeights: number[],
      newHeights: number[],
    ) => {
      let shrinkIndex = 0;
      while (shrinkIndex < shrinkList.length) {
        const shrinkPanel = shrinkList[shrinkIndex];
        const curDiff = curHeights[shrinkPanel] - MIN_HEIGHTS[shrinkPanel];

        if (curDiff >= diff) {
          newHeights[growPanel] = newHeights[growPanel] + diff;
          newHeights[shrinkPanel] = curHeights[shrinkPanel] - diff;
          break;
        }

        // 当前shrinkPanel压缩到最小高度，growPanel增加对应的高度差
        newHeights[growPanel] = newHeights[growPanel] + curDiff;
        newHeights[shrinkPanel] = MIN_HEIGHTS[shrinkPanel];

        // 下一个面板还需要压缩的高度
        diff = diff - curDiff;
        shrinkIndex++;
      }
    },
    [],
  );

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const { offsetHeight } = containerRef.current;

    // 容器到达最小高度之后，开始裁剪
    const containerHeight = Math.max(MIN_HEIGHTS_TOTAL, offsetHeight);

    // 默认高度：色板和参数面板定高，剩余高度是部件列表
    const heights = [
      PALETTE_DEFAULT_HEIGHT,
      containerHeight - PALETTE_DEFAULT_HEIGHT - PARAM_DEFAULT_HEIGHT,
      PARAM_DEFAULT_HEIGHT,
    ];
    const newHeights = [...heights];
    // 如果list高度不够，压缩色板
    const diff = MIN_HEIGHTS[PANEL_IDS.list] - heights[PANEL_IDS.list];
    if (diff > 0) {
      shrinkPanels(
        PANEL_IDS.list,
        diff,
        [PANEL_IDS.palette],
        heights,
        newHeights,
      );
    }
    setHeights(newHeights);

    prevContainerHeight.current = offsetHeight;
  }, [shrinkPanels]);

  const prevContainerHeight = useRef<number>(0);

  /**
   * 获得在拖拽/折叠时可以被改变高度（即没有被折叠）的所有面板序号
   */
  const getAffectedPanels = useCallback(
    (panelId: number) => {
      let abovePanels: number[] = [];
      for (let i = panelId - 1; i >= 0; i--) {
        if (heightCache.current[i] === undefined) {
          abovePanels.push(i);
        }
      }

      let belowPanels: number[] = [];
      for (let i = panelId; i <= DEFAULT_ACTIVE_IDS.length - 1; i++) {
        if (heightCache.current[i] === undefined) {
          belowPanels.push(i);
        }
      }
      return {
        above: abovePanels,
        below: belowPanels,
      };
    },
    [heightCache],
  );

  const onDragStart = useCallback(
    (e: React.MouseEvent, panelIndex: number) => {
      const draggablePanels = getAffectedPanels(panelIndex);
      if (!draggablePanels) {
        return;
      }
      dragStartState.current = {
        above: draggablePanels.above,
        below: draggablePanels.below,
        startY: e.clientY,
        startHeights: [...heights],
      };
    },
    [getAffectedPanels, heights],
  );

  const onDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!dragStartState.current) {
        return;
      }
      const { above, below, startY, startHeights } = dragStartState.current;

      // 如果拖拽杆上方或下方没有可改变高度的面板，则禁止拖拽
      if (!above.length || !below.length) {
        return;
      }
      const newHeights = [...startHeights];

      let diff = startY - e.clientY;
      // 当前被拉伸的面板
      let growPanel: number;
      // 所有可被压缩的面板
      let shrinkList: number[];

      if (diff > 0) {
        growPanel = below[0];
        shrinkList = above;
      } else {
        growPanel = above[0];
        shrinkList = below;
        diff = -diff;
      }

      shrinkPanels(growPanel, diff, shrinkList, startHeights, newHeights);
      setHeights(newHeights);
    },
    [dragStartState, shrinkPanels],
  );

  const onDragEnd = useCallback(() => {
    dragStartState.current = undefined;
  }, []);

  const onPanelChange = useCallback(
    (panelId: number, isExpanded: boolean, noHeader: boolean = false) => {
      const { above, below } = getAffectedPanels(panelId);

      const newHeights = [...heights];

      // 当前面板折叠后的高度，可能去除header
      const panelHeight = noHeader ? 0 : COLLAPSED_HEIGHT;

      if (!isExpanded) {
        // 当前面板还未完成折叠，被计入below中，先把它移除
        below.splice(0, 1);

        // 保存被折叠面板当前的高度
        heightCache.current[panelId] = heights[panelId];

        // 折叠当前面板
        newHeights[panelId] = panelHeight;

        // 没有可以被拉伸的面板，只改变自身高度
        if (!above.length && !below.length) {
          setHeights(newHeights);
          return newHeights;
        }

        const diff = heights[panelId] - panelHeight;

        // 优先拉伸上面的面板
        if (above.length) {
          newHeights[above[0]] = heights[above[0]] + diff;
          setHeights(newHeights);
          return newHeights;
        }

        if (below.length) {
          newHeights[below[0]] = heights[below[0]] + diff;
          setHeights(newHeights);
        }
        return newHeights;
      }

      // 没有可以被压缩的面板，则当前面板撑满整个容器高度
      if (!above.length && !below.length) {
        if (containerRef.current) {
          let maxHeight = containerRef.current.offsetHeight;
          heights.forEach((h, index) => {
            if (panelId !== index) {
              maxHeight -= h;
            }
          });
          newHeights[panelId] = maxHeight;
        }
        setHeights(newHeights);
        // 从cache中删除
        heightCache.current[panelId] = undefined;
        return newHeights;
      }

      // 恢复被折叠前的高度
      const cachedHeight = heightCache.current[panelId] || MIN_HEIGHTS[panelId];

      let diff = cachedHeight - panelHeight;

      // 从cache中删除
      heightCache.current[panelId] = undefined;

      // 优先压缩上面的面板，空间不够的话再压缩下面的面板
      const panels = [...above, ...below];
      shrinkPanels(panelId, diff, panels, heights, newHeights);
      setHeights(newHeights);
      return newHeights;
    },
    [getAffectedPanels, heightCache, heights, shrinkPanels],
  );

  const resize = useMemo(() => {
    return debounce(() => {
      if (isOnePanel || !containerRef.current) {
        return;
      }

      let curHeights = [...heights];

      DEFAULT_ACTIVE_IDS.forEach((panelId) => {
        const hasPanel = panelConfig.includes(panelId);

        // 隐藏不需要的面板
        if (!hasPanel && curHeights[panelId] !== 0) {
          curHeights = onPanelChange(panelId, false, true);
        }

        // 显示需要的面板
        if (hasPanel && curHeights[panelId] === 0) {
          curHeights = onPanelChange(panelId, true, true);
        }
      });

      const height = containerRef.current.offsetHeight;

      let totalDiff = height - prevContainerHeight.current;

      let minContainerHeight = 0;
      heights.forEach((h, index) => {
        if (isCollapsed(h)) {
          minContainerHeight += h;
        } else {
          minContainerHeight += MIN_HEIGHTS[index];
        }
      });

      if (
        !totalDiff ||
        (height <= minContainerHeight &&
          prevContainerHeight.current <= minContainerHeight)
      ) {
        return;
      }

      let newHeights = [...curHeights];
      let num = curHeights.filter((h) => !isCollapsed(h)).length;

      // 计算每个面板平均要增加的大小，用ceil是因为优先保证前面的面板拿到更多的空间
      const average = Math.ceil(totalDiff / num);

      let consumed = 0;

      if (totalDiff > 0) {
        curHeights.forEach((h, index) => {
          if (isCollapsed(h)) {
            return;
          }

          const diff = Math.min(average, totalDiff - consumed);
          consumed += diff;

          newHeights[index] = h + diff;
        });
        prevContainerHeight.current = height;
        setHeights(newHeights);
        return;
      }

      // 计算面板剩余的可压缩空间
      const availableSpaces: { index: number; availableSpace: number }[] = [];
      curHeights.forEach((h, index) => {
        if (isCollapsed(h)) {
          return;
        }
        availableSpaces.push({
          index: index,
          availableSpace: h - MIN_HEIGHTS[index],
        });
      });

      // 根据剩余空间从小到大排序
      availableSpaces.sort((a, b) => {
        return a.availableSpace - b.availableSpace;
      });

      availableSpaces.forEach(({ index }) => {
        let diff = Math.round(totalDiff / num);

        if (newHeights[index] + diff < MIN_HEIGHTS[index]) {
          diff = MIN_HEIGHTS[index] - newHeights[index];
          newHeights[index] = MIN_HEIGHTS[index];
        } else {
          newHeights[index] = newHeights[index] + diff;
        }

        // 减去当前面板已压缩的高度，剩余diff由剩余面板平分
        totalDiff -= diff;
        num--;
      });

      prevContainerHeight.current =
        height > minContainerHeight ? height : minContainerHeight;
      setHeights(newHeights);
    }, RESIZE_DEBOUNCE_TIME);
  }, [isOnePanel, heights, panelConfig, onPanelChange, isCollapsed]);

  const cachedResize = useResizeObserver(containerRef.current, resize);

  useEffect(() => {
    if (!isOnePanel) {
      cachedResize.current(true);
    }
  }, [isOnePanel, cachedResize]);

  // 在右边栏以外的地方抬手时，也需要结束拖拽。否则抬手再回来的时候会保持拖拽状态
  useEventListener('mouseup', onDragEnd);

  const className = useMemo(() => {
    const rightPanelClassName = [style.rightPanel];
    if (!isShow) {
      rightPanelClassName.push(style.hide);
    }
    return rightPanelClassName.join(' ');
  }, [isShow]);

  return (
    <SharedTipsContext.Provider value={sharedTipsDelay}>
      <div className={className} onMouseMove={onDrag}>
        <div
          ref={containerRef}
          style={{
            height: '100%',
            minHeight: isMobile() ? `${MIN_HEIGHTS_TOTAL}px` : undefined,
          }}
        >
          <Collapse
            activeIds={!isOnePanel ? undefined : DEFAULT_ACTIVE_IDS}
            defaultActiveIds={DEFAULT_ACTIVE_IDS}
            expandIcon={'#icon-list-dropup'}
            disabled={pivotMode !== PivotMode.None}
            onMouseLeave={() => {
              sharedTipsDelay.setDisplayed(false);
            }}
            onArrowClicked={onPanelChange}
          >
            {panelConfig.includes(PANEL_IDS.palette) && (
              <div
                ref={paletteRef}
                onKeyDown={onPaletteTabDown}
                className={style.panel}
                style={{
                  height: getPanelHeight(PANEL_IDS.palette),
                }}
              >
                <Palette
                  panelId={PANEL_IDS.palette}
                  height={PANEL_CONTENT_HEIGHT}
                />
              </div>
            )}

            {panelConfig.includes(PANEL_IDS.list) && (
              <div
                ref={hierarchyRef}
                onKeyDown={onHierarchyTabDown}
                className={style.panel}
                style={{
                  height: getPanelHeight(PANEL_IDS.list),
                }}
              >
                {panelConfig.indexOf(PANEL_IDS.list) !== 0 && (
                  <div
                    className={style.resizeHandle}
                    onMouseDown={(e) => onDragStart(e, PANEL_IDS.list)}
                  />
                )}
                <Hierarchy
                  panelId={PANEL_IDS.list}
                  height={PANEL_CONTENT_HEIGHT}
                />
              </div>
            )}

            {panelConfig.includes(PANEL_IDS.parameter) && (
              <div
                ref={paramRef}
                onKeyDown={onParamTabDown}
                className={style.panel}
                style={{
                  height: getPanelHeight(PANEL_IDS.parameter),
                }}
              >
                {panelConfig.indexOf(PANEL_IDS.parameter) !== 0 && (
                  <div
                    className={style.resizeHandle}
                    onMouseDown={(e) => onDragStart(e, PANEL_IDS.parameter)}
                  />
                )}
                <ParamPanel panelId={PANEL_IDS.parameter} />
              </div>
            )}
          </Collapse>
        </div>
      </div>
    </SharedTipsContext.Provider>
  );
}
