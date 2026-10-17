import { quat, vec3 } from 'gl-matrix';

/**
 * 旋转、位移、缩放、以及透明度
 */
export type TransformAlpha = {
  position: vec3;
  quaternion: quat;
  scale: vec3;
  alpha: number;
};

/**
 * 缓存关键帧的位移、旋转、透明度的绝对数据
 */
export class KeyframeCaches {
  private map = new Map<string, TransformAlpha>();

  /**
   * 更新或增加对应动作、对应节点、对应时间的绝对值缓存
   */
  public addTransformAlpha(keyframeId: string, transformAlpha: TransformAlpha) {
    let originTransformAlpha = this.map.get(keyframeId);

    if (originTransformAlpha) {
      vec3.copy(originTransformAlpha.position, transformAlpha.position);
      quat.copy(originTransformAlpha.quaternion, transformAlpha.quaternion);
      vec3.copy(originTransformAlpha.scale, transformAlpha.scale);
      originTransformAlpha.alpha = transformAlpha.alpha;
    } else {
      originTransformAlpha = {
        position: vec3.clone(transformAlpha.position),
        quaternion: quat.clone(transformAlpha.quaternion),
        scale: vec3.clone(transformAlpha.scale),
        alpha: transformAlpha.alpha,
      };

      this.map.set(keyframeId, originTransformAlpha);
    }

    return originTransformAlpha;
  }

  /**
   * 查询对应动作、对应节点、对应时间点的绝对值缓存
   */
  public getTransformAlpha(keyframeId: string): TransformAlpha | undefined {
    return this.map.get(keyframeId);
  }

  public clear() {
    this.map.clear();
  }

  public delete(keyframeId: string) {
    this.map.delete(keyframeId);
  }
}
