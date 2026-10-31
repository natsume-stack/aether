import { vec3 } from 'gl-matrix';
import { EditingMode, newBundle, traverseVoxels } from '@box/utils/helper';
import type {
  BoxBoundary,
  GetCamera,
  PointerDownSnapshot,
} from '../interfaces';
import {
  composeSymmetryOperation,
  getSymmetryPoints,
  isEmptyVoxel,
  isInvalidPosition,
} from '../util';
import { BasicTool, Params } from './base';
import { BoxBuildingStep } from '../mode/box-builder';
import type { Operation } from '../mode/interfaces';
import type { VoxelView } from '@box/utils/voxel';
import { store } from '../../../redux/store';
import { PointerAction } from '../../../redux/app-slice';

interface EraserParams extends Params {
  getCamera: GetCamera;
}

export class Eraser extends BasicTool {
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

  private boxBoundaries: BoxBoundary[] = [];

  private operationCache?: Operation;

  private modelChanged = false;
  /**
   * 线模式下，修改了的体素点。
   * 在update时，只清理记录的点。
   */
  private changedVoxels: vec3[] = [];

  /**
   * 体建造模式下，修改的体素点数量。
   * 用于判断是否有效修改体素模型。
   */
  private boxChangedCount = 0;

  constructor({ getCamera, ...params }: EraserParams) {
    super(params);
  }

  protected onEnabled(): void {
    this.collector.setLimit(2);

    this.editModes.boxBuilder.setLayersCalibration((layers) =>
      layers > 0 ? layers * -1 : layers,
    );
  }

  protected onDisabled(): void {
    this.clear();
  }

  protected onModeChanged(): void {
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

      destination.blockRender(true);

      editing.blockRender(false);

      editing.bakeData();
    }

    this.updateErasePositions();

