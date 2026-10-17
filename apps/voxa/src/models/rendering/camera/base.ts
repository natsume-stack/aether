import { mat4, vec3 } from 'gl-matrix';
import { Object3D, Object3DType } from '../objects/object3d';

export type ViewType = {
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

export type CameraSnapshot = {
  position: vec3;
  target: vec3;
  zoom: number;
};

export abstract class Camera extends Object3D {
  /**
   * 当前共有两种摄像机模式
   * 1. perspective camera, 透视模式
   * 2. orthographic camera, 正视模式
   * 默认为透视模式
   */
  public readonly type: Object3DType = Object3DType.PerspectiveCamera;
  public target = vec3.fromValues(0, 0, 0);
  public zoom: number = 1;
  public near: number = 1;
  public far: number = 1024;
  public view: ViewType | undefined = undefined;
  public aspect: number = 1.5;

  /**
   * 世界变换坐标，用于将本地坐标转换为世界坐标
   */
  public matrixWorld = mat4.create();

  public matrixWorldInverse = mat4.create();
  public viewMatrix = mat4.create();
  public viewMatrixInverse = mat4.create();
  public projectionMatrix = mat4.create();
  public projectionMatrixInverse = mat4.create();
  public viewProjection = mat4.create();
  public invViewProjection = mat4.create();

  constructor() {
    super();
  }

  public copy(source: Camera, recursive: boolean) {
    super.copy(source, recursive);

    mat4.copy(this.matrixWorldInverse, source.matrixWorldInverse);
    mat4.copy(this.projectionMatrix, source.projectionMatrix);
    mat4.copy(this.projectionMatrixInverse, source.projectionMatrixInverse);

    return this;
  }

  public getWorldDirection(out: vec3) {
    this.updateWorldMatrix(true, false);
    const x = -this.matrixWorld[8];
    const y = -this.matrixWorld[9];
    const z = -this.matrixWorld[10];
    return vec3.normalize(out, vec3.fromValues(x, y, z));
  }

  public updateMatrixWorld(): void {
    super.updateMatrixWorld();
    mat4.invert(this.matrixWorldInverse, this.matrixWorld);
  }

  public updateWorldMatrix(updateParents: boolean, updateChildren: boolean) {
    super.updateWorldMatrix(updateParents, updateChildren);

    mat4.invert(this.matrixWorldInverse, this.matrixWorld);
  }

  public lookAt(target: vec3) {
    super.lookAt(target);

    mat4.lookAt(this.viewMatrix, this.position, target, this.up);
    mat4.invert(this.viewMatrixInverse, this.viewMatrix);
    mat4.mul(this.viewProjection, this.projectionMatrix, this.viewMatrix);
    mat4.invert(this.invViewProjection, this.viewProjection);

    vec3.copy(this.target, target);
  }

  public getSnapshot(): CameraSnapshot {
    return {
      position: vec3.clone(this.position),
      target: vec3.clone(this.target),
      zoom: this.zoom,
    };
  }

  public sync(source: CameraSnapshot): void {
    const { position, target, zoom } = source;

    this.setPosition(position);
    this.lookAt(target);
    this.zoom = zoom;
    this.updateProjectionMatrix();
  }

  public abstract setViewOffset(view: ViewType): void;

  /**
   * 通过某物体世界坐标，获取此时相对摄像机屏幕保持固定大小的缩放值
   * @param out 输出缩放值
   * @param worldPosition 某世界坐标
   */
  public abstract getFixedScale(out: vec3, worldPosition: vec3): vec3;

  public clearViewOffset() {
    this.view = undefined;
    this.updateProjectionMatrix();
  }

  public abstract updateProjectionMatrix(): void;
}
