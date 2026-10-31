import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type PermissionState = {
  /**
   * 使用编辑器的权限
   */
  edit: boolean;
  /**
   * 多部件编辑权限
   */
  editParts: boolean;
  /**
   * 动画编辑权限
   */
  editAnimations: boolean;
};

const initialState: PermissionState = {
  edit: false,
  editParts: false,
  editAnimations: false,
};

export const PERMISSION_SLICE_NAME = 'permission';

export const permissionSlice = createSlice({
  name: PERMISSION_SLICE_NAME,
  initialState,
  reducers: {
    setPermissions(state, action: PayloadAction<Partial<PermissionState>>) {
      Object.assign(state, action.payload);
    },
  },
});

export const { setPermissions } = permissionSlice.actions;

export type PermissionSlice = typeof permissionSlice.actions;

export type PermissionActions = ReturnType<
  PermissionSlice[keyof PermissionSlice]
>;
