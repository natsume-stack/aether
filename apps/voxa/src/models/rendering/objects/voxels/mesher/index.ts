import ndarray, { NdArray } from 'ndarray';
import { MeshBuilder } from './mesh-builder';
import { freeInt32, mallocInt32, mallocUint16 } from '../../../utils/pool';
import { surfaceStencil } from './surface';

const meshBuilder = new MeshBuilder();

/**
 * 计算AO，合并面
 * @param array
 * @returns vertex positions
 */
export function greedyComputeMesh(
  array: NdArray<Uint16Array>,
  squashDimension: number = 3,
) {
  const needSquash =
    squashDimension === 0 || squashDimension === 1 || squashDimension === 2;
  const shape = array.shape.slice(0);

  // 是所有空间中Surface的集合, 由于传入的 array shape 有额外 +3，此处大小为 shape+ 1，存放各坐标上的面（会比体素多1）
  const nx = (shape[0] - 2) | 0;
  const ny = (shape[1] - 2) | 0;
  const nz = (shape[2] - 2) | 0;
  const size = nx * ny * nz;

  // 三个重复的计算范围
  const scratch0 = mallocInt32(size);
  const scratch1 = mallocInt32(size);
  const scratch2 = mallocInt32(size);

  /**
   * 仅考虑体素面的Shape
   */
  const surfaceShape = [nx, ny, nz];
  /**
   * 存放 AO 计算的结果
   */
  const ao0 = ndarray(scratch0, surfaceShape);
  const ao1 = ndarray(scratch1, surfaceShape);
  const ao2 = ndarray(scratch2, surfaceShape);

  //Calculate ao fields
  surfaceStencil(ao0, ao1, ao2, array);

  const buffers = [ao0, ao1, ao2];
  //Build mesh slices
  meshBuilder.ptr = 0;

  let initD = 0;
  let maxD = 3;

  if (needSquash) {
    initD = squashDimension;
    maxD = initD + 1;
  }

  for (let d = initD; d < maxD; ++d) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    // Create slice
    const st = buffers[d].transpose(d, u, v); // x - x,y,z; y-y,z,x; z-z,x,y
    /**
     * 各坐标轴上的第一层
     */
    const slice = st.pick(0);
    const n = surfaceShape[d] | 0;
    meshBuilder.dimension = d;
    meshBuilder.u = v; // 确保 UV 与 mesher 中的计算方式一致
    meshBuilder.v = u;

    // Generate slices，基于当前坐标轴
    for (let i = 0; i < n; ++i) {
      meshBuilder.z = needSquash ? 0 : i;
      meshBuilder.mesh2DSlice(slice);
      // meshSliceGreedy(slice);
      slice.offset += st.stride[0]; // 下一层
    }
  }
  // Release buffers
  freeInt32(scratch0);
  freeInt32(scratch1);
  freeInt32(scratch2);

  // Release uint8 array if no vertices were allocated
  if (meshBuilder.ptr === 0) {
    return;
  }

  // Slice out buffer
  const rbuffer = meshBuilder.buffer;
  const rptr = meshBuilder.ptr;

  // Reset Builder
  meshBuilder.buffer = mallocUint16(1024);
  meshBuilder.ptr = 0;

  return rbuffer.subarray(0, rptr);
}
