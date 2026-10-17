import { Object3D } from './objects/object3d';

export interface RenderItem {
  object: Object3D;
  z?: number;
}

export class WebGLRenderList {
  public opaque: RenderItem[] = [];
  public transparent: RenderItem[] = [];

  public init() {
    this.opaque.length = 0;
    this.transparent.length = 0;
  }

  public push(object: Object3D, z?: number) {
    if (object.material?.transparent) {
      this.transparent.push({
        object: object,
        z: z,
      });
    } else {
      this.opaque.push({
        object: object,
        z: z,
      });
    }
  }

  /**
   * 对渲染队列进行排序
   */
  public sort() {
    this.transparent.length && this.transparent.sort(this.sortTransparentItems);
    this.opaque.length && this.opaque.sort(this.sortOpaqueItems);
  }

  /**
   * 透明物体根据renderOrder排序，renderOrder相同的，根据与摄像机距离从远到近排序。
   */
  private sortTransparentItems(a: RenderItem, b: RenderItem) {
    if (a.object.getRenderOrder() !== b.object.getRenderOrder()) {
      return a.object.getRenderOrder() - b.object.getRenderOrder();
    } else if (b.z !== undefined && a.z !== undefined) {
      return b.z - a.z;
    }
    return 0;
  }

  /**
   * 不透明物体根据renderOrder排序，renderOrder相同的，根据与摄像机距离从近到远排序（和透明物体相反）。
   */
  private sortOpaqueItems(a: RenderItem, b: RenderItem) {
    if (a.object.getRenderOrder() !== b.object.getRenderOrder()) {
      return a.object.getRenderOrder() - b.object.getRenderOrder();
    } else if (b.z !== undefined && a.z !== undefined) {
      return a.z - b.z;
    }
    return 0;
  }
}
