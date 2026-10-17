import type { VoxelApp } from '.';
import { vec3 } from 'gl-matrix';

import { PointerAction } from '../../redux/app-slice';
import { absMod } from '@box/utils/helper';
import { getBoxBoundary } from '@box/utils/voxel';
import {
  TransformControls,
  TransformDragEvent,
} from '../rendering/controls/transform';
import { Model } from '../voxel-model/model';
import type { Stage } from '../stage';

const SHIFT = vec3.create();

type InitParams = {
  stage: Stage;
  voxelApp: VoxelApp;
};

export class TranslateTool extends TransformControls {
  private stage: Stage;
  private voxelApp: VoxelApp;
  /**
   * 在一轮拖拽操作中，模型位移的总量。
   * 用于在abort时，恢复模型的原位置。
   */
  private totalShift: vec3 = vec3.create();
  /**
   * 操纵杆在本次拖拽操作开始时的位置。
   * 用于在abort时，恢复为初始位置。
   */
  private controlsStartPos = vec3.create();

  private modelChanged = false;
  private targetModel?: Model;

  constructor(params: InitParams) {
    const { stage, voxelApp } = params;

    super({
      regl: stage.regl,
      camera: stage.getCamera,
      domElement: stage.renderer.domElement,
      onDragStart: () => {
        this.start();
      },
      onDrag: (ev) => {
        this.performTranslate(ev);
      },
      onDragEnd: () => {
        this.end();
      },
      onAbort: () => {
        if (!this.targetModel) {
          return;
        }

        this.targetModel.translate(vec3.negate(vec3.create(), this.totalShift));

        vec3.copy(this.position, this.controlsStartPos);

        this.updateMatrixWorld();

        this.clearState();
      },
    });

    this.stage = stage;
    this.voxelApp = voxelApp;
  }

  /**
   * 开始本轮拖拽移动操作
   */
  private start() {
    this.visible = false;
  }

  /**
   * 对体素模型进行位移操作
   * @param ev drag事件
   * @returns
   */
  private performTranslate(ev: TransformDragEvent) {
    if (!this.targetModel) {
      return;
    }

    vec3.zero(SHIFT);
    SHIFT[ev.axis] = Math.floor(ev.totalDiff);
    vec3.sub(SHIFT, SHIFT, this.totalShift);
    if (vec3.equals(SHIFT, [0, 0, 0])) {
      return;
    }

    this.translateModel(this.targetModel, SHIFT);

    this.shiftPosition(this.targetModel.voxels.shape, SHIFT);
  }

  /**
   * 结束本轮拖拽移动操作。
   */
  private end() {
    if (!this.targetModel) {
      return;
    }

    if (this.modelChanged) {
      this.voxelApp.saveHistory();
    }

    this.clearState();
  }

  /**
   * 清理拖拽操作中记录的一些状态。
   * 在end和abort时调用。
   */
  private clearState() {
    this.modelChanged = false;

    this.visible = true;

    this.stage.setPointerAction(PointerAction.Idle);

    vec3.zero(this.totalShift);
  }

  /**
   * 计算位移，并进行取模
   */
  private shiftPosition(shape: vec3, shift: vec3) {
    const [sx, sy, sz] = shape;

    vec3.add(this.position, this.position, shift);

    vec3.set(
      this.position,
      absMod(this.position[0], sx),
      absMod(this.position[1], sy),
      absMod(this.position[2], sz),
    );
  }

  /**
   * 对体素模型进行位移操作。
   */
  private translateModel(model: Model, shift: vec3) {
    model.translate(shift);

    vec3.add(this.totalShift, this.totalShift, shift);

    this.modelChanged = true;
  }

  /**
   * 获取体素模型的精确中心点（不做取整）
   */
  private getModelCenter(model: Model) {
    const { start, end } = getBoxBoundary(model.voxels);

    return vec3.fromValues(
      (start[0] + end[0] + 1) / 2,
      (start[1] + end[1] + 1) / 2,
      (start[2] + end[2] + 1) / 2,
    );
  }

  /**
   * 激活组件。
   * 如果selection不为空，操作selection。
   * 否则检查destination，如果destination不为空，操作destination。否则激活失败。
   * 组件处于非enabled状态时，激活失败
   */
  public activate() {
    if (!this.enabled) {
      return;
    }

    const { selection, destination } = this.voxelApp.models;

    if (selection.isEmpty()) {
      if (destination.isEmpty()) {
        this.targetModel = undefined;

        this.visible = false;
        return;
      }

      this.targetModel = destination;
    } else {
      this.targetModel = selection;
    }

    this.stage.setPointerAction(PointerAction.Idle);

    vec3.copy(this.controlsStartPos, this.getModelCenter(this.targetModel));

    vec3.copy(this.position, this.controlsStartPos);

    this.updateMatrixWorld();

    this.visible = true;
  }

  public enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;

    this.activate();

    this.voxelApp.pointer.setDrawingEnabled(false);
  }

  public disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    this.visible = false;

    this.voxelApp.pointer.setDrawingEnabled(true);

    this.targetModel = undefined;
  }
}
