import { vec4 } from 'gl-matrix';
import { Object3D, Object3DType } from './object3d';

/**
 * 场景对象，通常同时只存在一个
 */
export class Scene extends Object3D {
  public readonly type: Object3DType = Object3DType.Scene;
  public readonly backgroundColor: vec4 = vec4.create();

  public setBackgroundColor(color: vec4) {
    vec4.copy(this.backgroundColor, color);
  }
}
