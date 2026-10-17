import { mat4, vec3 } from 'gl-matrix';
import { Object3D } from '../objects/object3d';
import { Box3 } from './box3';
import { Plane } from './plane';
import { Sphere } from './sphere';

const VECTOR = vec3.create();
const SPHERE = new Sphere();

export class Frustum {
  public planes: Plane[];
  constructor(
    p0 = new Plane(),
    p1 = new Plane(),
    p2 = new Plane(),
    p3 = new Plane(),
    p4 = new Plane(),
    p5 = new Plane(),
  ) {
    this.planes = [p0, p1, p2, p3, p4, p5];
  }

  public setFromProjectionMatrix(m: mat4) {
    const planes = this.planes;
    const m00 = m[0],
      m01 = m[1],
      m02 = m[2],
      m03 = m[3];
    const m10 = m[4],
      m11 = m[5],
      m12 = m[6],
      m13 = m[7];
    const m20 = m[8],
      m21 = m[9],
      m22 = m[10],
      m23 = m[11];
    const m30 = m[12],
      m31 = m[13],
      m32 = m[14],
      m33 = m[15];

    planes[0].setComponents(m03 - m00, m13 - m10, m23 - m20, m33 - m30);
    planes[1].setComponents(m03 + m00, m13 + m10, m23 + m20, m33 + m30);
    planes[2].setComponents(m03 - m01, m13 - m11, m23 - m21, m33 - m31);
    planes[3].setComponents(m03 + m01, m13 + m11, m23 + m21, m33 + m31);
    planes[4].setComponents(m03 - m02, m13 - m12, m23 - m22, m33 - m32);
    planes[5].setComponents(m03 + m02, m13 + m12, m23 + m22, m33 + m32);
  }

  public containsPoint(point: vec3): boolean {
    const planes = this.planes;
    for (let i = 0; i < 6; i++) {
      if (planes[i].distanceToPoint(point) < 0) {
        return false;
      }
    }
    return true;
  }

  public intersectsBox(box: Box3) {
    const planes = this.planes;

    for (let i = 0; i < 6; i++) {
      const plane = planes[i];

      // corner at max distance
      VECTOR[0] = plane.normal[0] > 0 ? box.max[0] : box.min[0];
      VECTOR[1] = plane.normal[1] > 0 ? box.max[1] : box.min[1];
      VECTOR[2] = plane.normal[2] > 0 ? box.max[2] : box.min[2];

      if (plane.distanceToPoint(VECTOR) < 0) {
        return false;
      }
    }

    return true;
  }

  public intersectsSphere(sphere: Sphere) {
    const planes = this.planes;
    const center = sphere.center;
    const negRadius = -sphere.radius;

    for (let i = 0; i < 6; i++) {
      const distance = planes[i].distanceToPoint(center);
      if (distance < negRadius) {
        return false;
      }
    }

    return true;
  }

  public intersectsObject(object: Object3D) {
    if (object.isVoxels()) {
      return true;
    }

    if (!object.geometry) {
      return false;
    }

    const sphere =
      object.geometry.boundingSphere || object.geometry.computeBoundingSphere();
    SPHERE.copy(sphere).applyMatrix4(object.matrixWorld);
    return this.intersectsSphere(SPHERE);
  }
}
