import { vec3 } from 'gl-matrix';
import { store } from '../../redux/store';
import type { SerializedVec3 } from '../../utils/math';
import { isPaletteItemValid } from '../palette/util';
import { TEXTURE_MASK } from '../rendering/objects/voxels/mesher/def';

/**
 * 更新网格的颜色
 * @param out 网格数据
 * @param colorIndices 网格的颜色索引
 * @param textureId 只更新特定textureId。默认更新全部。
 */
export function updateRawMeshTexture(
  out: Uint16Array,
  colorIndices: Uint16Array,
  textureId?: number,
) {
  const toUpdate: (curTextureId: number) => boolean =
    textureId !== undefined
      ? (curTextureId) => curTextureId === textureId
      : () => true;

  for (let i = 0; i < colorIndices.length; i++) {
    const curTextureId = colorIndices[i];
    if (!toUpdate(curTextureId)) {
      continue;
    }

    const paletteItem = store.getState().palette.items[curTextureId];

    if (!isPaletteItemValid(paletteItem)) {
      continue;
    }

    const [r, g, b] = paletteItem.rgb;
    const emissive = paletteItem.material.emissive;

    out[i * 9 + 4] = r;
    out[i * 9 + 5] = g;
    out[i * 9 + 6] = b;
    out[i * 9 + 8] = emissive;
  }
}

/**
 * 判断bounds是否为空
 */
export function isEmptyBounds(bounds: SerializedVec3) {
  return vec3.exactEquals(bounds, [0, 0, 0]);
}

type LoadRawMeshRes = {
  mesh: Uint16Array;
  colorIndex: Uint16Array;
  bounds: SerializedVec3;
  lo: SerializedVec3;
  hi: SerializedVec3;
};

/**
 * 加载ao-mesher生成的网格。会执行如下操作：
 * 1. 根据当前store中的色板，更新网格颜色
 * 2. 生成网格对应的颜色索引。
 * 3. 计算bounds大小。如果为空，则为0
 * 4. 计算三角形顶点的最低点与最高点。
 * @modifies meshData ao-mesher生成的网格数据
 */
export function loadRawMesh(meshData: Uint16Array): LoadRawMeshRes {
  const mesh = new Uint16Array((meshData.length / 8) * 9);
  const colorIndex = new Uint16Array(meshData.length / 8);

  let indexPtr = 0;

  const bounds: SerializedVec3 = [0, 0, 0];

  const lo: SerializedVec3 = [Infinity, Infinity, Infinity];
  const hi: SerializedVec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < meshData.length; i += 8) {
    const textureId = meshData[i + 7] & TEXTURE_MASK;

    const paletteItem = store.getState().palette.items[textureId];

    colorIndex[indexPtr] = textureId;

    let r = 0;
    let g = 0;
    let b = 0;
    let emissive = 0;

    if (isPaletteItemValid(paletteItem)) {
      [r, g, b] = paletteItem.rgb;
      emissive = paletteItem.material.emissive;
    }

    const normalCode = meshData[i + 5];

    const pos: vec3 = [meshData[i], meshData[i + 1], meshData[i + 2]];

    vec3.min(lo, lo, pos);
    vec3.max(hi, hi, pos);

    const index = 9 * indexPtr;

    mesh[index] = meshData[i];
    mesh[index + 1] = meshData[i + 1];
    mesh[index + 2] = meshData[i + 2];
    mesh[index + 3] = meshData[i + 3];

    mesh[index + 4] = r;
    mesh[index + 5] = g;
    mesh[index + 6] = b;
    mesh[index + 7] = normalCode;

    mesh[index + 8] = emissive;

    indexPtr++;
  }

  if (hi[0] >= lo[0] && hi[1] >= lo[1] && hi[2] >= lo[2]) {
    vec3.sub(bounds, hi, lo);
  }

  return {
    mesh: mesh,
    bounds,
    lo,
    hi,
    colorIndex,
  };
}
