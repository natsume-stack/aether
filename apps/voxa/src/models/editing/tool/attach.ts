import { vec3 } from 'gl-matrix';
import { EditingMode, inRange, traverseVoxels } from '@box/utils/helper';
import type { AttachPreview } from '../attach-preview';
import { BoxBoundary, GetCamera, PointerDownSnapshot } from '../interfaces';
import {
  isEmptyVoxel,
  isInvalidPosition,
  composeSymmetryOperation,
} from '../util';
import { BasicTool, Params } from './base';
import { BoxBuildingStep } from '../mode/box-builder';
import type { Operation } from '../mode/interfaces';
import type { VoxelView } from '@box/utils/voxel';
import { store } from '../../../redux/store';
import { PointerAction } from '../../../redux/app-slice';

const TEMP_VOXEL_POS = vec3.create();

interface AttachToolParams extends Params {
  attachPreview: AttachPreview;
  getCamera: GetCamera;
}

export class AttachTool extends BasicTool {
  /**
   * 当前是否已经开始操作。
   */
  private started = false;

  /**
   * 缓存体素模型维度，避免在update中重复计算。
   */
  private modelDimension = vec3.create();

  protected supportedModes = [EditingMode.line, EditingMode.box];

  /**
   * 是否仅绘制平行于方向轴的直线
   */
  private forceStraight = false;

  private attachPreview: AttachPreview;

  private boxBoundaries: BoxBoundary[] = [];

  private operationCache?: Operation;

  /**
   * 是否对model产生了影响
   */
  private modelChanged = false;
  /**
   * 线模式下，修改了的体素点。
   * 在update时，只清理记录的点。
   */
  private changedVoxels: vec3[] = [];

  constructor({ attachPreview, getCamera, ...params }: AttachToolParams) {
    super(params);

    this.attachPreview = attachPreview;
  }

  protected onEnabled(): void {
    this.collector.setLimit(2);

    this.editModes.boxBuilder.setLayersCalibration(Math.abs);
  }

  protected onDisabled(): void {
    this.clear();
  }

  protected onModeChanged(): void {
    // 在该钩子中，需要清理前一次的模式，所以取反
    const mode =
      this.mode === EditingMode.box ? EditingMode.line : EditingMode.box;

    this.clear(mode);
  }

  protected onAbort(): void {
    this.started && this.clear();
  }

  public start() {
    // 未启动
    if (!this.started) {
      this.started = true;

      const { destination, editing } = this.modelsDict;

      this.collector.setSrc(destination);

      this.collector.setLimit(2);

      vec3.copy(this.modelDimension, destination.voxels.getDimension());

      // 只有Line Mode会操作editing模型。Box Mode操作AttachPreview。
      if (this.mode === EditingMode.line) {
        destination.blockRender(true);

        editing.blockRender(false);
      }
    }

    this.updateAttachPositions();

    this.render();
  }

  public update() {
    if (!this.started) {
      return;
    }

    this.updateAttachPositions();

    this.render();
  }

  public end() {
    if (!this.started) {
      return;
    }

    if (this.mode === EditingMode.box) {
      const curStep = this.editModes.boxBuilder.getStep();

      if (curStep === BoxBuildingStep.Rect) {
        this.editModes.boxBuilder.setBuildingHeight();

        this.pointer.setDrawingEnabled(false);

        return;
      }
    }

    this.started = false;

    const srcModel = this.collector.getSrc();

    if (!srcModel) {
      this.clear();
      return;
    }

    // box模式下需要工具自己处理。其余情况由最外层controller统一处理。
    let toSetMouseIdle = false;

    if (this.mode === EditingMode.line) {
      srcModel.voxels.copy(this.modelsDict.editing.voxels);

      this.modelsDict.editing.blockRender(true);

      srcModel.blockRender(false);
    } else {
      toSetMouseIdle = true;

      const operation = this.createOperation(srcModel.voxels);

      this.boxBoundaries.forEach(({ start, end }) => {
        traverseVoxels(srcModel.voxels, start, end, (x, y, z) => {
          operation({ pos: [x, y, z] });
        });
      });
    }

    if (this.modelChanged) {
      srcModel.bakeData();

      this.saveHistory();

      this.pointer.update();
    }

    this.clear();

    toSetMouseIdle && this.stage.setPointerAction(PointerAction.Idle);
  }

