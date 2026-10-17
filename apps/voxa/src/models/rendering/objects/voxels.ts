import { vec3 } from 'gl-matrix';
import { clamp } from 'ramda';
import type { VoxelView } from '@box/utils/voxel';
import type { Intersection, Raycaster } from '../raycast';
import { Object3D, Object3DType } from './object3d';

export class Voxels extends Object3D {
  public readonly type = Object3DType.Voxels;
  constructor(public voxels: VoxelView) {
    super();
  }

  public raycast(intersects: Intersection[], raycaster: Raycaster) {
    let t = 0;
    let maxDistance = raycaster.far;
    const voxels = this.voxels;

    const [dx, dy, dz] = raycaster.ray.direction;
    const [px_, py_, pz_] = raycaster.ray.origin;

    const txDelta = Math.abs(1 / dx);
    const tyDelta = Math.abs(1 / dy);
    const tzDelta = Math.abs(1 / dz);

    const tx0 = -px_ / dx;
    const tx1 = (voxels.shape[0] - px_) / dx;
    const ty0 = -py_ / dy;
    const ty1 = (voxels.shape[1] - py_) / dy;
    const tz0 = -pz_ / dz;
    const tz1 = (voxels.shape[2] - pz_) / dz;

    let stepx = 1;
    let initAxis = -1;
    let initDirec = -1;

    if (dx < 0) {
      if (px_ < 0) {
        return false;
      } else if (px_ >= voxels.shape[0]) {
        if (tx1 > t) {
          t = tx1;
          initAxis = 0;
          initDirec = 1;
        }
      }
      maxDistance = Math.min(maxDistance, tx0);
      stepx = -1;
    } else {
      if (px_ >= voxels.shape[0]) {
        return false;
      } else if (px_ < 0) {
        if (tx0 > t) {
          t = tx0;
          initAxis = 0;
          initDirec = -1;
        }
      }
      maxDistance = Math.min(maxDistance, tx1);
    }

    let stepy = 1;
    if (dy < 0) {
      if (py_ < 0) {
        return false;
      } else if (py_ >= voxels.shape[1]) {
        if (ty1 > t) {
          t = ty1;
          initAxis = 1;
          initDirec = 1;
        }
      }
      maxDistance = Math.min(maxDistance, ty0);
      stepy = -1;
    } else {
      if (py_ >= voxels.shape[1]) {
        return false;
      } else if (py_ < 0) {
        if (ty0 > t) {
          t = ty0;
          initAxis = 1;
          initDirec = -1;
        }
      }
      maxDistance = Math.min(maxDistance, ty1);
    }

    let stepz = 2 * +(dz > 0) - 1;
    if (dz < 0) {
      if (pz_ < 0) {
        return false;
      } else if (pz_ >= voxels.shape[2]) {
        if (tz1 > t) {
          t = tz1;
          initAxis = 2;
          initDirec = 1;
        }
      }
      maxDistance = Math.min(maxDistance, tz0);
      stepz = -1;
    } else {
      if (pz_ >= voxels.shape[2]) {
        return false;
      } else if (pz_ < 0) {
        if (tz0 > t) {
          t = tz0;
          initAxis = 2;
          initDirec = -1;
        }
      }
      maxDistance = Math.min(maxDistance, tz1);
    }

    const px = clamp(0, voxels.shape[0] - 0.001, px_ + t * dx);
    const py = clamp(0, voxels.shape[1] - 0.001, py_ + t * dy);
    const pz = clamp(0, voxels.shape[2] - 0.001, pz_ + t * dz);

    let ix = Math.floor(px) | 0;
    let iy = Math.floor(py) | 0;
    let iz = Math.floor(pz) | 0;

    const xdist = stepx > 0 ? ix + 1 - px : px - ix;
    const ydist = stepy > 0 ? iy + 1 - py : py - iy;
    const zdist = stepz > 0 ? iz + 1 - pz : pz - iz;

    // location of nearest voxel boundary, in units of t
    let txMax = t + (txDelta < Infinity ? txDelta * xdist : Infinity);
    let tyMax = t + (tyDelta < Infinity ? tyDelta * ydist : Infinity);
    let tzMax = t + (tzDelta < Infinity ? tzDelta * zdist : Infinity);
    let steppedIndex = -1;

    // unpack voxel params
    const {
      data,
      stride: [stridex, stridey, stridez],
      offset,
    } = voxels;

    // main loop along raycast vector
    let times = 0;
    while (t <= maxDistance) {
      // exit check
      let b = data[ix * stridex + iy * stridey + iz * stridez + offset];
      if (
        ix >= voxels.shape[0] ||
        iy >= voxels.shape[1] ||
        iz >= voxels.shape[2] ||
        ix < 0 ||
        iy < 0 ||
        iz < 0
      ) {
        b = 0;
      }

      if (b) {
        const normal = vec3.fromValues(0, 0, 0);
        if (times == 0 && initAxis != -1) {
          normal[initAxis] = initDirec;
        }
        if (steppedIndex === 0) {
          normal[0] = -stepx;
        }
        if (steppedIndex === 1) {
          normal[1] = -stepy;
        }
        if (steppedIndex === 2) {
          normal[2] = -stepz;
        }
        intersects.push({
          absPos: vec3.fromValues(px_ + t * dx, py_ + t * dy, pz_ + t * dz),
          voxelPos: vec3.fromValues(ix, iy, iz),
          normal,
          object: this,
          distance: t,
        });

        return true;
      }

      // advance t to next nearest voxel boundary
      if (txMax < tyMax) {
        if (txMax < tzMax) {
          ix += stepx;
          t = txMax;
          txMax += txDelta;
          steppedIndex = 0;
        } else {
          iz += stepz;
          t = tzMax;
          tzMax += tzDelta;
          steppedIndex = 2;
        }
      } else {
        if (tyMax < tzMax) {
          iy += stepy;
          t = tyMax;
          tyMax += tyDelta;
          steppedIndex = 1;
        } else {
          iz += stepz;
          t = tzMax;
          tzMax += tzDelta;
          steppedIndex = 2;
        }
      }
      ++times;
    }
    return false;
  }
}
