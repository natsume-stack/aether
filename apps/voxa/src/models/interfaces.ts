import type { SerializedVec3 } from '../utils/math';
import type {
  SaveErrorResult,
  SaveSuccessResult,
  ModelData,
} from './project/interfaces';

export type GetScreenshot = (
  modelData: ModelData,
  bounds: SerializedVec3,
) => Promise<Blob | undefined>;

export type SwitchToAnimator = () => void;

export type SwitchToVoxel = (editingSkinPartId: string) => void;

/**
 * 暂存编辑状态，以便获取正确的部件数据
 */
export type StashEditingState = () => Promise<void>;

/**
 * 恢复被暂存的编辑状态
 */
export type RestoreEditingState = () => void;

export interface ManualSaveParams {
  /**
   * 保存成功时的回调
   */
  onSuccess?: (successResult: SaveSuccessResult) => void;
  /**
   * 保存失败时的回调。
   * 在弹出“重试”弹窗后，点击“取消”时触发。
   */
  onFail?: (errorResult: SaveErrorResult) => void;
}

export type ManualSave = (params: ManualSaveParams) => Promise<void>;

export type AutoSaveBeforePublishParams = ManualSaveParams;
