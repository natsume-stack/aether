import { serializeVec3 } from '../../../utils/math';
import type { EditingHistory } from '../../editing-history';
import type { Scene } from '../../rendering/objects/scene';
import type { Stage } from '../../stage';
import { HitBox } from '../../hit-box';
import {
  TransformControls,
  TransformDragEvent,
} from '../../rendering/controls/transform';
import { RootState, store } from '../../../../src/redux/store';
import {
  HitBoxMode,
  HitBoxParamPanelData,
  setHitBoxMode,
  ToolType,
  updateHitBoxParamPanelData,
} from '../../../../src/redux/animator-slice';
import { PointerAction } from '../../../redux/app-slice';
import { TransformType } from '../../rendering/controls/transform/def';
import { vec3 } from 'gl-matrix';
import { Axis } from '../../rendering/def';
import { FIXED_TORUS_RADIUS } from '../../rendering/controls/transform/scale';
import type { GetDefaultBounds } from '../util';

export class HitBoxManager {
  private enabled = false;
  private hitBox: HitBox;
  private transformControls: TransformControls;

  private oldState: RootState | undefined;
  private startSize = vec3.create();

  constructor(
    private history: EditingHistory,
    private stage: Stage,
    private scene: Scene,
    private setToolType: (toolType: ToolType) => void,
    private getDefaultBounds: GetDefaultBounds,
  ) {
    this.hitBox = new HitBox(this.stage.regl);

    this.transformControls = new TransformControls({
      regl: this.stage.regl,
      camera: this.stage.getCamera,
      domElement: this.stage.renderer.domElement,
      onDragStart: (ev) => {
        this.history.setGroup();

        // 记录拖拽开始时的state
        this.oldState = store.getState();
        this.stage.setPointerAction(PointerAction.Dragging);

        if (ev.type === TransformType.Scale) {
          this.hitBox.box.getSize(this.startSize);
        }
      },
      onDrag: this.onDragTransformControls,
      onDragEnd: () => {
        this.stage.setPointerAction(PointerAction.Idle);

        const { hitBoxParamPanelData } = store.getState().animator;

        // 拖拽结束后发送当前参数面板数据，与开始拖拽时记录的state比对
        this.history.saveAction({
          action: updateHitBoxParamPanelData({
            data: hitBoxParamPanelData,
          }),
          oldState: this.oldState,
        });
        this.oldState = undefined;

        this.history.unsetGroup();
      },
      onAbort: () => {
        if (this.oldState) {
          this.updateByHitBoxParamPanelData(
            this.oldState.animator.hitBoxParamPanelData,
          );

          this.oldState = undefined;
        }

        this.stage.setPointerAction(PointerAction.Idle);
        this.history.unsetGroup();
      },
    });

    this.disable();

    this.history.registerActionCallback('updateHitBoxParamPanelData', () => {
      this.updateByHitBoxParamPanelData(
        store.getState().animator.hitBoxParamPanelData,
      );
    });

    this.history.registerActionCallback('setHitBoxMode', () =>
      this.switchHitBoxMode(store.getState().animator.hitBoxMode, false),
    );
  }

  private onDragTransformControls = (ev: TransformDragEvent) => {
    switch (ev.type) {
      case TransformType.Translate:
        this.hitBox.box.position[ev.axis] += ev.currDiff;
        this.transformControls.position[ev.axis] += ev.currDiff;
        this.hitBox.box.updateMatrixWorld();
        store.dispatch(
          updateHitBoxParamPanelData({
            data: {
              position: serializeVec3(this.hitBox.box.getWorldPivot()),
            },
          }),
        );
        break;
      case TransformType.Scale:
        const size = vec3.create();
        if (ev.axis === Axis.E) {
          const ratio = ev.totalDiff / FIXED_TORUS_RADIUS;
          vec3.scale(size, this.startSize, ratio);
          vec3.add(size, this.startSize, size);
        } else {
          this.hitBox.box.getSize(size);
          size[ev.axis] += ev.currDiff;
        }

        vec3.max(size, size, [0, 0, 0]);
        this.hitBox.box.update(size);
        vec3.scale(this.hitBox.box.pivot, size, -0.5);
        store.dispatch(
          updateHitBoxParamPanelData({
            data: {
              size: serializeVec3(size),
            },
          }),
        );
        break;
    }
  };