    this.render();
  }

  public update() {
    if (!this.started) {
      return;
    }

    this.updateErasePositions();

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
      return;
    }

    this.modelsDict.editing.blockRender(true);

    srcModel.blockRender(false);

    if (this.modelChanged) {
      srcModel.voxels.copy(this.modelsDict.editing.voxels);

      srcModel.bakeData();

      this.saveHistory();

      this.pointer.update();
    }

    this.clear();

    if (this.mode === EditingMode.box) {
      this.stage.setPointerAction(PointerAction.Idle);
    }
  }

  /**
   * 快速删减。根据当前模式执行操作
   * 快速添加。根据模式执行不同的操作。
   * - line模式，进入start流程。
   * - box模式，快速删减一层体素。
   * @returns
   */
  public fastErase(pointerDownSnapshot: PointerDownSnapshot) {
    if (this.mode === EditingMode.line) {
      this.start();
      return;
    }

    this.clear();

    this.fastEraseFace(pointerDownSnapshot);

    this.stage.setPointerAction(PointerAction.Idle);

    if (!this.modelChanged) {
      return;
    }

    this.modelsDict.destination.bakeData();

    // 更新指针的位置
    this.pointer.update();

    this.saveHistory();

    this.clear();
  }

  private fastEraseFace(pointerDownSnapshot: PointerDownSnapshot) {
    const { hitNormal, voxelPos, destinationTextureId } = pointerDownSnapshot;

    if (isInvalidPosition(voxelPos) || isEmptyVoxel(destinationTextureId)) {
      return;
    }

    const { destination } = this.modelsDict;

    const startPositions = getSymmetryPoints({
      point: voxelPos,
      range: this.modelDimension,
      opts: store.getState().editing.mirrorMode,
    });

    const tempNormal = vec3.create();

    startPositions.forEach((startPos) => {
      this.getSymmetryHitNormal({
        out: tempNormal,
        originPos: voxelPos,
        symmetryPos: startPos,
        hitNormal,
      });

      this.editModes.face.parse({
        voxelView: destination.voxels,
        startPos,
        hitNormal,
        options: {
          type: 'hitTextureId',
          hitTextureId: destinationTextureId,
        },
        operation: ({ pos: [x, y, z] }) => {
          const index = destination.voxels.index(x, y, z);

          if (!isEmptyVoxel(destination.voxels.data[index])) {
            destination.voxels.data[index] = 0;

            this.modelChanged = true;
          }
        },
      });
    });
  }

  /**
   * 计算镜像的点击向量
   * 双击删减面的时候会使用。
   */
  private getSymmetryHitNormal(params: {
    out: vec3;
    originPos: vec3;
    symmetryPos: vec3;
    hitNormal: vec3;
  }) {
    const {
      out,
      originPos: [originX, originY, originZ],
      symmetryPos: [symmetryX, symmetryY, symmetryZ],
      hitNormal: [nx, ny, nz],
    } = params;

    out[0] = nx * (symmetryX === originX ? 1 : -1);
    out[1] = ny * (symmetryY === originY ? 1 : -1);
    out[2] = nz * (symmetryZ === originZ ? 1 : -1);
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
      forceStraight: this.forceStraight,
      operation: this.createOperation(
        model.voxels,
        this.modelsDict.editing.voxels,
      ),
    });

    this.modelsDict.editing.bakeData();
  }

  /**
   * 体建造模式的渲染，交给BoxBuilder来构建体。
   */
  private renderBox() {
    const { mirrorMode } = store.getState().editing;

    const boundaries =
      this.editModes.boxBuilder.generateBoxBoundaries(mirrorMode);

    if (!boundaries) {
      return;
    }

    const prevBoundaries = this.boxBoundaries.slice();

    this.boxBoundaries = boundaries;

    const model = this.collector.getSrc();

    if (!model) {
      return;
    }

    const { editing } = this.modelsDict;

    const onEachBoundary = ({ start, end }: BoxBoundary, idx: number) => {
      const prevBoundary = prevBoundaries[idx];

      /**
       * 如果没有对应的旧的长方体，直接更新。
       */
      if (!prevBoundary) {
        traverseVoxels(
          editing.voxels,
          start,
          end,
          (x, y, z, textureId, index) => {
            if (isEmptyVoxel(textureId)) {
              return;
            }

            editing.voxels.data[index] = 0;

            this.boxChangedCount++;
          },
        );
      } else {
        /**
         * 如果有对应的旧的长方体，计算newBundle进行更新。
         */
        newBundle(
          editing.voxels,
          prevBoundary.start,
          prevBoundary.end,
          start,
          end,
          (x, y, z) => {
            const srcTextureId = model.voxels.getVoxel(x, y, z);

            if (!isEmptyVoxel(srcTextureId)) {
              this.boxChangedCount--;
            }

            return srcTextureId;
          },
          (x, y, z) => {
            if (!isEmptyVoxel(model.voxels.getVoxel(x, y, z))) {
              this.boxChangedCount++;
            }

            return 0;
          },
        );
      }
    };

    this.boxBoundaries.forEach(onEachBoundary);

    this.modelsDict.editing.bakeData();

    this.modelChanged = this.boxChangedCount > 0;
  }

  /**
   * 根据当前的指针位置和模式，更新点的位置。
   */
  private updateErasePositions() {
    // 线模式，直接更新collection。
    if (this.mode === EditingMode.line) {
      const voxelPos = this.getErasePos();

      voxelPos && this.collector.addPosition(voxelPos);

      return;
    }

    // 体模式，如果未启动，需要进入体的矩形建造模式。
    if (this.editModes.boxBuilder.getStep() === BoxBuildingStep.None) {
      const voxelPos = this.getErasePos();

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

    // 如果已启动，则在体的高度建造模式记录点。
    this.editModes.boxBuilder.updatePosition();
  }

  private getErasePos(): vec3 | undefined {
    if (!this.pointer.isVoxelPosValid()) {
      return;
    }

    return this.pointer.getVoxelPos();
  }

  /**
   * 中断当前的操作。
   * 触发双击时，需要中断掉
   */
  private clear(mode = this.mode) {
    this.started = false;

    const srcModel = this.collector.getSrc();

    srcModel?.blockRender(false);

    this.modelsDict.editing.blockRender(true);

    this.collector.clear();

    if (mode === EditingMode.line) {
      this.clearLineMode();
    } else {
      this.clearBoxMode();
    }

    this.operationCache = undefined;

    this.modelChanged = false;

    this.pointer.setDrawingEnabled(true);
  }

  private clearLineMode() {
    this.changedVoxels = [];
  }

  private clearBoxMode() {
    this.editModes.boxBuilder.clear();

    this.boxBoundaries = [];

    this.boxChangedCount = 0;
  }

  private createOperation(voxels: VoxelView, applyVoxelView: VoxelView) {
    if (!this.operationCache) {
      const { mirrorMode } = store.getState().editing;

      const onVoxelChanged =
        this.mode === EditingMode.box
          ? () => {
              this.modelChanged = true;
            }
          : (pos) => {
              this.modelChanged = true;

              this.changedVoxels.push(pos);
            };

      this.operationCache = composeSymmetryOperation({
        opts: mirrorMode,
        range: this.modelDimension,
        operation: ({ pos: [x, y, z] }) => {
          const index = voxels.index(x, y, z);

          if (!isEmptyVoxel(voxels.data[index])) {
            applyVoxelView.data[index] = 0;

            onVoxelChanged([x, y, z]);
          }
        },
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
