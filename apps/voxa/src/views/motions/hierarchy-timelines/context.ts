import { createContext, MouseEvent } from 'react';

export type TimelineState = {
  /**
   * 缩放的最小宽度 = 面板可视区域宽度 - padding
   */
  minZoomWidth: number;

  /**
   * 时间刻度中，每秒的宽度
   */
  secondWidth: number;

  /**
   * 面板的高度
   */
  height: number;

  /**
   * 关键帧的样式数据
   */
  keyframe: {
    width: number;
    /**
     * 绘制形状向左偏移的量
     */
    offsetLeft: number;
    /**
     * 关键帧的间隔
     */
    gap: number;
  };
};

export interface TimelineContextType extends TimelineState {
  /**
   * 时间轴水平滚动属性
   */
  scrollbar: Scrollbar;
  /**
   * 更新水平滚动属性
   */
  setScrollbar: SetScrollbar;
  /**
   * 设置选中的关键帧id
   */
  onItemSelect: OnItemSelect;
  /**
   * 开始拖拽关键帧
   */
  onDragItemStart: OnItemDragStart;
  /**
   * 设置时间轴缩放相关数据
   */
  setTimelineState: React.Dispatch<React.SetStateAction<TimelineState>>;
  /**
   * 通过鼠标事件中鼠标横坐标，计算对应的关键帧
   */
  calculateFrameByClientX: CalculateFrameByClientX;
}

/**
 * 时间刻度的属性
 */
export type ScaleValueProps = {
  /**
   * 每秒之间的刻度数量数，包含秒本身
   */
  mark: number;
  /**
   * 要被高亮的刻度。
   */
  highlight: number;
  /**
   * 第几个时是刻度值
   */
  value: number;
  /**
   * 刻度值之间的步长，单位秒
   */
  valueStep: number;
};

export type Scrollbar = {
  /**
   * 可滚动的宽度，不包含滚动区域本身的宽度
   */
  range: number;
  /**
   * 滚动的距离
   */
  scrollLeft: number;
  /**
   * 可视区域占整个滚动区域的大小
   * 用于计算滚动条滑块的宽度
   */
  visibleRatio: number;
  /**
   * 滚动条起点位置的左侧距离，用于计算拖拽指针时的位置
   */
  left: number;
  /**
   * 滚动条的完整宽度
   */
  scrollWidth: number;
};

type SetScrollbar = React.Dispatch<React.SetStateAction<Scrollbar>>;

export type OnItemSelect = (
  evt: MouseEvent,
  ids: string[],
  nodeId: string,
  selected: boolean,
) => void;

export type OnItemDragStart = (evt: React.MouseEvent) => void;

/**
 * 根据鼠标事件中的x坐标，计算对应的关键帧
 */
export type CalculateFrameByClientX = (x: number) => number;

export const initialContextValue: TimelineContextType = {
  minZoomWidth: 0,
  secondWidth: 0,
  height: 0,
  keyframe: {
    width: 7,
    offsetLeft: 3,
    gap: 9,
  },
  scrollbar: {
    visibleRatio: 0,
    range: 0,
    scrollLeft: 0,
    left: 0,
    scrollWidth: 0,
  },
  setTimelineState: () => {},
  setScrollbar: () => {},
  onItemSelect: () => {},
  onDragItemStart: () => {},
  calculateFrameByClientX: () => 0,
};

export const TimelineContext =
  createContext<TimelineContextType>(initialContextValue);
