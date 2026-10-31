import { CreativeMode, ModelType } from '@box/apis';
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { DEFAULT_PROJECT_NAME } from '../defs';
import { DEFAULT_ZOOM_WIDTH } from '../views/motions/hierarchy-timelines/const';
import type { UserInfo } from '../interface';
import type { EditLockInfo } from '../utils/edit-lock';

export enum AppMode {
  Animator,
  Voxel,
}

export enum PointerAction {
  Idle,
  /**
   * 鼠标处于拖拽状态
   */
  Dragging,
}

export enum LaunchState {
  Idle,
  Launching,
  Success,
  Fail,
}

export type ParentType = 'none' | 'engine';

type ContextmenuProps = {
  /**
   * 位置，[left top]
   */
  position: [number, number];
  /**
   * 是否可见
   */
  visible: boolean;
};

export type MotionPanelProps = {
  /**
  /**
   * 时间轴面板的缩放宽度
   * 不使用缩放比例是因为，缩放比例的范围会变化。
   */
  zoomWidth: number;
  /**
   * 当前光标指向的时间
   */
  currentTime: number;

  /**
   * 是否正在播放动作
   */
  playing: boolean;
};

export enum SaveState {
  Idle,
  Saving,
  Failed,
}

export enum EditType {
  /**
   * 普通模式
   */
  Normal,
  /**
   * 皮肤模式
   */
  Skin,
}

export const creativeModeToEditTypeMap = {
  [CreativeMode.Model]: EditType.Normal,
  [CreativeMode.Skin]: EditType.Skin,
};

export type NodeAlphaCache = Record<string, number>;

export type AppState = {
  /**
   * app模式
   * 分为多部件动画模式和体素模式
   */
  mode: AppMode;
  /**
   * 正在编辑体素的部件ID
   */
  editingSkinPartId?: string;
  /**
   * 正在编辑的体素ID
   */
  editingVoxelId?: string;
  /**
   * 当前点击状态
   */
  pointerAction: PointerAction;
  /**
   * 页面启动状态
   */
  launchState: LaunchState;
  /**
   * 是否展示右键菜单
   */
  contextmenu: ContextmenuProps;
  /**
   * 是否嵌入在arena的模式
   */
  parentType: ParentType;
  /**
   * 动作面板属性
   */
  motionPanel: MotionPanelProps;
  /**
   * 自动保存、手动保存的状态
   */
  saveState: SaveState;
  /**
   * 是否正在发布中
   */
  isPublishing: boolean;
  /**
   * 当前工程id。
   * 如果为0，代表未载入已有任何工程。
   */
  projectId: number;
  /**
   * 当前工程类型。
   */
  projectType: ModelType;
  /**
   * 作品名
   */
  projectName: string;
  /**
   * 编辑历史记录
   */
  history: {
    undoEnabled: boolean;
    redoEnabled: boolean;
  };
  userInfo: UserInfo;
  /**
   * 编辑模式
   */
  editType: EditType;
  /**
   * 皮肤的来源地图Id
   */
  sourceMapId: number;
  /**
   * External edit lock (CLI / another tab). `null` means unknown or unlocked.
   */
  editLock: EditLockInfo | null;
  /**
   * 部件节点的透明度缓存，用于数据统计判断是否
   * - 静态模式下，拖拽修改透明度前，缓存节点的透明度
   * - 切换到动画模式时，缓存节点透明度
   */
  nodeAlphaCache?: NodeAlphaCache;
  /**
   * 是否开启数据统计
   */
  profilerEnabled: boolean;
};

const initialState: AppState = {
  mode: AppMode.Animator,
  pointerAction: PointerAction.Idle,
  launchState: LaunchState.Idle,
  contextmenu: {
    position: [0, 0],
    visible: false,
  },
  parentType: 'none',
  motionPanel: {
    zoomWidth: DEFAULT_ZOOM_WIDTH,
    currentTime: 0,
    playing: false,
  },
  saveState: SaveState.Idle,
  isPublishing: false,
  projectId: 0,
  projectType: ModelType.Private,
  projectName: DEFAULT_PROJECT_NAME,
  history: {
    undoEnabled: false,
    redoEnabled: false,
  },
  userInfo: {
    userId: 0,
    avatar: '',
    isAdmin: false,
  },
  editType: EditType.Normal,
  sourceMapId: 0,
  editLock: null,
  profilerEnabled: false,
};

