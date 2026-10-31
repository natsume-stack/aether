import { store } from '../../redux/store';
import { last } from 'ramda';
import {
  setGroupItems,
  ValidPaletteItem,
  PaletteItems,
  addPaletteGroup,
  setPaletteItems,
  setSelectedId,
  clearPalette,
  EMPTY_PALETTE_ITEM,
  removePaletteGroup,
} from '../../redux/palette-slice';
import { DEFAULT_GROUP_ID } from '../../defs';
import type { EditingHistory } from '../editing-history';
import { isPaletteItemValid } from './util';
import type { IResult } from '../result/interfaces';
import { ok } from '../result';
import type { VoxelApp } from '../voxel-app';
import type { AnimatorApp } from '../animator-app';
import { TEXTURE_MASK } from '../rendering/objects/voxels/mesher/def';
import { updateRawMeshTexture } from '../voxel-model/util';
import { isSkinPart } from '../animator-app/util';
import { ProjectNodeType } from '../../redux/animator-slice';
import type {
  ProjectPaletteItem,
  ProjectPaletteItems,
} from '../project/interfaces';
import { serializeVec3 } from '../../utils/math';

/**
 * @box/ao-mesher能够支持的texture长度。
 */
export const MAX_PALETTE_LENGTH = TEXTURE_MASK;
/**
 * 0为占位，也就是id为0必定是空数据（EMPTY_PALETTE_ITEM)
 * 目的是为了体素（VoxelView）与色板数据对齐。
 */
const OCCUPIED_ID = 0;

type AddItemsOptions = {
  items: ValidPaletteItem[] | ProjectPaletteItems;
};

type AddGroupOptions = {
  id: string;
  name: string;
  items: ValidPaletteItem[];
};

type AddGroupItemsOptions = {
  id: string;
  items: ValidPaletteItem[];
};

type InsertResult = IResult<{
  items: PaletteItems;
  itemIds: number[];
}>;

type InitParams = {
  history: EditingHistory;
  voxelApp: VoxelApp;
  animatorApp: AnimatorApp;
};

/**
 * 管理色板数据
 */
export class Palette {
  private history: EditingHistory;
  private voxelApp: VoxelApp;
  private animatorApp: AnimatorApp;

  constructor({ history, voxelApp, animatorApp }: InitParams) {
    this.history = history;

    this.voxelApp = voxelApp;

    this.animatorApp = animatorApp;

    this.history.registerActionCallback('setPaletteItem', ({ id }) => {
      this.updateMeshTexture(id);
    });
  }

  /**
   * 添加颜色
   * @param options store颜色数组或者工程颜色数组
   * @returns 正常添加时，返回与参数相同长度的数组，代表新的颜色索引；失败时，返回空数组。
   */
  public addItems(options: AddItemsOptions): number[] {
    const { items: optionItems } = options;

    const { items } = store.getState().palette;

    const result = this.insert(optionItems, items);

    if (ok(result)) {
      const { items, itemIds } = result.body;

      this.history.saveAction({
        action: setPaletteItems({ items }),
      });

      return itemIds;
    }

    return [];
  }

  /**
   * 新增颜色分组
   * @param 新增颜色分组参数
   * @return 新增分组时，插入的颜色id。如果长度与入参长度不同，说明新增分组失败。
   */
  public addGroup(options: AddGroupOptions) {
    const { id, name, items } = options;

    this.history.setGroup();

    let itemIds: number[] = [];

    if (items.length > 0) {
      itemIds = this.addItems({ items });

      if (itemIds.length === 0) {
        console.error('Cannot add more items');

        this.history.unsetGroup();

        return itemIds;
      }
    }

    this.history.saveAction({
      action: addPaletteGroup({
        id,
        name,
        itemIds,
      }),
    });

    this.history.unsetGroup();

    return itemIds;
  }

