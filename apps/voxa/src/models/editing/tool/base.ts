import type { Pointer } from '../../pointer';
import type { EditingCollector } from '../collector';
import type { Model } from '../../voxel-model/model';
import type { EditModes, ModelsDict } from '../interfaces';
import { EditingMode } from '@box/utils/helper';
import { Stage } from '../../stage';

export type Params = {
  collector: EditingCollector;
  modelsDict: ModelsDict;
  editModes: EditModes;
  pointer: Pointer;
  stage: Stage;
  saveHistory: () => void;
};

export class BasicTool {
  protected collector: EditingCollector;
  protected modelsDict: ModelsDict;
  protected editModes: EditModes;
  protected pointer: Pointer;
  protected stage: Stage;
  protected saveHistory: () => void;

  protected enabled: boolean = false;
  /**
   * 当前的编辑模式
   */
  protected mode: EditingMode = EditingMode.box;
  /**
   * 支持的编辑模式
   * @default []
   */
  protected supportedModes: EditingMode[] = [];
  /**
   * 不存在编辑模式的区分，比如PaintBucket。
   * 当设置这个属性为true时，setMode总是会返回true，也不会触发onModeChanged。
   */
  protected ignoreMode = false;

  constructor(params: Params) {
    const { collector, modelsDict, editModes, pointer, stage, saveHistory } =
      params;

    this.collector = collector;

    this.modelsDict = modelsDict;

    this.editModes = editModes;

    this.pointer = pointer;

    this.stage = stage;

    this.saveHistory = saveHistory;
  }

  /**
   * 启用工具。触发onEnabled。
   */
  public enable(): void {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.onEnabled();
  }

  /**
   * 工具被启用时触发。
   * 子类实现。
   */
  protected onEnabled(): void {}

  /**
   * 停用工具。触发onDisabled。
   */
  public disable(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.onDisabled();
  }

  /**
   * 工具被禁用时触发。
   * 子类实现。
   */
  protected onDisabled(): void {}

  /**
   * 中断工具当前操作。触发onAbort。
   */
  public abort() {
    this.onAbort();
  }

  /**
   * 工具操作被中断时触发。
   * 子类实现。
   */
  protected onAbort(): void {}

  /**
   * 设置工具的编辑模式。设置成功时，会触发onModeChanged
   * @param mode 编辑模式、voxel、line、face等
   * @returns 设置模式是否成功。
   * 以下情况视作成功：
   * 1. 工具的ignoreMode属性为true，即不存在编辑模式的差别。
   * 2. 工具支持的编辑模式包含mode。
   * 3. mode与当前编辑模式相同。
   */
  public setMode(mode: EditingMode): boolean {
    if (this.ignoreMode) {
      return true;
    }

    if (mode === this.mode) {
      return true;
    }

    if (!this.supportedModes.includes(mode)) {
      return false;
    }

    this.mode = mode;

    this.onModeChanged();

    return true;
  }

  /**
   * 切换编辑模式时的钩子，由子类实现
   */
  protected onModeChanged() {}

  /**
   * 获取当前pointer指向的体素模型
   */
  protected getPointingModel(): Model | undefined {
    if (!this.pointer.isVoxelPosValid()) {
      return;
    }

    const [x, y, z] = this.pointer.getVoxelPos();

    const { destination, selection } = this.modelsDict;

    const idx = destination.voxels.index(x, y, z);

    // 模型重叠时，selection优先于destination。
    if (selection.voxels.data[idx] !== 0) {
      return selection;
    }

    if (destination.voxels.data[idx] !== 0) {
      return destination;
    }

    return undefined;
  }
}
