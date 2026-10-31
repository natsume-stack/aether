import { vec3 } from 'gl-matrix';
import { Actions, EditingMode } from '@box/utils/helper';
import type { Pointer } from '../pointer';
import { EditingCollector } from './collector';
import { ModelsDict, EditModes, PointerDownSnapshot } from './interfaces';
import { Face } from './mode/face';
import { Line } from './mode/line';
import { PaintBucket } from './tool/paint-bucket';
import { AttachTool } from './tool/attach';
import { BasicTool, Params } from './tool/base';
import { Painter } from './tool/painter';
import { Eraser } from './tool/eraser';
import { BoxBuilder } from './mode/box-builder';
import { VoxelColorPicker } from './tool/voxel-color-picker';
import { Extruder } from './tool/extruder';
import { DEFAULT_POS } from './const';
import type { Stage } from '../stage';
import type { SetTool } from '../voxel-app/interfaces';
import type { AttachPreview } from './attach-preview';

type InitParams = {
  stage: Stage;
  models: ModelsDict;
  pointer: Pointer;
  attachPreview: AttachPreview;
  setTool: SetTool;
  saveHistory: () => void;
};

export class EditingController {
  private enabled = true;

  private modelsDict: ModelsDict;
  private pointer: Pointer;
  private collector: EditingCollector;

  private stage: Stage;

  private editModes: EditModes;
  /**
   * TODO sync with state
   */
  private currentToolType: Actions;
  private currentTool: BasicTool;

  private readonly painter: Painter;

  private readonly attachTool: AttachTool;

  private readonly paintBucket: PaintBucket;

  private readonly eraser: Eraser;

  private readonly voxelColorPicker: VoxelColorPicker;

  private readonly extruder: Extruder;

  /**
   * 记录pointerDown时的一些数据。
   * 在dblClick中可复用，因为大部分dblClick需要针对初始mouseDown的数据处理。
   */
  private pointerDownSnapshot: PointerDownSnapshot = {
    voxelPos: vec3.clone(DEFAULT_POS),
    hitNormal: vec3.clone(DEFAULT_POS),
    selectionTextureId: 0,
    destinationTextureId: 0,
  };

  constructor({
    stage,
    models,
    pointer,
    setTool,
    saveHistory,
    attachPreview,
  }: InitParams) {
    this.stage = stage;

    const { destination, selection, editing } = models;

    const modelsDict = {
      destination,
      selection,
      editing,
    };

    this.modelsDict = modelsDict;
    this.pointer = pointer;

    this.collector = new EditingCollector({
      editingModel: this.modelsDict.editing,
    });

    const line = new Line();
    const face = new Face();
    const boxBuilder = new BoxBuilder(
      this.pointer,
      this.stage.getCamera,
      this.collector,
      this.stage,
    );

    this.editModes = {
      line,
      face,
      boxBuilder,
    };

    const toolInitParams: Params = {
      modelsDict: this.modelsDict,
      collector: this.collector,
      editModes: this.editModes,
      pointer: this.pointer,
      stage: this.stage,
      saveHistory: saveHistory,
    };

    this.painter = new Painter(toolInitParams);

    this.paintBucket = new PaintBucket(toolInitParams);

    this.attachTool = new AttachTool({
      ...toolInitParams,
      attachPreview,
      getCamera: this.stage.getCamera,
    });

    this.eraser = new Eraser({
      ...toolInitParams,
      getCamera: this.stage.getCamera,
    });

    this.voxelColorPicker = new VoxelColorPicker({
      ...toolInitParams,
      setTool,
    });

    this.extruder = new Extruder({
      ...toolInitParams,
      getCamera: this.stage.getCamera,
    });

    this.currentTool = this.attachTool;
    this.currentTool.enable();
    this.currentToolType = Actions.Attach;
  }

