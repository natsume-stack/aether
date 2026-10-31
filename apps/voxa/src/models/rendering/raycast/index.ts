import { mat3, ReadonlyVec3, vec2, vec3 } from 'gl-matrix';
import { Camera } from '../camera/base';
import { Ray } from '../math/ray';
import { Object3D } from '../objects/object3d';

export interface Intersection {
  absPos: vec3;
  voxelPos: vec3;
  normal: vec3;
  object: Object3D;
  distance: number;
}

export class Raycaster {
  public readonly ray: Ray;
  public camera?: Camera;
  constructor(
    origin?: vec3 | undefined,
    direction?: vec3 | undefined,
    public near = 0,
    public far = Infinity,
  ) {
    this.ray = new Ray(origin, direction);
    // direction is assumed to be normalized (for accurate distance calculations)

    this.near = near;
    this.far = far;
  }

  public set(origin: ReadonlyVec3, direction: ReadonlyVec3) {
    // direction is assumed to be normalized (for accurate distance calculations)

    this.ray.set(origin, direction);
  }

  public setFromCamera(coords: vec2, camera: Camera) {
    if (camera.isPerspectiveCamera()) {
      vec3.copy(this.ray.origin, camera.position);

      vec3.transformMat4(
        this.ray.direction,
        vec3.fromValues(coords[0], coords[1], 0.5),
        camera.projectionMatrixInverse,
      );

      vec3.transformMat4(
        this.ray.direction,
        this.ray.direction,
        camera.matrixWorld,
      );

      vec3.sub(this.ray.direction, this.ray.direction, this.ray.origin);

      vec3.normalize(this.ray.direction, this.ray.direction);
    } else if (camera.isOrthographicCamera()) {
      vec3.copy(this.ray.origin, [
        coords[0],
        coords[1],
        (camera.near + camera.far) / (camera.near - camera.far),
      ]);

      vec3.transformMat4(
        this.ray.origin,
        this.ray.origin,
        camera.projectionMatrixInverse,
      );

      vec3.transformMat4(this.ray.origin, this.ray.origin, camera.matrixWorld);

      const m = mat3.create();
      mat3.fromMat4(m, camera.matrixWorld);
      vec3.transformMat3(this.ray.direction, [0, 0, -1], m);
      vec3.normalize(this.ray.direction, this.ray.direction);
    }
  }

  public intersectObject(
    out: Intersection[] = [],
    object: Object3D,
    recursive = true,
  ) {
    this._intersectObject(object, this, out, recursive);

    out.sort(Raycaster.ascSort);
  }

  public intersectObjects(
    objects: Object3D[],
    recursive = true,
    intersects: Intersection[] = [],
  ): void {
    for (let i = 0, l = objects.length; i < l; i++) {
      this._intersectObject(objects[i], this, intersects, recursive);
    }

    intersects.sort(Raycaster.ascSort);
  }

  private static ascSort(a: { distance: number }, b: { distance: number }) {
    return a.distance - b.distance;
  }

  private _intersectObject(
    object: Object3D,
    raycaster: Raycaster,
    intersects: Intersection[],
    recursive: boolean,
  ) {
    object.raycast(intersects, raycaster);

    if (recursive === true) {
      const children = object.children;

      for (let i = 0, l = children.length; i < l; i++) {
        this._intersectObject(children[i], raycaster, intersects, true);
      }
    }
  }
}
