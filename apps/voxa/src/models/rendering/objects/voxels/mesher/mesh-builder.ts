import type { NDArrayLike } from '@box/regl';
import {
  FLIP_BIT,
  AO_SHIFT,
  AO_MASK,
  TR_AO_SHIFT,
  BR_AO_SHIFT,
  BL_AO_SHIFT,
  AOSurfaceUint16,
  TEXTURE_MASK,
} from './def';
import {
  freeUint16,
  freeUint8,
  mallocUint16,
  mallocUint8,
} from '../../../utils/pool';

/**
 * 构成一个面的顶点占据的空间bit
 */
const SURFACE_VERTEX_SIZE = 8 * 6;
/**
 * 体素信息的Mask
 */
const VOXEL_MASK = (1 << 16) - 1;

/**
 * AO Type 映射为 AO Value，255一定程度代表明亮程度
 */
const AO_TABLE = new Uint8Array([0, 153, 204, 255]);

/**
 *  0 - 5 代表面的六个方向
 */
type SideDirection = number;

/**
 * 8bit number
 */
type TextureID = number;

/**
 * 获取体素的 TextureID
 * @param voxel
 * @param side
 * @param voxelSideTextureIDs
 * @returns
 */
function voxelTexture(
  voxel: AOSurfaceUint16,
  side: SideDirection,
  voxelSideTextureIDs?,
): TextureID {
  return voxelSideTextureIDs
    ? voxelSideTextureIDs.get(voxel & TEXTURE_MASK, side)
    : voxel & TEXTURE_MASK;
}

function calcNormalCode(nx: number, ny: number, nz: number) {
  if (nx < 128) {
    return 0;
  } else if (nx > 128) {
    return 1;
  } else if (ny < 128) {
    return 2;
  } else if (ny > 128) {
    return 3;
  } else if (nz < 128) {
    return 4;
  } else if (nz > 128) {
    return 5;
  }
  return 0;
}

export class MeshBuilder {
  public buffer = mallocUint16(1024);
  public ptr = 0;
  public z = 0;
  public u = 0;
  public v = 0;
  public dimension = 0;

  public voxelSideTextureIDs?: number;

  /**
   * 合并2D平面上的体素面
   * TODO 复杂度超标，70降到39降不动了，以后再说
   * @param array  Row Major 2DArray，这里以 UV 表示，左上角为 (0，0)
   */
  public mesh2DSlice(array: NDArrayLike) {
    const data = array.data,
      shape = array.shape,
      stride = array.stride;
    const strideU = stride[1] | 0,
      shapeU = shape[1] | 0;
    let iStartU = 0,
      iEndU = 0,
      iU = 0;
    const strideV = stride[0] | 0,
      shapeV = shape[0] | 0;
    const startStepV = (strideV - strideU * shapeU) | 0; // 2D 场景下为 0

    const visitedStrideV = shapeU;
    /**
     * Visited Array 是 Column Major，此处为 1
     */
    const visitedStrideU = 1;
    let iStartV = 0,
      iEndV = 0,
      iV = 0,
      nextVisitStepV = shapeU | 0,
      endStepV = startStepV | 0;
    /**
     * 代表合并起点处的 surface
     */
    let startPtr = array.offset,
      /**
       * 代表合并的终点 surface
       */
      endPtr = 0,
      /**
       * 下一个 visit 的坐标在 visit 数组对应值的 index
       */
      nextVisitPtr = 0,
      /**
       * 本次 visit 的坐标在 visit 数组对应值的 index
       */
      visitedPtr = 0,
      d = 1;
    let count = shapeU * shapeV;

    /**
     * 标记是否已经计算过该 surface
     */
    const visited = mallocUint8(count);
    visited.fill(0, 0, count);

    // 按坐标计算所有可能的矩形，选择最大的那个
    for (iStartV = 0; iStartV < shapeV; ++iStartV) {
      // 遍历列（V）
      iStartU = 0;
      while (iStartU < shapeU) {
        d = 1;
        // 遍历行（U）
        if (!visited[visitedPtr] && data[startPtr] !== 0) {
          nextVisitPtr = visitedPtr + visitedStrideU;
          endPtr = startPtr + strideU;
          // 寻找以 (startU, startV) 为起点，U 方向上的最大矩形
          j0_loop: for (iEndU = 1 + iStartU; iEndU < shapeU; ++iEndU) {
            if (
              visited[nextVisitPtr] ||
              data[endPtr] === 0 ||
              data[endPtr] !== data[startPtr]
            ) {
              // End visited
              break j0_loop;
            }

            // 还能继续，那就计算下一个
            nextVisitPtr += visitedStrideU;
            endPtr += strideU;
          }

          d = iEndU - iStartU; // 本矩形在 U 方向上的长度

          /**
           * 确定下一个 visit，x-visited，o-unvisited， #-next unvisited
           * x x x o o
           * # o o o o
           */
          nextVisitStepV = (visitedStrideV - visitedStrideU * d) | 0; // 下一 visit 会在下一行的 iStartU 位置
          endStepV = (strideV - strideU * d) | 0; // 一样，

          nextVisitPtr = visitedPtr + visitedStrideV; // 跳到下一行作为V方向的启动位置
          endPtr = startPtr + strideV;

          // 寻找 V 方向上的最大矩形
          j1_loop: for (iEndV = 1 + iStartV; iEndV < shapeV; ++iEndV) {
            // 逐行确认是否能够合并
            for (iU = iStartU; iU < iEndU; ++iU) {
              // 遍历d长度的行
              if (
                visited[nextVisitPtr] ||
                data[endPtr] === 0 ||
                data[endPtr] !== data[startPtr]
              ) {
                // 跳的是外层，意味着至少完成一次完整遍历才会增加 iEndV
                break j1_loop;
              }

              nextVisitPtr += visitedStrideU;
              endPtr += strideU;
            }

            nextVisitPtr += nextVisitStepV;
            endPtr += endStepV;
          }

          nextVisitPtr = visitedPtr;

          // 合并完毕，设置本次被使用的 surface
          for (iV = iStartV; iV < iEndV; ++iV) {
            visited.fill(1, nextVisitPtr, (nextVisitPtr += iEndU - iStartU));
            nextVisitPtr += nextVisitStepV;
          }

          this.append(iStartU, iStartV, iEndU, iEndV, data[startPtr]);
        }

        iStartU += d;
        visitedPtr += visitedStrideU * d;
        startPtr += strideU * d;
      }
      startPtr += startStepV;
    }
    freeUint8(visited);
  }