  /**
   * 快速添加。根据模式执行不同的操作。
   * - line模式，进入start流程。
   * - box模式，快速添加一层体素。
   */
  public fastAttach(pointerDownSnapshot: PointerDownSnapshot) {
    if (this.mode === EditingMode.line) {
      this.start();
      return;
    }

    this.clear();

    this.fastAttachFace(pointerDownSnapshot);

    this.stage.setPointerAction(PointerAction.Idle);

    if (!this.modelChanged) {
      return;
    }

    this.modelsDict.destination.bakeData();

    this.saveHistory();

    this.pointer.update();

    this.clear();
  }

  private fastAttachFace(pointerDownSnapshot: PointerDownSnapshot) {
    const { hitNormal, voxelPos, selectionTextureId, destinationTextureId } =
      pointerDownSnapshot;

    if (isInvalidPosition(voxelPos)) {
      return;
    }

    const { selection, destination } = this.modelsDict;

    const newPos = this.getAttachPos({
      voxelPos,
      hitNormal,
      min: [0, 0, 0],
      max: destination.voxels.getDimension(),
    });

    if (!newPos) {
      return;
    }

    let hitTextureId = -1;
    let voxels: VoxelView | undefined;

    if (!isEmptyVoxel(selectionTextureId)) {
      hitTextureId = selectionTextureId;
      voxels = selection.voxels;
    } else if (!isEmptyVoxel(destinationTextureId)) {
      hitTextureId = destinationTextureId;
      voxels = destination.voxels;
    } else {
      hitTextureId = -1;
      voxels = destination.voxels;
    }

    const operation = this.createOperation(destination.voxels);

    if (hitTextureId === -1) {
      this.editModes.face.parse({
        voxelView: voxels,
        startPos: voxelPos,
        hitNormal,
        operation,
        options: {
          type: 'ignoreTextureId',
        },
      });
    } else {
      this.editModes.face.parse({
        voxelView: voxels,
        startPos: voxelPos,
        hitNormal,
        options: {
          type: 'hitTextureId',
          hitTextureId,
        },
        operation: ({ pos: [x, y, z] }) => {
          const newPos = vec3.add(vec3.create(), hitNormal, [x, y, z]);

          operation({ pos: newPos });
        },
      });
    }
  }

  private render() {
    switch (this.mode) {
      case EditingMode.line:
        this.renderLine();
        break;
      case EditingMode.box:
        this.renderBox();
        break;
      default:
        return;
    }
  }

  private renderLine() {
    const model = this.collector.getSrc();

    if (!model) {
      return;
    }

    this.resetChangedVoxels(model.voxels);

    const collection = this.collector.getCollection();

    this.editModes.line.parse({
      collection,
      operation: this.createOperation(this.modelsDict.editing.voxels),
      forceStraight: this.forceStraight,
    });

    this.modelsDict.editing.bakeData();
  }

  /**
   * 体建造模式的渲染，交给BoxPreviewer来实现。
   */
  private renderBox() {
    const { mirrorMode } = store.getState().editing;

    const boundaries =
      this.editModes.boxBuilder.generateBoxBoundaries(mirrorMode);

    if (!boundaries || boundaries.length === 0) {
      return;
    }

    this.boxBoundaries = boundaries;

    this.attachPreview.update(boundaries);
  }

  /**
   * 更新记录的起点或者终点。
   */
  private updateAttachPositions() {
    // 线建造模式，直接更新collection。
    if (this.mode === EditingMode.line) {
      const voxelPos = this.getAttachPos({
        voxelPos: this.pointer.getVoxelPos(),
        hitNormal: this.pointer.getNormal(),
        min: [0, 0, 0],
        max: this.modelDimension,
      });

      voxelPos && this.collector.addPosition(voxelPos);

      return;
    }

    // 体建造模式，如果未启动，需要进入矩形建造模式。
    if (this.editModes.boxBuilder.getStep() === BoxBuildingStep.None) {
      const voxelPos = this.getAttachPos({
        voxelPos: this.pointer.getVoxelPos(),
        hitNormal: this.pointer.getNormal(),
        min: [0, 0, 0],
        max: this.modelDimension,
      });

      if (!voxelPos) {
        return;
      }

      this.editModes.boxBuilder.setBuildingRect({
        voxelPos,
        hitNormal: this.pointer.getNormal(),
        modelDimension: this.modelDimension,
      });

      return;
    }

    // 如果已启动，则在高度建造模式记录点。
    this.editModes.boxBuilder.updatePosition();
  }