  private updateByHitBoxParamPanelData(data?: HitBoxParamPanelData) {
    // 传入数据为undefined说明不存在自定义物理框数据，将物理框设为模型框数据
    const { geometry, position } = this.hitBox.modelBox;
    this.updateBoxData({
      type: 'box',
      size: data?.size || geometry.size,
      position: data?.position || position,
    });

    store.dispatch(updateHitBoxParamPanelData({ data }));
  }

  public abort = () => {
    this.transformControls.abort();
  };

  private enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.scene.add(this.transformControls);
    this.transformControls.enabled = true;
  }

  private disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.scene.remove(this.transformControls);
    this.transformControls.enabled = false;
  }

  private updateBoxData(data: {
    type: 'modelBox' | 'box';
    size: vec3;
    position: vec3;
  }) {
    const { type, size, position } = data;
    const box = type === 'modelBox' ? this.hitBox.modelBox : this.hitBox.box;

    box.setPositionByWorldPosition(position);
    box.update(size);
    vec3.scale(box.pivot, size, -0.5);

    if (type === 'box') {
      box.updateMatrixWorld();
      this.transformControls.setPosition(box.getWorldPivot());
    }
  }

  public checkIn() {
    this.scene.add(this.hitBox);
    const { bounds, boundsCenter } = this.getDefaultBounds();
    this.updateBoxData({
      type: 'modelBox',
      size: bounds,
      position: boundsCenter,
    });

    const { hitBoxMode } = store.getState().animator;

    this.switchHitBoxMode(hitBoxMode, false);
  }

  public checkOut() {
    this.scene.remove(this.hitBox);
    this.disable();
  }

  /**
   * 切换物理碰撞框模式
   * @param hitBoxMode 物理碰撞框模式
   */
  public setHitBoxMode(hitBoxMode: HitBoxMode) {
    this.history.setGroup();

    this.switchHitBoxMode(hitBoxMode);
    this.history.saveAction({
      action: setHitBoxMode(hitBoxMode),
    });

    this.history.unsetGroup();
  }

  public switchTransformType(toolType: ToolType) {
    let transformType: TransformType;

    switch (toolType) {
      case ToolType.Translate:
        transformType = TransformType.Translate;
        break;
      case ToolType.Scale:
        transformType = TransformType.Scale;
        break;
      default:
        return;
    }

    this.transformControls.switchTransformType(transformType);
  }

  private switchHitBoxMode(hitBoxMode: HitBoxMode, saveRecord: boolean = true) {
    const { hitBoxParamPanelData, toolType } = store.getState().animator;
    const { geometry, position } = this.hitBox.modelBox;

    if (hitBoxMode === HitBoxMode.Custom) {
      if (!hitBoxParamPanelData) {
        this.setCustomBoxFromDefaultBox(saveRecord);
      } else {
        this.updateBoxData({
          type: 'box',
          size: hitBoxParamPanelData.size,
          position: hitBoxParamPanelData.position,
        });
      }

      if (toolType === ToolType.Rotate) {
        this.setToolType(ToolType.Scale);
      }

      this.enable();
    } else {
      this.updateBoxData({
        type: 'box',
        size: geometry.size,
        position,
      });
      this.disable();
    }
  }

  /**
   * 通过参数面板更新自定义物理模型位置
   * @param position 位置
   */
  public updatePosition(position: vec3) {
    this.hitBox.box.setPositionByWorldPosition(position);
    this.hitBox.box.updateMatrixWorld();
    this.transformControls.setPosition(this.hitBox.box.getWorldPivot());

    this.history.saveAction({
      action: updateHitBoxParamPanelData({
        data: {
          position: serializeVec3(position),
        },
      }),
    });
  }

  /**
   * 通过参数面板更新自定义物理模型尺寸
   * @param size 尺寸
   */
  public updateSize(size: vec3) {
    this.hitBox.box.update(size);
    vec3.scale(this.hitBox.box.pivot, size, -0.5);

    this.history.saveAction({
      action: updateHitBoxParamPanelData({
        data: {
          size: serializeVec3(size),
        },
      }),
    });
  }

  /**
   * 将自定义物理框设置跟默认物理框数据一致
   * @param saveRecord 是否计入撤销重做，默认计入
   */
  public setCustomBoxFromDefaultBox(saveRecord: boolean = true) {
    const { geometry, position } = this.hitBox.modelBox;
    this.updateBoxData({
      type: 'box',
      size: geometry.size,
      position,
    });

    this.history.saveAction({
      action: updateHitBoxParamPanelData({
        data: {
          position: serializeVec3(position),
          size: serializeVec3(geometry.size),
        },
      }),
      saveRecord,
    });
  }
}
