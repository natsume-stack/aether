import ndarray, { NdArray } from 'ndarray';
import { alloc, free } from '@box/utils/pool';
import { VoxelView } from '@box/utils/voxel';
import { greedyComputeMesh } from '../rendering/objects/voxels/mesher';
import { OPAQUE_BIT } from '../rendering/objects/voxels/mesher/def';
import { VoxelDimensionType } from '../project/interfaces';
import { VoxelDimension } from '../project/defs';

/**
 * Cache for the voxel array to avoid GC
 */
let VoxelsWrap: NdArray<Uint16Array>;

type BakeMeshResult = {
  /**
   * Mesh数据。通过ao-mesher计算得到。
   * 当体素视图为空或者computeMesh失败时，mesh为undefined。
   */
  mesh?: Uint16Array;
  /**
   * 体素视图是否为空。
   */
  isEmptyVoxels: boolean;
};

/**
 * Use ao-mesher to combine meshes for better rendering performance。
 * @param voxel
 * @returns
 */
export function bakeMesh(
  voxels: VoxelView,
  dimension: VoxelDimensionType = VoxelDimension.XYZ,
): BakeMeshResult {
  const nx = voxels.shape[0] + 3;
  const ny = voxels.shape[1] + 3;
  const nz = voxels.shape[2] + 3;

  let isEmptyVoxels = true;

  if (!VoxelsWrap) {
    const buffer = alloc(2 * nx * ny * nz);
    VoxelsWrap = ndarray(new Uint16Array(buffer), [nx, ny, nz]);
  } else if (
    VoxelsWrap.shape[0] != nx ||
    VoxelsWrap.shape[1] != ny ||
    VoxelsWrap.shape[2] != nz
  ) {
    free(VoxelsWrap.data.buffer);
    const buffer = alloc(2 * nx * ny * nz);
    VoxelsWrap = ndarray(new Uint16Array(buffer), [nx, ny, nz]);
  }

  VoxelsWrap.data.fill(0);

  // 复制一个坐标偏移一格的体素模型
  for (let i = 0; i < voxels.shape[0]; i++) {
    for (let j = 0; j < voxels.shape[1]; j++) {
      for (let k = 0; k < voxels.shape[2]; k++) {
        const textureId = voxels.getVoxel(i, j, k);

        if (textureId === 0) {
          continue;
        }

        isEmptyVoxels = false;

        VoxelsWrap.set(i + 1, j + 1, k + 1, textureId | OPAQUE_BIT);
      }
    }
  }

  if (isEmptyVoxels) {
    return { isEmptyVoxels };
  }

  const mesh = greedyComputeMesh(VoxelsWrap, dimension);

  return { mesh, isEmptyVoxels };
}
