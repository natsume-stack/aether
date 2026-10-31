import type { Object3D } from '../objects/object3d';
import type { BufferAttribute } from '../geometries/buffer-attribute';
import { mat4, vec3 } from 'gl-matrix';

const POINTS = [
  vec3.create(),
  vec3.create(),
  vec3.create(),
  vec3.create(),
  vec3.create(),
  vec3.create(),
  vec3.create(),
  vec3.create(),
];
const TEMP_VEC3 = vec3.create();

export class Box3 {
  constructor(
    public min = vec3.fromValues(+Infinity, +Infinity, +Infinity),
    public max = vec3.fromValues(-Infinity, -Infinity, -Infinity),
  ) {}

  public copy(box: Box3) {
    vec3.copy(this.min, box.min);
    vec3.copy(this.max, box.max);
    return this;
  }

  public union(box: Box3) {
    vec3.min(this.min, this.min, box.min);
    vec3.max(this.max, this.max, box.max);
    return this;
  }

  public applyMatrix4(matrix: mat4) {
    // transform of empty box is an empty box.
    if (this.isEmpty()) {
      return this;
    }

    // NOTE: I am using a binary pattern to specify all 2^3 combinations below
    vec3.transformMat4(
      POINTS[0],
      vec3.set(POINTS[0], this.min[0], this.min[1], this.min[2]),
      matrix,
    ); // 000
    vec3.transformMat4(
      POINTS[1],
      vec3.set(POINTS[1], this.min[0], this.min[1], this.max[2]),
      matrix,
    ); // 001
    vec3.transformMat4(
      POINTS[2],
      vec3.set(POINTS[2], this.min[0], this.max[1], this.min[2]),
      matrix,
    ); // 010
    vec3.transformMat4(
      POINTS[3],
      vec3.set(POINTS[3], this.min[0], this.max[1], this.max[2]),
      matrix,
    ); // 011
    vec3.transformMat4(
      POINTS[4],
      vec3.set(POINTS[4], this.max[0], this.min[1], this.min[2]),
      matrix,
    ); // 100
    vec3.transformMat4(
      POINTS[5],
      vec3.set(POINTS[5], this.max[0], this.min[1], this.max[2]),
      matrix,
    ); // 101
    vec3.transformMat4(
      POINTS[6],
      vec3.set(POINTS[6], this.max[0], this.max[1], this.min[2]),
      matrix,
    ); // 110
    vec3.transformMat4(
      POINTS[7],
      vec3.set(POINTS[7], this.max[0], this.max[1], this.max[2]),
      matrix,
    ); // 111

    this.setFromPoints(POINTS);

    return this;
  }

  public setFromBufferAttribute(attribute: BufferAttribute) {
    let minX = +Infinity;
    let minY = +Infinity;
    let minZ = +Infinity;

    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0, l = attribute.count; i < l; i++) {
      const v = attribute.getVec3(i);
      const x = v[0];
      const y = v[1];
      const z = v[2];

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;

      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    vec3.set(this.min, minX, minY, minZ);
    vec3.set(this.max, maxX, maxY, maxZ);

    return this;
  }

  public expandByObject(object: Object3D) {
    // Computes the world-axis-aligned bounding box of an object (including its children),
    // accounting for both the object's, and children's, world transforms

    object.updateWorldMatrix(false, false);

    const geometry = object.geometry;

    if (geometry) {
      if (!geometry.boundingBox) {
        geometry.boundingBox = geometry.computeBoundingBox();
      }
      const tempBox = new Box3();
      tempBox.copy(geometry.boundingBox);
      tempBox.applyMatrix4(object.matrixWorld);

      this.union(tempBox);
    }

    const children = object.children;

    for (let i = 0, l = children.length; i < l; i++) {
      this.expandByObject(children[i]);
    }

    return this;
  }

  public setFromPoints(points: vec3[]) {
    this.makeEmpty();

    for (let i = 0, il = points.length; i < il; i++) {
      this.expandByPoint(points[i]);
    }

    return this;
  }

  public setFromCenterAndSize(center: vec3, size: vec3) {
    vec3.scale(TEMP_VEC3, size, 0.5);
    const halfSize = TEMP_VEC3;

    vec3.sub(this.min, center, halfSize);
    vec3.add(this.max, center, halfSize);
    return this;
  }

  public expandByPoint(point: vec3) {
    vec3.min(this.min, this.min, point);
    vec3.max(this.max, this.max, point);

    return this;
  }

  public getCenter(out: vec3) {
    return this.isEmpty()
      ? vec3.set(out, 0, 0, 0)
      : vec3.scale(out, vec3.add(out, this.min, this.max), 0.5);
  }

  public getSize(target: vec3) {
    return this.isEmpty()
      ? vec3.set(target, 0, 0, 0)
      : vec3.sub(target, this.max, this.min);
  }

  public makeEmpty() {
    this.min[0] = this.min[1] = this.min[2] = +Infinity;
    this.max[0] = this.max[1] = this.max[2] = -Infinity;

    return this;
  }

  public isEmpty() {
    // this is a more robust check for empty than ( volume <= 0 ) because volume can get positive with two negative axes

    return (
      this.max[0] < this.min[0] ||
      this.max[1] < this.min[1] ||
      this.max[2] < this.min[2]
    );
  }
}
