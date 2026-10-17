import { vec3 } from 'gl-matrix';
import { FeatureFlag } from '@box/env/constants';
import { RootState, store } from '../../..//redux/store';
import type { EditingHistory } from '../../editing-history';
import { PivotMode, updateModelPivot } from '../../../redux/animator-slice';
import { EditType, PointerAction } from '../../../redux/app-slice';
import { serializeVec3 } from '../../../utils/math';
import { LineBox } from '../../line-box';
import type { Stage } from '../../stage';
import type { Scene } from '../../rendering/objects/scene';
import {
  TransformControls,
  TransformEvent,
  TransformDragEvent,
  TransformDragEndEvent,
} from '../../rendering/controls/transform';
import { TransformType } from '../../rendering/controls/transform/def';
import type { GetDefaultBounds } from '../util';
import { PivotHelper } from '../node-manager/pivot-helper';
import { ModelPivotTool } from './pivot-tool';
import { clientConfig } from '../../../config/client';

type Spec = {
  stage: Stage;
  scene: Scene;
  history: EditingHistory;
  getDefaultBounds: GetDefaultBounds;
};

export class ModelPivotManager {
  private enabled = false;

  /**
   * 因为需要做中心点的“磁吸”效果，需要展示框
   */
  public readonly lineBox: LineBox;

  private stage: Stage;

  private scene: Scene;

  private history: EditingHistory;

  private getDefaultBounds: GetDefaultBounds;

  private transformControls: TransformControls;

  private oldState?: RootState;

  private showPivotHelper = false;

  private pivotHelper: PivotHelper;

  constructor(spec: Spec) {
    const { stage, scene, history, getDefaultBounds } = spec;

    this.stage = stage;

    this.scene = scene;

    this.history = history;

    this.getDefaultBounds = getDefaultBounds;

    this.transformControls = new TransformControls({
      regl: this.stage.regl,
      camera: this.stage.getCamera,
      domElement: this.stage.renderer.domElement,
      onDragStart: this.onDragStart,
      onDrag: this.onDrag,
      onDragEnd: this.onDragEnd,
      onAbort: this.onAbort,
      pivotTool: new ModelPivotTool(this.stage.regl),
    });
    this.transformControls.switchTransformType(TransformType.Pivot);

    this.scene.add(this.transformControls);

    this.lineBox = new LineBox(stage.regl, [0, 0, 0]);
    this.lineBox.color = [0.98, 0.91, 0.26];

    this.toggleAxisTools(false);

    this.pivotHelper = new PivotHelper(
      stage.getCamera,
      stage.renderer,
      this.scene,
    );

    this.transformControls.enabled = false;

    this.history.registerActionCallback(
      'updateModelPivot',
      this.updateTransformPos,
    );

    const { editType } = store.getState().app;

    this.transformControls.visible = editType === EditType.Normal;
  }

  private toggleAxisTools(toShow: boolean) {
    this.transformControls.pivotTool.axisTools.forEach((arrow) =>
      arrow.setVisible(toShow),
    );
  }

  public enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;

    this.toggleAxisTools(true);

    this.transformControls.enabled = true;

    const { bounds, boundsCenter } = this.getDefaultBounds();

    this.lineBox.update(bounds);
    this.lineBox.setPosition(boundsCenter);
    vec3.scale(this.lineBox.pivot, bounds, -0.5);

    this.scene.add(this.lineBox);
  }

  public disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    this.toggleAxisTools(false);

    this.transformControls.enabled = false;

    this.scene.remove(this.lineBox);
  }

  public updateTransformPos = () => {
    const { modelPivot } = store.getState().animator;

    this.transformControls.setPosition(modelPivot);
  };

  /**
   * 重置模型中心点到“包围盒”中心
   */
  public reset() {
    const { boundsCenter } = this.getDefaultBounds();

    this.transformControls.setPosition(boundsCenter);
    this.updatePivotHelper();

    this.history.saveAction({
      action: updateModelPivot(serializeVec3(boundsCenter)),
    });
  }

  private onDragStart = (evt: TransformEvent) => {
    this.history.setGroup();

    // 记录拖拽开始时的state
    this.oldState = store.getState();
    this.stage.setPointerAction(PointerAction.Dragging);
  };

  private onDrag = (evt: TransformDragEvent) => {
    const { axis, currDiff } = evt;

    this.transformControls.position[axis] += currDiff;

    if (this.showPivotHelper) {
      this.pivotHelper.intersectPoint(this.transformControls.position);
    }
  };

  private onDragEnd = (evt: TransformDragEndEvent) => {
    const helper = this.pivotHelper.intersectPoint(
      this.transformControls.position,
    );
    if (helper) {
      vec3.copy(this.transformControls.position, helper);
    }

    this.history.saveAction({
      action: updateModelPivot(serializeVec3(this.transformControls.position)),
      oldState: this.oldState,
    });

    this.stage.setPointerAction(PointerAction.Idle);

    this.oldState = undefined;

    this.history.unsetGroup();
  };

  private onAbort = (evt: TransformDragEndEvent) => {
    this.oldState = undefined;

    this.stage.setPointerAction(PointerAction.Idle);

    this.history.unsetGroup();

    this.updateTransformPos();
  };

  public abort = () => {
    this.transformControls.abort();
  };

  public setPivotHelperVisible(visible: boolean) {
    this.showPivotHelper = visible;

    this.updatePivotHelper();
  }

  public updatePivotHelper() {
    this.pivotHelper.detach();

    const { pivotMode } = store.getState().animator;

    if (!this.showPivotHelper || pivotMode !== PivotMode.Model) {
      return;
    }

    this.pivotHelper.attachBox('model', this.lineBox);
    this.pivotHelper.intersectPoint(this.transformControls.position);
  }
}
