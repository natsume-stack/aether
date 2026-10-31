import { mat4, vec3 } from 'gl-matrix';
import { Object3DType } from '../objects/object3d';
import { Camera, ViewType } from './base';

const RAD2DEG = 180 / Math.PI;

export class PerspectiveCamera extends Camera {
  public readonly type: Object3DType = Object3DType.PerspectiveCamera;
  /**
   *  Width of the film (default in millimeters)
   */
  private filmGauge = 35;
  /**
   * Horizontal film offset (same unit as gauge)
   */
  private filmOffset = 0;

  constructor(
    /**
     * FOV in radian
     */
    public fov = Math.PI / 4,
    public aspect = 1.5,
    public near = 1,
    public far = 1024,
  ) {
    super();

    this.updateProjectionMatrix();
  }

  public copy(source: PerspectiveCamera, recursive: boolean) {
    super.copy(source, recursive);

    this.fov = source.fov;
    this.zoom = source.zoom;

    this.near = source.near;
    this.far = source.far;

    this.aspect = source.aspect;
    this.view = source.view ?? Object.assign({}, source.view);

    this.filmGauge = source.filmGauge;
    this.filmOffset = source.filmOffset;

    return this;
  }

  /**
   * Calculates the focal length from the current .fov and .filmGauge.
   */
  public getFocalLength() {
    const vExtentSlope = Math.tan(0.5 * this.fov);

    return (0.5 * this.getFilmHeight()) / vExtentSlope;
  }

  public getEffectiveFOV() {
    return RAD2DEG * 2 * Math.atan(Math.tan(0.5 * this.fov) / this.zoom);
  }

  public getFilmWidth() {
    // film not completely covered in portrait format (aspect < 1)
    return this.filmGauge * Math.min(this.aspect, 1);
  }

  public getFilmHeight() {
    // film not completely covered in landscape format (aspect > 1)
    return this.filmGauge / Math.max(this.aspect, 1);
  }

  public setViewOffset(view: ViewType): void {
    this.view = view;
    const { fullWidth, fullHeight } = view;
    this.aspect = fullWidth / fullHeight;

    this.updateProjectionMatrix();
  }

  public getFixedScale(out: vec3, worldPosition: vec3): vec3 {
    const dist = vec3.distance(worldPosition, this.position);
    const fovEuler = ((this.fov / 2) * Math.PI) / 180;

    const factor = dist * Math.tan(fovEuler) * 2;

    return vec3.scale(out, [1, 1, 1], factor);
  }

  public updateProjectionMatrix() {
    const near = this.near;
    let top = (near * Math.tan(0.5 * this.fov)) / this.zoom;
    let height = 2 * top;
    let width = this.aspect * height;
    let left = -0.5 * width;
    const view = this.view;

    if (view !== undefined) {
      const fullWidth = view.fullWidth,
        fullHeight = view.fullHeight;

      left += (view.offsetX * width) / fullWidth;
      top -= (view.offsetY * height) / fullHeight;
      width *= view.width / fullWidth;
      height *= view.height / fullHeight;
    }

    const skew = this.filmOffset;
    if (skew !== 0) left += (near * skew) / this.getFilmWidth();

    mat4.perspective(
      this.projectionMatrix,
      this.fov,
      this.aspect,
      this.near,
      this.far,
    );

    mat4.invert(this.projectionMatrixInverse, this.projectionMatrix);
  }
}
