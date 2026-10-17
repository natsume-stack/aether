import { mat3, ReadonlyMat4, ReadonlyVec3, vec3 } from 'gl-matrix';
import { Box3 } from './box3';
import { Plane } from './plane';
import { Sphere } from './sphere';

/**
 * Temp
 */
const _vector = /*@__PURE__*/ vec3.create();

export class Ray {
  constructor(
    public origin = vec3.create(),
    public direction = vec3.fromValues(0, 0, -1),
  ) {
    this.origin = origin;
    this.direction = direction;
  }

  public copy(ray: Ray) {
    vec3.copy(this.origin, ray.origin);
    vec3.copy(this.direction, ray.direction);

    return this;
  }

  public set(origin: ReadonlyVec3, direction: ReadonlyVec3) {
    vec3.copy(this.origin, origin);
    vec3.copy(this.direction, direction);

    return this;
  }

  /**
   *
   * @param t
   * @param out out
   * @returns
   */
  public at(out: vec3, t: number) {
    return vec3.scaleAndAdd(out, this.origin, this.direction, t);
  }

  public applyMatrix4(matrix4: ReadonlyMat4) {
    vec3.transformMat4(this.origin, this.origin, matrix4);

    const dMat3 = mat3.create();
    mat3.fromMat4(dMat3, matrix4);
    vec3.transformMat3(this.direction, this.direction, dMat3);
    vec3.normalize(this.direction, this.direction);

    return this;
  }

  public distanceSqToPoint(point: vec3) {
    const _v = vec3.create();

    vec3.sub(_v, point, this.origin);
    const directionDistance = vec3.dot(_v, this.direction);

    // point behind the ray

    if (directionDistance < 0) {
      return vec3.sqrDist(this.origin, point);
    }

    vec3.scaleAndAdd(_v, this.origin, this.direction, directionDistance);

    return vec3.sqrDist(_v, point);
  }

  public intersectsBox(box: Box3) {
    return this.intersectBox(box, _vector) !== null;
  }

  public intersectsSphere(sphere: Sphere) {
    return (
      this.distanceSqToPoint(sphere.center) <= sphere.radius * sphere.radius
    );
  }

  /**
   *
   * @param box
   * @param target out
   * @returns
   */
  public intersectBox(box: Box3, target: vec3) {
    let tmin: number,
      tmax: number,
      tymin: number,
      tymax: number,
      tzmin: number,
      tzmax: number;

    const invdirx = 1 / this.direction[0],
      invdiry = 1 / this.direction[1],
      invdirz = 1 / this.direction[2];

    const origin = this.origin;

    if (invdirx >= 0) {
      tmin = (box.min[0] - origin[0]) * invdirx;
      tmax = (box.max[0] - origin[0]) * invdirx;
    } else {
      tmin = (box.max[0] - origin[0]) * invdirx;
      tmax = (box.min[0] - origin[0]) * invdirx;
    }

    if (invdiry >= 0) {
      tymin = (box.min[1] - origin[1]) * invdiry;
      tymax = (box.max[1] - origin[1]) * invdiry;
    } else {
      tymin = (box.max[1] - origin[1]) * invdiry;
      tymax = (box.min[1] - origin[1]) * invdiry;
    }

    if (tmin > tymax || tymin > tmax) return null;

    // These lines also handle the case where tmin or tmax is NaN
    // (result of 0 * Infinity). x !== x returns true if x is NaN

    if (tymin > tmin || tmin !== tmin) tmin = tymin;

    if (tymax < tmax || tmax !== tmax) tmax = tymax;

    if (invdirz >= 0) {
      tzmin = (box.min[2] - origin[2]) * invdirz;
      tzmax = (box.max[2] - origin[2]) * invdirz;
    } else {
      tzmin = (box.max[2] - origin[2]) * invdirz;
      tzmax = (box.min[2] - origin[2]) * invdirz;
    }

    if (tmin > tzmax || tzmin > tmax) return null;

    if (tzmin > tmin || tmin !== tmin) tmin = tzmin;

    if (tzmax < tmax || tmax !== tmax) tmax = tzmax;

    //return point closest to the ray (positive side)

    if (tmax < 0) return null;

    return this.at(target, tmin >= 0 ? tmin : tmax);
  }

  public distanceToPlane(plane: Plane) {
    const denominator = vec3.dot(plane.normal, this.direction);

    if (denominator === 0) {
      // line is coplanar, return origin
      if (plane.distanceToPoint(this.origin) === 0) {
        return 0;
      }

      // Null is preferable to undefined since undefined means.... it is undefined

      return undefined;
    }

    const t =
      -(vec3.dot(this.origin, plane.normal) + plane.constant) / denominator;

    // Return if the ray never intersects the plane
    return t >= 0 ? t : undefined;
  }

  public intersectPlane(out: vec3, plane: Plane) {
    const t = this.distanceToPlane(plane);

    if (t === undefined) {
      return;
    }

    return this.at(out, t);
  }
}
