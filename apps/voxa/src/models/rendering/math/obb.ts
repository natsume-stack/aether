import { mat3, mat4, vec3 } from 'gl-matrix';
import { Box3 } from './box3';
import { Ray } from './ray';
import { Sphere } from './sphere';
import { Plane } from './plane';

const a: {
  c: vec3;
  u: [vec3, vec3, vec3];
  e: number[];
} = {
  c: vec3.create(),
  // center
  u: [vec3.create(), vec3.create(), vec3.create()],
  // basis vectors
  e: [], // half width
};
const b: {
  c: vec3;
  u: [vec3, vec3, vec3];
  e: number[];
} = {
  c: vec3.create(),
  // center
  u: [vec3.create(), vec3.create(), vec3.create()],
  // basis vectors
  e: [], // half width
};
const R: [number[], number[], number[]] = [[], [], []];
const AbsR: [number[], number[], number[]] = [[], [], []];
const t: number[] = [];
const xAxis = vec3.create();
const yAxis = vec3.create();
const zAxis = vec3.create();
const v1 = vec3.create();
const size = vec3.create();
const closestPoint = vec3.create();
const rotationMatrix = mat3.create();
const aabb = new Box3();
const matrix = mat4.create();
const inverse = mat4.create();
const localRay = new Ray(); // OBB

export class OBB {
  constructor(
    public center = vec3.create(),
    public halfSize = vec3.create(),
    public rotation = mat3.create(),
  ) {}

  public set(center: vec3, halfSize: vec3, rotation: mat3) {
    vec3.copy(this.center, center);
    vec3.copy(this.halfSize, halfSize);
    mat3.copy(this.rotation, rotation);
    return this;
  }

  public copy(obb: OBB) {
    vec3.copy(this.center, obb.center);
    vec3.copy(this.halfSize, obb.halfSize);
    mat3.copy(this.rotation, obb.rotation);
    return this;
  }

  public clone() {
    return new OBB().copy(this);
  }

  public getSize(result: vec3) {
    return vec3.scale(result, this.halfSize, 2);
  }

  public extractBasis(rotation: mat3, xAxis: vec3, yAxis: vec3, zAxis: vec3) {
    this.setFromMatrix3Column(xAxis, rotation, 0);
    this.setFromMatrix3Column(yAxis, rotation, 1);
    this.setFromMatrix3Column(zAxis, rotation, 2);
  }

  private setFromMatrix3Column(out: vec3, mat3: mat3, index: number) {
    const offset = index * 3;
    out[0] = mat3[offset];
    out[1] = mat3[offset + 1];
    out[2] = mat3[offset + 2];
    return out;
  }

  private clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Reference: Closest Point on OBB to Point in Real-Time Collision Detection
   * by Christer Ericson (chapter 5.1.4)
   */
  public clampPoint(point: vec3, result: vec3) {
    const halfSize = this.halfSize;
    vec3.sub(v1, point, this.center);
    this.extractBasis(this.rotation, xAxis, yAxis, zAxis); // start at the center position of the OBB

    vec3.copy(result, this.center); // project the target onto the OBB axes and walk towards that point

    const x = this.clamp(vec3.dot(v1, xAxis), -halfSize[0], halfSize[0]);
    vec3.add(result, result, vec3.scale(xAxis, xAxis, x));

    const y = this.clamp(vec3.dot(v1, yAxis), -halfSize[1], halfSize[1]);
    vec3.add(result, result, vec3.scale(yAxis, yAxis, y));

    const z = this.clamp(vec3.dot(v1, zAxis), -halfSize[2], halfSize[2]);
    vec3.add(result, result, vec3.scale(zAxis, zAxis, z));
    return result;
  }

  public containsPoint(point: vec3) {
    vec3.sub(v1, point, this.center);

    this.extractBasis(this.rotation, xAxis, yAxis, zAxis); // project v1 onto each axis and check if these points lie inside the OBB

    return (
      Math.abs(vec3.dot(v1, xAxis)) <= this.halfSize[0] &&
      Math.abs(vec3.dot(v1, yAxis)) <= this.halfSize[1] &&
      Math.abs(vec3.dot(v1, zAxis)) <= this.halfSize[2]
    );
  }

  public intersectsBox3(box3: Box3) {
    return this.intersectsOBB(obb.fromBox3(box3));
  }

  public intersectsSphere(sphere: Sphere) {
    // find the point on the OBB closest to the sphere center
    this.clampPoint(sphere.center, closestPoint); // if that point is inside the sphere, the OBB and sphere intersect

    return (
      vec3.squaredDistance(closestPoint, sphere.center) <=
      sphere.radius * sphere.radius
    );
  }