  /**
   * 给特定的分组插入颜色
   * @param options 插入颜色的参数
   * @returns 插入颜色后，颜色的id数组，顺序与入参顺序相同。如果长度与入参长度不同，表示插入失败。
   */
  public addGroupItems(options: AddGroupItemsOptions) {
    const { id, items } = options;

    const { groups } = store.getState().palette;

    const group = groups[id];

    let itemIds: number[] = [];

    if (!group) {
      return itemIds;
    }

    this.history.setGroup();

    itemIds = this.addItems({ items });

    if (itemIds.length === 0) {
      console.error('Cannot add more items');

      this.history.unsetGroup();

      return itemIds;
    }

    this.history.saveAction({
      action: setGroupItems({
        groupId: id,
        itemIds: group.itemIds.concat(itemIds),
      }),
    });

    const lastId = last(itemIds);

    if (lastId !== undefined) {
      this.history.saveAction({
        action: setSelectedId(lastId),
      });
    }

    this.history.unsetGroup();

    return itemIds;
  }

  /**
   *
   * @param insertItems 需要插入的色板数据
   * @param prevItems
   * @returns
   */
  private insert(
    insertItems: (ValidPaletteItem | ProjectPaletteItem)[],
    prevItems: PaletteItems,
  ): InsertResult {
    let count = 0;

    let toInsertLength = insertItems.length;

    const newItems = prevItems.slice();

    const indices: number[] = [];

    insertItems.every((item) => {
      for (; count < MAX_PALETTE_LENGTH; count++) {
        // 0为占位，跳过
        if (count === OCCUPIED_ID) {
          continue;
        }

        // 已到达最大的值，不能再插入。
        if (count === MAX_PALETTE_LENGTH) {
          return false;
        }

        // 如果对应的坑没有有效数据，则直接塞入新的数据
        if (!isPaletteItemValid(newItems[count])) {
          newItems[count] = {
            hsv: serializeVec3(item.hsv),
            rgb: serializeVec3(item.rgb),
            material: { emissive: item.material.emissive },
          };

          toInsertLength--;

          indices.push(count);

          return true;
        }
      }
    });

    // 仍有剩余，说明还有没插入的数据
    if (toInsertLength !== 0) {
      return { isSuccess: false };
    }

    return {
      isSuccess: true,
      body: {
        items: newItems,
        itemIds: indices,
      },
    };
  }

  /**
   * 传入颜色id，更新引用该颜色的mesh
   */
  public updateMeshTexture(itemId: number) {
    const { app, animator } = store.getState();

    app.editingVoxelId && this.updateEditingModelMesh(itemId);

    let hierarchies = Object.values(animator.hierarchyData);

    this.voxelApp.voxelManager.map.forEach(({ id: currentVoxelId, meshes }) => {
      Object.values(meshes).forEach(({ colorIndex, rawMeshBuffer }) => {
        if (!colorIndex.includes(itemId)) {
          return;
        }

        updateRawMeshTexture(rawMeshBuffer, colorIndex);
      });

      hierarchies = hierarchies.filter((hierarchy) => {
        // 没有节点，没有voxelId，下次不再需要检查
        if (
          !hierarchy ||
          hierarchy.type !== ProjectNodeType.SkinPart ||
          !hierarchy.voxelId
        ) {
          return false;
        }

        const skinNode = this.animatorApp.nodeManager.getSkinNode(hierarchy.id);

        // 查不到对应的skinPart，下次不再检查
        if (!skinNode || !isSkinPart(skinNode)) {
          return false;
        }

        // skinPart的voxelId与当前不同，下次继续检查
        if (hierarchy.voxelId !== currentVoxelId) {
          return true;
        }

        const newMesh = this.voxelApp.voxelManager.getVoxelMesh(
          currentVoxelId,
          hierarchy.flip,
        );

        newMesh && skinNode.skinPartMesh.updateBuffer(newMesh.rawMeshBuffer);

        return false;
      });
    });
  }

  private updateEditingModelMesh(paletteItemId: number) {
    const { destination, selection } = this.voxelApp.models;

    [destination, selection].forEach((voxelModel) => {
      voxelModel.updateMeshColor(paletteItemId);
    });
  }

