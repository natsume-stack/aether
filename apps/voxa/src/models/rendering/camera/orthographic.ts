import { mat4, vec3 } from 'gl-matrix';
import { Object3DType } from '../objects/object3d';
import { Camera, ViewType } from './base';

export class OrthographicCamera extends Camera {
  public readonly type: Object3DType = Object3DType.OrthographicCamera;

  constructor(
    public aspect = 1.5,
    public frustumHeight = 100,
    public near = 1,
    public far = 1024,
  ) {
    super();

    this.updateProjectionMatrix();
  }

  public copy(source: OrthographicCamera, recursive: boolean) {
    super.copy(source, recursive);

    this.frustumHeight = source.frustumHeight;
    this.aspect = source.aspect;
    this.near = source.near;
    this.far = source.far;

    this.zoom = source.zoom;
    this.view = source.view ?? Object.assign({}, source.view);

    return this;
  }

  public setViewOffset(view: ViewType): void {
    this.view = view;
    this.updateProjectionMatrix();
  }

  public getFixedScale(out: vec3): vec3 {
    return vec3.scale(out, [1, 1, 1], this.aspect / this.zoom);
  }

  /**
   * let fov = 45degree
   * let camera-target distance D
   * --> frustum size = 2 * D * tan(45 / 2)
   */
  private updateFrustumHeight(): void {
    const distance = vec3.distance(this.position, this.target);
    this.frustumHeight = 2 * distance * Math.tan(Math.PI / 8);
  }

  public updateProjectionMatrix(): void {
    this.updateFrustumHeight();
    const dx = (this.frustumHeight * this.aspect) / (2 * this.zoom);
    const dy = this.frustumHeight / (2 * this.zoom);

    let left = -dx;
    let right = dx;
    let top = dy;
    let bottom = -dy;

    if (this.view !== undefined) {
      const scaleW =
        (this.frustumHeight * this.aspect) / this.view.fullWidth / this.zoom;
      const scaleH = this.frustumHeight / this.view.fullHeight / this.zoom;

      left += scaleW * this.view.offsetX;
      right = left + scaleW * this.view.width;
      top -= scaleH * this.view.offsetY;
      bottom = top - scaleH * this.view.height;
    }

    mat4.ortho(
      this.projectionMatrix,
      left,
      right,
      bottom,
      top,
      this.near,
      this.far,
    );

    mat4.invert(this.projectionMatrixInverse, this.projectionMatrix);
  }
}
