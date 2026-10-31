import { nanoid } from 'nanoid';
import { allocEmptyVoxels, inRange } from '@box/utils/helper';
import type { VoxelView } from '@box/utils/voxel';
import type { ShapEModel } from '@box/apis';
import type { SerializedVec3 } from '@box/box-design';
import type { Palette } from '../palette';
import { MAX_VOXEL_SIZE, MIN_VOXEL_SIZE } from '../../defs';
import type { ValidPaletteItem } from '../../redux/palette-slice';
import { RGBToHsv } from '../../utils/color';
import { PALETTE_GROUP_NAME, incrementalNaming } from '../../utils/naming';
import { store } from '../../redux/store';
import { isPaletteItemValid } from '../palette/util';
import type { VoxelApp } from '../voxel-app';
import type { EditingHistory } from '../editing-history';
import { kMeansPlus } from './k-means';

type Params = {
  palette: Palette;
  voxelApp: VoxelApp;
  history: EditingHistory;
};

const MIN_SHAPE: SerializedVec3 = [
  MIN_VOXEL_SIZE,
  MIN_VOXEL_SIZE,
  MIN_VOXEL_SIZE,
];
const MAX_SHAPE: SerializedVec3 = [
  MAX_VOXEL_SIZE,
  MAX_VOXEL_SIZE,
  MAX_VOXEL_SIZE,
];

type GetPaletteItemIdByIndex = (idx: number) => number;

type LoadParams = {
  shapEModel: ShapEModel;
  voxelId: string;
};

/**
 * 加载ShapE数据
 */
export class ShapELoader {
  private palette: Palette;

  private voxelApp: VoxelApp;

  private history: EditingHistory;

  constructor(params: Params) {
    const { palette, voxelApp, history } = params;

    this.palette = palette;

    this.voxelApp = voxelApp;
    this.history = history;
  }

  /**
   * 加载ShapE模型数据
   */
  public load(params: LoadParams): { shape: SerializedVec3 } | undefined {
    const { shapEModel, voxelId } = params;
    const { colors, grid_index: voxels, shape } = shapEModel;

    const getItemIdByIndex = this.loadColors(colors);

    const voxelView = this.getVoxelView({ voxels, shape, getItemIdByIndex });

    if (!voxelView) {
      return;
    }

    if (store.getState().app.editingVoxelId === voxelId) {
      this.updateEditingVoxel(voxelView);
    } else {
      if (!this.voxelApp.voxelManager.map.has(voxelId)) {
        this.voxelApp.voxelManager.addModel(voxelId, voxelView);
      }

      this.voxelApp.voxelManager.updateVoxelModel(voxelId, voxelView);
    }

    return { shape: [...voxelView.shape] };
  }

  /**
   * 在体素编辑界面，覆盖编辑区信息。
   */
  private updateEditingVoxel(voxelView: VoxelView) {
    const { destination, selection } = this.voxelApp.models;

    this.history.saveVoxel({
      destVoxel: destination.voxels,
      selectVoxel: selection.voxels,
    });

    this.voxelApp.applyVoxels([voxelView]);

    this.history.saveVoxel({
      destVoxel: destination.voxels,
      selectVoxel: selection.voxels,
    });
  }

  /**
   * 加载ShapE模型的色板，并生成一个新的颜色分组。
   * 使用k-means++聚类方法减少颜色
   * @param rawColors ShapE模型的色板数据
   */
  private loadColors(colors: ShapEModel['colors']): GetPaletteItemIdByIndex {
    const rgbToIdx = new Map<string, number>();
    const idxToItemIdx = new Map<number, number>();

    const items: ValidPaletteItem[] = [];

    const rgbList = kMeansPlus({ rgbList: colors });

    // 生成颜色数据，合并相同颜色
    rgbList.forEach((color, idx) => {
      const rgb = color.map((v) => Math.round(v * 255));

      const key = rgb.join(',');

      const itemIdx = rgbToIdx.get(key);

      if (itemIdx !== undefined) {
        idxToItemIdx.set(idx, itemIdx);
      } else {
        const [r, g, b] = rgb;

        items.push({
          rgb: [r, g, b],
          hsv: RGBToHsv(r, g, b),
          material: { emissive: 0 },
        });

        rgbToIdx.set(key, items.length - 1);
        idxToItemIdx.set(idx, items.length - 1);
      }
    });

    const name = incrementalNaming(
      PALETTE_GROUP_NAME,
      Object.values(store.getState().palette.groups),
      (val, newName) => val.name !== newName,
    );

    const groupId = nanoid();

    const itemIds = this.palette.addGroup({ id: groupId, name, items });

    // 查找色板首个有效数据，作为体素点颜色映射的兜底颜色
    const defaultItemId = store
      .getState()
      .palette.items.findIndex(isPaletteItemValid);

    return (idx) => {
      const itemIdx = idxToItemIdx.get(idx) || 0;

      return itemIds[itemIdx] || defaultItemId;
    };
  }

  private getVoxelView(params: {
    /**
     * 有体素的体素点坐标
     */
    voxels: SerializedVec3[];
    shape: SerializedVec3;
    getItemIdByIndex: GetPaletteItemIdByIndex;
  }) {
    const { voxels: voxelPoints, getItemIdByIndex, shape } = params;

    if (!inRange(shape, MIN_SHAPE, MAX_SHAPE)) {
      console.warn('ShapeLoader get illegal shape', shape.toString());

      return;
    }

    // 绕x轴旋转90%，也就是调换y跟z
    const [sx, sz, sy] = shape;
    const voxelView = allocEmptyVoxels(sx, sy, sz);

    voxelPoints.forEach(([x, z, y], idx) => {
      voxelView.setVoxel(x, y, sz - z - 1, getItemIdByIndex(idx));
    });

    return voxelView;
  }
}