  public onPointerDown() {
    if (!this.enabled) {
      return;
    }

    this.updatePointerDownSnapshot();

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.start();
        break;
      case Actions.FillSameColorSpace:
        this.paintBucket.fill({
          type: 'adjacent',
          ...this.pointerDownSnapshot,
        });
        break;
      case Actions.Attach:
        this.attachTool.start();
        break;
      case Actions.Erase:
        this.eraser.start();
        break;
      case Actions.PickColor:
        this.voxelColorPicker.start();
        break;
      case Actions.Extrude:
        this.extruder.start();
        break;
    }
  }

  public onPointerMove() {
    if (!this.enabled) {
      return;
    }

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.update();
        break;
      case Actions.Attach:
        this.attachTool.update();
        break;
      case Actions.Erase:
        this.eraser.update();
        break;
      case Actions.Extrude:
        this.extruder.update();
        break;
    }
  }

  public onPointerUp() {
    if (!this.enabled) {
      return;
    }

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.end();
        break;
      case Actions.Attach:
        this.attachTool.end();
        break;
      case Actions.Erase:
        this.eraser.end();
        break;
      case Actions.Extrude:
        this.extruder.end();
        break;
    }
  }

  public onDblClick() {
    if (!this.enabled) {
      return;
    }

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.paintFace();
        return;
      case Actions.Attach:
        this.attachTool.fastAttach(this.pointerDownSnapshot);
        return;
      case Actions.Erase:
        this.eraser.fastErase(this.pointerDownSnapshot);
        return;
      case Actions.FillSameColorSpace:
        this.paintBucket.fill({
          type: 'all',
          ...this.pointerDownSnapshot,
        });
        return;
    }
  }

  public onPressShift() {
    if (!this.enabled) {
      return;
    }

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.setMode(EditingMode.line);
        break;
      case Actions.Attach:
        this.attachTool.setForceStraight(true);
        break;
      case Actions.Erase:
        this.eraser.setForceStraight(true);
        break;
    }
  }

  public onReleaseShift() {
    if (!this.enabled) {
      return;
    }

    switch (this.currentToolType) {
      case Actions.Paint:
        this.painter.setMode(EditingMode.voxel);
        break;
      case Actions.Attach:
        this.attachTool.setForceStraight(false);
        break;
      case Actions.Erase:
        this.eraser.setForceStraight(false);
        break;
    }
  }

  /**
   * 设置当前使用的工具.
   * @param toolType 工具类型。undefined表示不更新。
   * @returns 是否设置成功。
   * 1. toolType为undefined时，表示不更新，返回true。
   * 2. toolType在支持的工具类型中，返回true。
   * 3. toolType与当前工具类型相同，返回true。
   */
  private setToolType(toolType?: Actions): boolean {
    if (toolType === undefined || toolType === this.currentToolType) {
      return true;
    }

    const newTool = this.getToolByType(toolType);

    if (!newTool) {
      return false;
    }

    // disable current tool and enable new tool
    this.currentTool.disable();

    this.currentTool = newTool;
    this.currentToolType = toolType;

    this.currentTool.enable();

    return true;
  }

  /**
   * 设置当前工具的编辑模式
   * @param mode 工具编辑模式。undefined表示不更新。
   * @returns tool.setMode的结果。
   */
  private setToolMode(mode?: EditingMode) {
    if (mode === undefined) {
      return true;
    }

    return this.currentTool.setMode(mode);
  }

  /**
   * 设置当前Controller使用的工具（toolType）以及模式（mode）
   * @param options 工具类型和模式。
   * @returns toolType和mode是否都设置成功。
   */
  public setTool(options: {
    /**
     * 工具类型。undefined表示不更新。
     * @default undefined
     */
    toolType?: Actions;
    /**
     * 工具编辑模式。undefined表示不更新。
     * @default undefined
     */
    mode?: EditingMode;
  }): boolean {
    const { toolType, mode } = options;

    if (!this.setToolType(toolType)) {
      return false;
    }

    return this.setToolMode(mode);
  }

  private getToolByType(toolType: Actions) {
    switch (toolType) {
      case Actions.Paint:
        return this.painter;
      case Actions.FillSameColorSpace:
        return this.paintBucket;
      case Actions.Attach:
        return this.attachTool;
      case Actions.Erase:
        return this.eraser;
      case Actions.PickColor:
        return this.voxelColorPicker;
      case Actions.Extrude:
        return this.extruder;
      default:
        return;
    }
  }

  /**
   * 禁用当前的工具。目前用于兼容尚未被迁移到editing/controller的工具
   */
  public disable() {
    this.enabled = false;

    this.currentTool.disable();
  }

  public enable() {
    this.enabled = true;

    this.currentTool.enable();
  }

  /**
   * 中断当前操作
   */
  public abort() {
    this.currentTool.abort();
  }

  /**
   * 更新pointerDown时，pointer相关的一些数据。
   */
  private updatePointerDownSnapshot() {
    const voxelPos = this.pointer.getVoxelPos();

    vec3.copy(this.pointerDownSnapshot.voxelPos, voxelPos);
    vec3.copy(this.pointerDownSnapshot.hitNormal, this.pointer.getNormal());

    const { selection, destination } = this.modelsDict;

    if (this.pointer.isVoxelPosValid()) {
      const [x, y, z] = voxelPos;

      const idx = this.modelsDict.destination.voxels.index(x, y, z);

      this.pointerDownSnapshot.selectionTextureId = selection.voxels.data[idx];
      this.pointerDownSnapshot.destinationTextureId =
        destination.voxels.data[idx];
    } else {
      this.pointerDownSnapshot.selectionTextureId = 0;
      this.pointerDownSnapshot.destinationTextureId = 0;
    }
  }
}