  /**
   * Reference: OBB-OBB Intersection in Real-Time Collision Detection
   * by Christer Ericson (chapter 4.4.1)
   */
  public intersectsOBB(obb: OBB, epsilon = Number.EPSILON) {
    // prepare data structures (the code uses the same nomenclature like the reference)
    a.c = this.center;
    a.e[0] = this.halfSize[0];
    a.e[1] = this.halfSize[1];
    a.e[2] = this.halfSize[2];
    this.extractBasis(this.rotation, a.u[0], a.u[1], a.u[2]);
    b.c = obb.center;
    b.e[0] = obb.halfSize[0];
    b.e[1] = obb.halfSize[1];
    b.e[2] = obb.halfSize[2];
    this.extractBasis(obb.rotation, b.u[0], b.u[1], b.u[2]); // compute rotation matrix expressing b in a's coordinate frame

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        R[i][j] = vec3.dot(a.u[i], b.u[j]);
      }
    } // compute translation vector

    vec3.sub(v1, b.c, a.c); // bring translation into a's coordinate frame

    t[0] = vec3.dot(v1, a.u[0]);
    t[1] = vec3.dot(v1, a.u[1]);
    t[2] = vec3.dot(v1, a.u[2]); // compute common subexpressions. Add in an epsilon term to
    // counteract arithmetic errors when two edges are parallel and
    // their cross product is (near) null

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        AbsR[i][j] = Math.abs(R[i][j]) + epsilon;
      }
    }

    let ra: number, rb: number; // test axes L = A0, L = A1, L = A2

    for (let i = 0; i < 3; i++) {
      ra = a.e[i];
      rb = b.e[0] * AbsR[i][0] + b.e[1] * AbsR[i][1] + b.e[2] * AbsR[i][2];
      if (Math.abs(t[i]) > ra + rb) return false;
    } // test axes L = B0, L = B1, L = B2

    for (let i = 0; i < 3; i++) {
      ra = a.e[0] * AbsR[0][i] + a.e[1] * AbsR[1][i] + a.e[2] * AbsR[2][i];
      rb = b.e[i];
      if (Math.abs(t[0] * R[0][i] + t[1] * R[1][i] + t[2] * R[2][i]) > ra + rb)
        return false;
    } // test axis L = A0 x B0

    ra = a.e[1] * AbsR[2][0] + a.e[2] * AbsR[1][0];
    rb = b.e[1] * AbsR[0][2] + b.e[2] * AbsR[0][1];
    if (Math.abs(t[2] * R[1][0] - t[1] * R[2][0]) > ra + rb) return false; // test axis L = A0 x B1

    ra = a.e[1] * AbsR[2][1] + a.e[2] * AbsR[1][1];
    rb = b.e[0] * AbsR[0][2] + b.e[2] * AbsR[0][0];
    if (Math.abs(t[2] * R[1][1] - t[1] * R[2][1]) > ra + rb) return false; // test axis L = A0 x B2

    ra = a.e[1] * AbsR[2][2] + a.e[2] * AbsR[1][2];
    rb = b.e[0] * AbsR[0][1] + b.e[1] * AbsR[0][0];
    if (Math.abs(t[2] * R[1][2] - t[1] * R[2][2]) > ra + rb) return false; // test axis L = A1 x B0

    ra = a.e[0] * AbsR[2][0] + a.e[2] * AbsR[0][0];
    rb = b.e[1] * AbsR[1][2] + b.e[2] * AbsR[1][1];
    if (Math.abs(t[0] * R[2][0] - t[2] * R[0][0]) > ra + rb) return false; // test axis L = A1 x B1

    ra = a.e[0] * AbsR[2][1] + a.e[2] * AbsR[0][1];
    rb = b.e[0] * AbsR[1][2] + b.e[2] * AbsR[1][0];
    if (Math.abs(t[0] * R[2][1] - t[2] * R[0][1]) > ra + rb) return false; // test axis L = A1 x B2

    ra = a.e[0] * AbsR[2][2] + a.e[2] * AbsR[0][2];
    rb = b.e[0] * AbsR[1][1] + b.e[1] * AbsR[1][0];
    if (Math.abs(t[0] * R[2][2] - t[2] * R[0][2]) > ra + rb) return false; // test axis L = A2 x B0

    ra = a.e[0] * AbsR[1][0] + a.e[1] * AbsR[0][0];
    rb = b.e[1] * AbsR[2][2] + b.e[2] * AbsR[2][1];
    if (Math.abs(t[1] * R[0][0] - t[0] * R[1][0]) > ra + rb) return false; // test axis L = A2 x B1

    ra = a.e[0] * AbsR[1][1] + a.e[1] * AbsR[0][1];
    rb = b.e[0] * AbsR[2][2] + b.e[2] * AbsR[2][0];
    if (Math.abs(t[1] * R[0][1] - t[0] * R[1][1]) > ra + rb) return false; // test axis L = A2 x B2

    ra = a.e[0] * AbsR[1][2] + a.e[1] * AbsR[0][2];
    rb = b.e[0] * AbsR[2][1] + b.e[1] * AbsR[2][0];
    return !(Math.abs(t[1] * R[0][2] - t[0] * R[1][2]) > ra + rb);
  }

  /**
   * Reference: Testing Box Against Plane in Real-Time Collision Detection
   * by Christer Ericson (chapter 5.2.3)
   */
  public intersectsPlane(plane: Plane) {
    this.extractBasis(this.rotation, xAxis, yAxis, zAxis); // compute the projection interval radius of this OBB onto L(t) = this->center + t * p.normal;

    const r =
      this.halfSize[0] * Math.abs(vec3.dot(plane.normal, xAxis)) +
      this.halfSize[1] * Math.abs(vec3.dot(plane.normal, yAxis)) +
      this.halfSize[2] * Math.abs(vec3.dot(plane.normal, zAxis)); // compute distance of the OBB's center from the plane

    const d = vec3.dot(plane.normal, this.center) - plane.constant; // Intersection occurs when distance d falls within [-r,+r] interval

    return Math.abs(d) <= r;
  }

  private setFromMat3AndPosition(out: mat4, rotation: mat3, position: vec3) {
    out[0] = rotation[0];
    out[1] = rotation[1];
    out[2] = rotation[2];
    out[3] = 0;
    out[4] = rotation[3];
    out[5] = rotation[4];
    out[6] = rotation[5];
    out[7] = 0;
    out[8] = rotation[6];
    out[9] = rotation[7];
    out[10] = rotation[8];
    out[11] = 0;
    out[12] = position[0];
    out[13] = position[1];
    out[14] = position[2];
    out[15] = 1;
    return out;
  }

  /**
   * Performs a ray/OBB intersection test and stores the intersection point
   * to the given 3D vector. If no intersection is detected, *null* is returned.
   */
  public intersectRay(ray: Ray, result: vec3) {
    // the idea is to perform the intersection test in the local space
    // of the OBB.
    this.getSize(size);
    aabb.setFromCenterAndSize(vec3.set(v1, 0, 0, 0), size); // create a 4x4 transformation matrix

    this.setFromMat3AndPosition(matrix, this.rotation, this.center); // transform ray to the local space of the OBB

    mat4.invert(inverse, matrix);
    localRay.copy(ray).applyMatrix4(inverse); // perform ray <-> AABB intersection test

    if (localRay.intersectBox(aabb, result)) {
      // transform the intersection point back to world space
      return vec3.transformMat4(result, result, matrix);
    } else {
      return null;
    }
  }

  /**
   * Performs a ray/OBB intersection test. Returns either true or false if
   * there is a intersection or not.
   */
  public intersectsRay(ray: Ray) {
    return this.intersectRay(ray, v1) !== null;
  }

  public fromBox3(box3: Box3) {
    box3.getCenter(this.center);
    vec3.scale(this.halfSize, box3.getSize(this.halfSize), 0.5);
    mat3.identity(this.rotation);
    return this;
  }

  public equals(obb: OBB) {
    return (
      vec3.equals(obb.center, this.center) &&
      vec3.equals(obb.halfSize, this.halfSize) &&
      mat3.equals(obb.rotation, this.rotation)
    );
  }

  public applyMatrix4(matrix: mat4) {
    const e = matrix;

    let sx = vec3.length(vec3.set(v1, e[0], e[1], e[2]));
    const sy = vec3.length(vec3.set(v1, e[4], e[5], e[6]));
    const sz = vec3.length(vec3.set(v1, e[8], e[9], e[10]));
    const det = mat4.determinant(matrix);
    if (det < 0) sx = -sx;
    mat3.fromMat4(rotationMatrix, matrix);
    const invSX = 1 / sx;
    const invSY = 1 / sy;
    const invSZ = 1 / sz;
    rotationMatrix[0] *= invSX;
    rotationMatrix[1] *= invSX;
    rotationMatrix[2] *= invSX;
    rotationMatrix[3] *= invSY;
    rotationMatrix[4] *= invSY;
    rotationMatrix[5] *= invSY;
    rotationMatrix[6] *= invSZ;
    rotationMatrix[7] *= invSZ;
    rotationMatrix[8] *= invSZ;
    mat3.multiply(this.rotation, this.rotation, rotationMatrix);
    this.halfSize[0] *= sx;
    this.halfSize[1] *= sy;
    this.halfSize[2] *= sz;
    mat4.getTranslation(v1, matrix);
    vec3.add(this.center, this.center, v1);
    return this;
  }
}
const obb = new OBB();
