import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { SerializedVec3 } from '../utils/math';

export type PaletteState = {
  /**
   * 选中的颜色ID
   */
  selectedId: number;
  /**
   * 颜色列表。总表。成员的id即成员的序号。
   * 有效效数据范围是[1, TEXTURE_MASK]，0是保留位，用于对齐体素的颜色与色板颜色。
   */
  items: PaletteItems;
  /**
   * view的颜色分组的顺序列表。
   */
  groupList: string[];
  /**
   * 引用关系
   */
  groups: Record<string, PaletteGroup>;
};

export const EMPTY_PALETTE_ITEM = -1;

export type EmptyPaletteItem = typeof EMPTY_PALETTE_ITEM;

export type PaletteItems = (ValidPaletteItem | EmptyPaletteItem)[];

/**
 * “分组”的引用
 */
export type PaletteGroup = {
  id: string;
  name: string;
  itemIds: number[];
};

export type ValidPaletteItem = {
  rgb: PaletteRGB;
  hsv: PaletteHSV;
  material: PaletteMaterial;
};

export type PaletteRGB = SerializedVec3;

export type PaletteHSV = SerializedVec3;

export type PaletteMaterial = {
  /**
   * 发光度，取值范围0-255
   */
  emissive: number;
};

export const DEFAULT_GROUP_ID = 'default';

const initialState: PaletteState = {
  selectedId: 0,
  items: [EMPTY_PALETTE_ITEM],
  groupList: [],
  groups: {},
};

export type SetEntirePaletteAction = PayloadAction<PaletteState>;

export type SetPaletteItemParams = {
  id: number;
  rgb?: PaletteRGB;
  hsv?: PaletteHSV;
  material?: PaletteMaterial;
};

export const PALETTE_SLICE_NAME = 'palette';

export const paletteSlice = createSlice({
  name: PALETTE_SLICE_NAME,
  initialState,
  reducers: {
    setPaletteState(state, action: SetEntirePaletteAction) {
      Object.assign(state, action.payload);
    },
    setSelectedId(state, action: PayloadAction<number>) {
      state.selectedId = action.payload;
    },
    setPaletteItems(state, action: PayloadAction<{ items: PaletteItems }>) {
      state.items = action.payload.items;
    },
    addPaletteGroup(state, action: PayloadAction<PaletteGroup>) {
      const { id } = action.payload;

      state.groups[id] = action.payload;

      state.groupList.push(id);
    },
    setGroupItems(
      state,
      action: PayloadAction<{
        groupId: string;
        itemIds: number[];
      }>,
    ) {
      const { groupId, itemIds } = action.payload;

      if (!state.groups[groupId]) {
        return;
      }

      state.groups[groupId].itemIds = itemIds;
    },
    setPaletteItem(state, action: PayloadAction<SetPaletteItemParams>) {
      const { id, ...others } = action.payload;

      Object.assign(state.items[id], others);
    },
    clearPalette(state) {
      state = { ...initialState };
    },
    removePaletteGroup(state, action: PayloadAction<string>) {
      const groupId = action.payload;

      const newGroups: Record<string, PaletteGroup> = {};

      const newGroupList = state.groupList.filter((id) => {
        const toKeep = id !== groupId;

        if (toKeep) {
          newGroups[id] = state.groups[id];
        }

        return toKeep;
      });

      state.groups = newGroups;
      state.groupList = newGroupList;
    },
  },
});

export const {
  setPaletteState,
  setSelectedId,
  setPaletteItem,
  setPaletteItems,
  setGroupItems,
  addPaletteGroup,
  clearPalette,
  removePaletteGroup,
} = paletteSlice.actions;

export type PaletteSlice = typeof paletteSlice.actions;

export type PaletteActions = ReturnType<PaletteSlice[keyof PaletteSlice]>;
