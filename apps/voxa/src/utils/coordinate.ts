import { vec2, vec3 } from 'gl-matrix';
import type { Camera } from '../models/rendering/camera/base';

type ElementRect = {
  width: number;
  height: number;
  top: number;
  left: number;
};

/**
 * 把世界坐标转换成裁剪空间的坐标。
 */
export function worldPosToClipPos(out: vec3, vertex: vec3, camera: Camera) {
  return vec3.transformMat4(out, vertex, camera.viewProjection);
}

/**
 * 计算裁剪空间坐标的屏幕坐标
 */
export function clipPosToScreenPos(
  out: vec2,
  clipPos: vec3,
  elementRect: ElementRect,
) {
  const { width, height, top, left } = elementRect;

  out[0] = ((clipPos[0] + 1) * width) / 2 + left;
  out[1] = ((clipPos[1] - 1) * height) / -2 + top;

  return out;
}

/**
 * 将屏幕坐标转换为裁剪坐标
 */
export function screenPosToClipPos(
  out: vec2,
  screenPos: vec2,
  elementRect: ElementRect,
): vec2 {
  const { width, height, top, left } = elementRect;

  const [x, y] = screenPos;

  out[0] = (2 * (x - left)) / width - 1;
  out[1] = (-2 * (y - top)) / height + 1;

  return out;
}
