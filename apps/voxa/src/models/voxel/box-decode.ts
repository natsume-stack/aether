import { VoxelCollisionBox } from '../../utils/rbush/schema';
import type { VoxelView } from '@box/utils/voxel';

// more-or-less inverse of mesh3d
export function blitBoxesToChunk(chunk: VoxelView, boxes: VoxelCollisionBox[]) {
  const {
    data,
    stride: [sx, sy, sz],
    offset,
  } = chunk;

  for (let boxId = 0; boxId < boxes.length; ++boxId) {
    const { minX, minY, minZ, maxX, maxY, maxZ, block } = boxes[boxId];

    const nx = maxX - minX;
    const ny = maxY - minY;
    const nz = maxZ - minZ;

    let tptr = offset + sx * minX + sy * minY + sz * minZ;
    const dtdi = sx;
    const dtdj = sy - nx * sx;
    const dtdk = sz - ny * sy;
    for (let k = 0; k < nz; ++k) {
      for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
          data[tptr] = block;
          tptr += dtdi;
        }
        tptr += dtdj;
      }
      tptr += dtdk;
    }
  }
}
