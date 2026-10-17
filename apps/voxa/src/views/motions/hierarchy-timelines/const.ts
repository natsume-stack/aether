/**
 * 时间轴左右侧的padding
 */
export const TIMELINE_PADDING = 8;

/**
 * 每条时间轴的高度
 */
export const TIMELINE_HEIGHT = 28;

/**
 * 节点列表的宽度 + margin-right
 */
export const HIERARCHY_WIDTH = 160 + 1;

/**
 * 时间刻度的高度
 */
export const TIME_SCALE_HEIGHT = 28;

/**
 * 播控栏的高度
 */
export const TIME_CONTROLS_HEIGHT = 31;

/**
 * 时间轴可缩放的最大的宽度 = (24px的间距 + 1px刻度线) x 24帧 x 60秒 + 1px刻度线
 */
export const MAX_ZOOM_WIDTH = (24 + 1) * 24 * 60 + 1;

/**
 * 时间轴默认的缩放宽度 = (8px的间距 + 1px刻度线) x 24帧 x 60秒 + 1px刻度线
 */
export const DEFAULT_ZOOM_WIDTH = (8 + 1) * 24 * 60 + 1;

/**
 * 当时间刻度上，相邻刻度值的面板小于该数值时，跳秒显示
 */
export const SKIP_TIME_WIDTH = 24;

/**
 * 当帧段的宽度小于该数值时，帧段隐藏补帧类型
 */
export const HIDE_INTERPOLATION = 16;