export type SetAppMode = PayloadAction<AppMode>;

export const APP_SLICE_NAME = 'app';

export const appSlice = createSlice({
  name: APP_SLICE_NAME,
  initialState,
  reducers: {
    setAppState(state, action: PayloadAction<AppState>) {
      Object.assign(state, action.payload);
    },
    setAppMode(state, action: SetAppMode) {
      state.mode = action.payload;
    },
    setEditingSkinPartId(state, action: PayloadAction<string | undefined>) {
      state.editingSkinPartId = action.payload;
    },
    setEditingVoxelId(state, action: PayloadAction<string | undefined>) {
      state.editingVoxelId = action.payload;
    },
    setPointerAction(state, action: PayloadAction<PointerAction>) {
      state.pointerAction = action.payload;
    },
    setLaunchState(state, action: PayloadAction<LaunchState>) {
      state.launchState = action.payload;
    },
    setContextmenu(state, action: PayloadAction<Partial<ContextmenuProps>>) {
      Object.assign(state.contextmenu, action.payload);
    },
    setParentType(state, action: PayloadAction<ParentType>) {
      state.parentType = action.payload;
    },
    setCurrentTime(state, action: PayloadAction<number>) {
      state.motionPanel.currentTime = action.payload;
    },
    setPlaying(state, action: PayloadAction<boolean>) {
      state.motionPanel.playing = action.payload;
    },
    setTimelineZoomWidth(state, action: PayloadAction<number>) {
      state.motionPanel.zoomWidth = action.payload;
    },
    setSaveState(state, action: PayloadAction<SaveState>) {
      state.saveState = action.payload;
    },
    setPublishing(state, action: PayloadAction<boolean>) {
      state.isPublishing = action.payload;
    },
    setProjectId(state, action: PayloadAction<number>) {
      state.projectId = action.payload;
    },
    setProjectType(state, action: PayloadAction<ModelType>) {
      state.projectType = action.payload;
    },
    setProjectName(state, action: PayloadAction<string>) {
      state.projectName = action.payload;
    },
    setRedoEnabled(state, action: PayloadAction<boolean>) {
      state.history.redoEnabled = action.payload;
    },
    setUndoEnabled(state, action: PayloadAction<boolean>) {
      state.history.undoEnabled = action.payload;
    },
    setUserInfo(state, action: PayloadAction<Partial<UserInfo>>) {
      Object.assign(state.userInfo, action.payload);
    },
    setEditType(state, action: PayloadAction<EditType>) {
      state.editType = action.payload;
    },
    setSourceMapId(state, action: PayloadAction<number>) {
      state.sourceMapId = action.payload;
    },
    setEditLock(state, action: PayloadAction<EditLockInfo | null>) {
      state.editLock = action.payload;
    },
    setNodeAlphaCache(
      state,
      action: PayloadAction<NodeAlphaCache | undefined>,
    ) {
      state.nodeAlphaCache = action.payload;
    },
    setProfilerEnabled(state, action: PayloadAction<boolean>) {
      state.profilerEnabled = action.payload;
    },
  },
});

export const {
  setAppState,
  setAppMode,
  setEditingSkinPartId,
  setEditingVoxelId,
  setPointerAction,
  setLaunchState,
  setContextmenu,
  setParentType,
  setCurrentTime,
  setPlaying,
  setTimelineZoomWidth,
  setSaveState,
  setPublishing,
  setProjectId,
  setProjectType,
  setProjectName,
  setRedoEnabled,
  setUndoEnabled,
  setUserInfo,
  setEditType,
  setSourceMapId,
  setEditLock,
  setNodeAlphaCache,
  setProfilerEnabled,
} = appSlice.actions;

export type AppSlice = typeof appSlice.actions;

export type AppActions = ReturnType<AppSlice[keyof AppSlice]>;