  /**
   * 传入 Greedy Mesh 进行计算的函数
   * @param lo_x
   * @param lo_y
   * @param hi_x
   * @param hi_y
   * @param val Surface Data
   */
  public append(
    lo_x: number,
    lo_y: number,
    hi_x: number,
    hi_y: number,
    val: number,
  ) {
    let buffer = this.buffer;
    let ptr = this.ptr >>> 0;

    /**
     * 在当前计算的坐标轴方向上的深度
     */
    const z = this.z | 0;
    const u = this.u | 0;
    const v = this.v | 0;

    /**
     * 当前计算的坐标轴，0=X 1=Y 2=Z
     */
    const dimension = this.dimension | 0;

    //  Grow buffer if we exceed capacity
    if (ptr + SURFACE_VERTEX_SIZE > buffer.length) {
      const tmp = mallocUint16(2 * buffer.length);
      tmp.set(buffer);
      freeUint16(buffer);
      buffer = tmp;
      this.buffer = buffer;
    }

    const flip = !!(val & FLIP_BIT);
    const side: SideDirection = dimension + (flip ? 3 : 0);

    const topLeftAOType = (val >>> AO_SHIFT) & AO_MASK;
    const topRightAOType = (val >>> TR_AO_SHIFT) & AO_MASK;
    const bottomRightAOType = (val >>> BR_AO_SHIFT) & AO_MASK;
    const bottomLeftAOType = (val >>> BL_AO_SHIFT) & AO_MASK;

    const packedAO =
      (bottomLeftAOType << 6) +
      (bottomRightAOType << 4) +
      (topRightAOType << 2) +
      topLeftAOType;
    const packedUVD = (u << 4) + (v << 2) + dimension; // TODO 坐标轴顺序信息，但完全没有用到
    const topLeftAO = AO_TABLE[topLeftAOType];
    const topRightAO = AO_TABLE[topRightAOType];
    const bottomRightAO = AO_TABLE[bottomRightAOType];
    const bottomLeftAO = AO_TABLE[bottomLeftAOType];

    const textureID = voxelTexture(
      val & VOXEL_MASK,
      side,
      this.voxelSideTextureIDs,
    );

    let nx = 128,
      ny = 128,
      nz = 128;
    const sign = flip ? 127 : 129;
    if (dimension === 0) {
      nx = sign;
    } else if (dimension === 1) {
      ny = sign;
    } else if (dimension === 2) {
      nz = sign;
    }

    // 见 https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/
    let flipAO = topLeftAO + bottomRightAO < topRightAO + bottomLeftAO;

    if (topLeftAO + bottomRightAO === topRightAO + bottomLeftAO) {
      flipAO =
        Math.max(topLeftAO, bottomRightAO) < Math.max(topRightAO, bottomLeftAO);
    }
    const normalCode = calcNormalCode(nx, ny, nz);

    if (flipAO) {
      if (!flip) {
        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;
        ptr += 8;
      } else {
        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;
      }
    } else {
      //Check if flipped
      if (flip) {
        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;
      } else {
        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = hi_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = bottomRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = hi_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topRightAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;

        buffer[ptr + u] = lo_x;
        buffer[ptr + v] = lo_y;
        buffer[ptr + dimension] = z;
        buffer[ptr + 3] = topLeftAO;
        buffer[ptr + 4] = packedUVD;
        buffer[ptr + 5] = normalCode;
        buffer[ptr + 6] = packedAO;
        buffer[ptr + 7] = textureID;

        ptr += 8;
      }
    }
    this.ptr = ptr;
  }
}
