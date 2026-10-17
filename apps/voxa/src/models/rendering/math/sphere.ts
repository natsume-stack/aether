import { mat4, vec3 } from 'gl-matrix';
import { Box3 } from './box3';

const BOX = new Box3();

export class Sphere {
  constructor(public center = vec3.create(), public radius = -1) {}

  public set(center: vec3, radius: number) {
    vec3.copy(this.center, center);
    this.radius = radius;
    return this;
  }

  public copy(sphere: Sphere) {
    vec3.copy(this.center, sphere.center);
    this.radius = sphere.radius;

    return this;
  }

  private getMaxScaleOnAxis(matrix: mat4) {
    const scaleXSq =
      matrix[0] * matrix[0] + matrix[1] * matrix[1] + matrix[2] * matrix[2];
    const scaleYSq =
      matrix[4] * matrix[4] + matrix[5] * matrix[5] + matrix[6] * matrix[6];
    const scaleZSq =
      matrix[8] * matrix[8] + matrix[9] * matrix[9] + matrix[10] * matrix[10];

    return Math.sqrt(Math.max(scaleXSq, scaleYSq, scaleZSq));
  }

  public applyMatrix4(matrix: mat4) {
    vec3.transformMat4(this.center, this.center, matrix);
    this.radius = this.radius * this.getMaxScaleOnAxis(matrix);

    return this;
  }

  public setFromPoints(points: vec3[], optionalCenter?: vec3) {
    const center = this.center;

    if (optionalCenter !== undefined) {
      vec3.copy(center, optionalCenter);
    } else {
      BOX.setFromPoints(points).getCenter(center);
    }

    let maxRadiusSq = 0;

    for (let i = 0, il = points.length; i < il; i++) {
      maxRadiusSq = Math.max(
        maxRadiusSq,
        vec3.squaredDistance(center, points[i]),
      );
    }

    this.radius = Math.sqrt(maxRadiusSq);

    return this;
  }

  public containsPoint(point: vec3) {
    return (
      vec3.squaredDistance(point, this.center) <= this.radius * this.radius
    );
  }

  public distanceToPoint(point: vec3) {
    return vec3.distance(point, this.center) - this.radius;
  }

  public isEmpty() {
    return this.radius < 0;
  }

  public makeEmpty() {
    vec3.set(this.center, 0, 0, 0);
    this.radius = -1;
    return this;
  }
}
