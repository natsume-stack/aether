import { vec3 } from 'gl-matrix';

/**
 * 双击数据保留时间，超过该时间，则不视为双击。
 */
export const DBL_CLICK_PRESERVE_TIME = 500;

/**
 * 双击/右键的判定距离
 * 超过该距离，则不视为双击/右键。
 */
export const CLICK_OFFSET_THRESHOLD = 10;

export const DEFAULT_POS = vec3.fromValues(-1, -1, -1);
