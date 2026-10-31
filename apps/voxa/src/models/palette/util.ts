import {
  EmptyPaletteItem,
  EMPTY_PALETTE_ITEM,
  PaletteItems,
  ValidPaletteItem,
} from '../../redux/palette-slice';
import { SerializedVec3 } from '../../utils/math';

export function isPaletteItemValid(
  item: ValidPaletteItem | EmptyPaletteItem | undefined,
): item is ValidPaletteItem {
  return !!item && item !== EMPTY_PALETTE_ITEM;
}

/**
 * 传入色板数据生成mesher需要的颜色和发光数据
 */
export function getMesherTextureData(items: PaletteItems): {
  paletteList: SerializedVec3[];
  emissiveList: number[];
} {
  const paletteList: SerializedVec3[] = [];
  const emissiveList: number[] = [];

  items.forEach((item) => {
    let [r, g, b] = [0, 0, 0];
    let emissive = 0;

    if (isPaletteItemValid(item)) {
      [r, g, b] = item.rgb;
      emissive = item.material.emissive;
    }

    paletteList.push([r, g, b]);
    emissiveList.push(emissive);
  });

  return {
    paletteList,
    emissiveList,
  };
}
