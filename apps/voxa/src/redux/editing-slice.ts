import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Actions, EditingMode } from '@box/utils/helper';
import { AxisType } from '@box/box-design';
import { DEFAULT_SPACE_SIZE } from '../defs';
import { VoxelDimensionType } from '../models/project/interfaces';
import { VoxelDimension } from '../models/project/defs';

export type MirrorMode = Record<AxisType, boolean>;

export type EditingState = {
  /**
   * 编辑的模式
   */
  mode: EditingMode;
  /**
   * 编辑的行为
   */
  toolType: Actions;
  /**
   * 模型空间的大小
   */
  workspaceSize: [number, number, number];
  /**
   * 模型渲染维度
   */
  dimension: VoxelDimensionType;
  /**
   * 镜像模式
   */
  mirrorMode: MirrorMode;
  /**
   * 是否展示体素的网格。
   */
  voxelGridVisible: boolean;
  /**
   * 体建造时，层数提示的数值。
   */
  layersTips: {
    visible: boolean;
    layers: string;
    position: [number, number];
  };
};

const initialState: EditingState = {
  mode: EditingMode.box,
  toolType: Actions.Attach,
  workspaceSize: DEFAULT_SPACE_SIZE,
  dimension: VoxelDimension.XYZ,
  mirrorMode: { X: false, Y: false, Z: false },
  voxelGridVisible: false,
  layersTips: {
    visible: false,
    layers: '',
    position: [0, 0],
  },
};

export const EDITING_SLICE_NAME = 'editing';

export const editingSlice = createSlice({
  name: EDITING_SLICE_NAME,
  initialState,
  reducers: {
    setEditingState(state, action: PayloadAction<EditingState>) {
      Object.assign(state, action.payload);
    },
    setTool(
      state,
      action: PayloadAction<Partial<Pick<EditingState, 'toolType' | 'mode'>>>,
    ) {
      Object.assign(state, action.payload);
    },
    setWorkspaceSize(
      state,
      action: PayloadAction<Pick<EditingState, 'workspaceSize'>>,
    ) {
      Object.assign(state, action.payload);
    },
    setDimension(
      state,
      action: PayloadAction<Pick<EditingState, 'dimension'>>,
    ) {
      Object.assign(state, action.payload);
    },
    setMirrorMode(
      state,
      action: PayloadAction<Pick<EditingState, 'mirrorMode'>>,
    ) {
      Object.assign(state, action.payload);
    },
    setVoxelGridVisible(
      state,
      action: PayloadAction<Pick<EditingState, 'voxelGridVisible'>>,
    ) {
      state.voxelGridVisible = action.payload.voxelGridVisible;
    },
    setLayersTips(
      state,
      action: PayloadAction<Partial<EditingState['layersTips']>>,
    ) {
      Object.assign(state.layersTips, action.payload);
    },
  },
});

export const {
  setEditingState,
  setTool,
  setWorkspaceSize,
  setDimension,
  setMirrorMode,
  setVoxelGridVisible,
  setLayersTips,
} = editingSlice.actions;

export type EditingSlice = typeof editingSlice.actions;

export type EditingActions = ReturnType<EditingSlice[keyof EditingSlice]>;