  private getEditingModelTextureIds(out: Set<number>) {
    const { destination, selection } = this.voxelApp.models;

    [destination, selection].forEach((voxelModel) => {
      voxelModel.voxels.data.forEach((textureId) => {
        if (textureId !== 0) {
          out.add(textureId);
        }
      });
    });
  }

  /**
   * 清除当前色板的所有数据
   */
  public clear() {
    store.dispatch(clearPalette());
  }

  /**
   * 清理未被选中、且未被体素使用的颜色
   */
  public removeUnusedItems(params?: { usedIds: Set<number>; groupId: string }) {
    const { palette } = store.getState();

    const { groups, items } = palette;

    let usedIds: Set<number>;
    let toRemoveGroupItems: (id: string) => boolean = (id) => true;

    if (params) {
      usedIds = params.usedIds;

      usedIds.add(store.getState().palette.selectedId);

      toRemoveGroupItems = (id) => id === params.groupId;
    } else {
      usedIds = this.collectUsedIds();
    }

    this.history.setGroup();

    const toRemoveItemIds: number[] = [];

    Object.values(groups).forEach((group) => {
      if (!toRemoveGroupItems(group.id)) {
        return;
      }

      const newItemIds = group.itemIds.filter((id) => {
        if (usedIds.has(id)) {
          return true;
        }

        toRemoveItemIds.push(id);
      });

      this.history.saveAction({
        action: setGroupItems({
          groupId: group.id,
          itemIds: newItemIds,
        }),
      });
    });

    const newItems = items.slice();

    toRemoveItemIds.map((id) => {
      newItems[id] = EMPTY_PALETTE_ITEM;
    });

    this.history.saveAction({
      action: setPaletteItems({
        items: newItems,
      }),
    });

    this.history.unsetGroup();
  }

  /**
   * 收集正在被使用的颜色id。
   */
  private collectUsedIds(): Set<number> {
    const { app, palette } = store.getState();

    const { editingVoxelId } = app;

    const { selectedId } = palette;

    // 默认保留当前选中的id
    const usedIds = new Set<number>([selectedId]);

    // 如果当前有正在编辑的数据，直接从编辑的model中提取
    if (editingVoxelId) {
      this.getEditingModelTextureIds(usedIds);
    }

    // 从部件中整理出未被使用的id
    this.voxelApp.voxelManager.map.forEach((voxelModel) => {
      // 如果是当前正在编辑的，不用另外处理
      if (editingVoxelId === voxelModel.id) {
        return;
      }

      const { voxelView } = voxelModel;

      voxelView.data.forEach((id) => {
        id !== 0 && usedIds.add(id);
      });
    });

    return usedIds;
  }

  /**
   * 删除颜色分组
   * 如果组内没有颜色，直接删除。
   * 如果有颜色，则把使用中的颜色移到默认分组，其他连带组一并删除。
   * @param id 颜色分组id
   */
  public removeGroup(id: string) {
    const { palette } = store.getState();

    const { groups, items } = palette;

    const group = groups[id];

    if (!group) {
      return;
    }

    if (group.itemIds.length === 0) {
      this.history.saveAction({
        action: removePaletteGroup(id),
      });
      return;
    }

    const usedIds = this.collectUsedIds();

    const newItems = items.slice();

    const newGroupItems = group.itemIds.filter((id) => {
      if (usedIds.has(id)) {
        return true;
      }

      newItems[id] = EMPTY_PALETTE_ITEM;

      return false;
    });

    this.history.setGroup();

    this.history.saveAction({
      action: setGroupItems({
        groupId: DEFAULT_GROUP_ID,
        itemIds: groups[DEFAULT_GROUP_ID].itemIds.concat(newGroupItems),
      }),
    });

    this.history.saveAction({
      action: setPaletteItems({ items: newItems }),
    });

    this.history.saveAction({
      action: removePaletteGroup(id),
    });

    this.history.unsetGroup();
  }
}