  /**
   * 根据Pointer和体素模型（destination）视图，计算附着的起点。
   * 如果选中的点，已有体素，则计算 点 + 方向向量。
   * 如果计算后的点已经超过边界，则取原来的点。
   */
  private getAttachPos(params: {
    voxelPos: vec3;
    hitNormal: vec3;
    min: vec3;
    max: vec3;
  }): vec3 | undefined {
    const { voxelPos, hitNormal, min, max } = params;

    if (isInvalidPosition(voxelPos)) {
      return;
    }

    const [x, y, z] = voxelPos;

    const { destination, selection } = this.modelsDict;

    // 如果已有体素，叠加方向向量，计算新的附着位置
    if (
      destination.voxels.getVoxel(x, y, z) ||
      selection.voxels.getVoxel(x, y, z)
    ) {
      vec3.add(TEMP_VOXEL_POS, voxelPos, hitNormal);

      if (inRange(TEMP_VOXEL_POS, min, max)) {
        return vec3.clone(TEMP_VOXEL_POS);
      } else {
        return;
      }
    }

    return vec3.clone(voxelPos);
  }

  /**
   * 中断当前的操作。
   * 触发双击时，需要中断掉
   */
  private clear(mode: EditingMode = this.mode) {
    this.started = false;

    if (mode === EditingMode.line) {
      this.clearLineMode();
    } else {
      this.clearBoxMode();
    }

    this.collector.clear();

    this.operationCache = undefined;

    this.modelChanged = false;

    this.pointer.setDrawingEnabled(true);
  }

  private clearLineMode() {
    const srcModel = this.collector.getSrc();

    srcModel?.blockRender(false);

    this.modelsDict.editing.blockRender(true);

    this.changedVoxels = [];
  }

  private clearBoxMode() {
    this.editModes.boxBuilder.clear();

    this.boxBoundaries = [];

    this.attachPreview.clear();
  }

  private createOperation(voxels: VoxelView): Operation {
    if (!this.operationCache) {
      const newTextureId = store.getState().palette.selectedId;

      const onVoxelChanged: Operation =
        this.mode === EditingMode.box
          ? () => {
              this.modelChanged = true;
            }
          : ({ pos }) => {
              this.modelChanged = true;
              this.changedVoxels.push(pos);
            };

      const operation: Operation = ({ pos: [x, y, z] }) => {
        const idx = voxels.index(x, y, z);

        if (isEmptyVoxel(voxels.data[idx])) {
          voxels.data[idx] = newTextureId;

          onVoxelChanged({ pos: [x, y, z] });
        }
      };

      const { mirrorMode } = store.getState().editing;

      this.operationCache = composeSymmetryOperation({
        opts: mirrorMode,
        range: voxels.getDimension(),
        operation,
      });
    }

    return this.operationCache;
  }

  /**
   * 线模式下，重置修改过的体素点。
   */
  private resetChangedVoxels(srcVoxelView: VoxelView) {
    if (this.changedVoxels.length === 0) {
      return;
    }

    const editing = this.modelsDict.editing.voxels;

    this.changedVoxels.forEach(([x, y, z]) => {
      const index = srcVoxelView.index(x, y, z);

      editing.data[index] = srcVoxelView.data[index];
    });

    this.changedVoxels = [];
  }

  /**
   * 设置是否仅绘制平行于方向轴的直线。
   * 仅在绘制线的模式（mode === line）时，能看到效果。
   * 如果当前正在绘制直线的过程中，会立刻转换为另一种模式。
   */
  public setForceStraight(force: boolean) {
    this.forceStraight = force;

    if (this.mode !== EditingMode.line || !this.started) {
      return;
    }

    this.update();
  }
}
