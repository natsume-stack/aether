import type { Regl } from '@box/regl';
import type { Camera } from '../../camera/base';
import type { Intersection } from '../../raycast';

import { mat4, quat, vec2, vec3 } from 'gl-matrix';

import { ControlsPlane } from '../../math/controls-plane';
import { Object3D } from '../../objects/object3d';
import { Raycaster } from '../../raycast';
import { Translate } from './translate';
import { Rotate } from './rotate';
import { Pivot } from './pivot';
import { AxisTool, TransformTool, TransformType, UNIT } from './def';
import { Axis } from '../../def';
import { isFunction } from '../../utils/function';
import { LONG_PRESS_DURATION } from '../../../../defs';
import { CLICK_OFFSET_THRESHOLD } from '../../../editing/const';
import { safeDivVec } from '../../utils/math';
import { Scale } from './scale';
import {
  clipPosToScreenPos,
  worldPosToClipPos,
} from '../../../../utils/coordinate';

const POINTER = vec2.create();
const OFFSET = vec3.create();
const INTERSECTION = vec3.create();
const WORLD_POS = vec3.create();
const WORLD_QUAT = quat.create();
const INVERSE_MATRIX = mat4.create();
const TEMP_VEC2 = vec2.create();
const TEMP_VEC2_2 = vec2.create();

const SCALE_DETECT_LENGTH = 84;

export interface TransformEvent {
  type: TransformType;
  axis: Axis;
}

export interface TransformDragEvent extends TransformEvent {
  currDiff: number;
  totalDiff: number;
}

export interface TransformDragEndEvent extends TransformEvent {
  totalDiff: number;
}

export type Params = {
  regl: Regl;
  camera: Camera | (() => Camera);
  domElement: HTMLElement;
  onDragStart?: (event: TransformEvent) => void;
  onDrag?: (event: TransformDragEvent) => void;
  onDragEnd?: (event: TransformDragEndEvent) => void;
  onAbort?: (event: TransformDragEndEvent) => void;
  pivotTool?: Pivot;
};

type TransformIntersection = Pick<Intersection, 'object'>;

const INTERSECTIONS: Intersection[] = [];
const TRANSFORM_INTERSECTIONS: TransformIntersection[] = [];

export class TransformControls extends Object3D {
  public enabled = true;

  private getCamera: () => Camera;
  private domElement: HTMLElement;
  private onDragStart?: (event: TransformEvent) => void;
  private onDrag?: (event: TransformDragEvent) => void;
  private onDragEnd?: (event: TransformDragEndEvent) => void;
  private onAbort?: (event: TransformDragEndEvent) => void;

  public declare currentTransformTool: TransformTool;

  private raycaster: Raycaster;
  private controlsPlane = new ControlsPlane();

  private translateTool: Translate;
  private rotateTool: Rotate;
  public pivotTool: Pivot;
  private scaleTool: Scale;

  private tools: TransformTool[] = [];

  private selected: Object3D | undefined;
  private hovered: Object3D | undefined;

  private pointers: PointerEvent[] = [];
  private pointerdownTimer: number = 0;

  private addPointer = (e: PointerEvent) => {
    this.pointers.push(e);
  };

  private removePointer = (e: PointerEvent) => {
    const index = this.pointers.findIndex(
      (pointer) => pointer.pointerId === e.pointerId,
    );
    if (index !== -1) {
      this.pointers.splice(index, 1);
    }
  };

  constructor(param: Params) {
    super();
    const {
      regl,
      camera,
      domElement,
      onDragStart,
      onDrag,
      onDragEnd,
      onAbort,
      pivotTool,
    } = param;
    this.getCamera = isFunction(camera) ? camera : () => camera;
    this.domElement = domElement;
    this.onDragStart = onDragStart;
    this.onDrag = onDrag;
    this.onDragEnd = onDragEnd;
    this.onAbort = onAbort;

    this.raycaster = new Raycaster();
    this.translateTool = new Translate(regl);
    this.rotateTool = new Rotate(regl);
    this.scaleTool = new Scale(regl);

    this.pivotTool = pivotTool ? pivotTool : new Pivot(regl);

    this.tools.push(
      this.translateTool,
      this.rotateTool,
      this.pivotTool,
      this.scaleTool,
    );

    // 默认展示translate
    this.tools.forEach((tool) => {
      if (tool.transformType === TransformType.Translate) {
        tool.visible = true;
        this.currentTransformTool = tool;

        return;
      }

      tool.visible = false;
    });

    this.add(...this.tools);

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerCancel);
    this.domElement.addEventListener('pointerleave', this.onPointerCancel);
    this.domElement.addEventListener('pointercancel', this.onPointerCancel);
  }

  public getHovered() {
    return this.hovered;
  }

  public getSelected() {
    return this.selected;
  }

  /**
   * 打断正在进行的鼠标操作
   * 如果当前有正在进行的鼠标操作，触发onAbort。
   */
  public abort() {
    if (!this.enabled || !this.selected) {
      return;
    }

    const hasMouse = this.pointers.some(
      ({ pointerType }) => pointerType === 'mouse',
    );

    this.cancel(this.onAbort);

    if (hasMouse) {
      this.updateMatrixWorld();

      this.setHovered(true);
    }
  }

  public switchTransformType(type: TransformType) {
    if (this.currentTransformTool.transformType === type) {
      return;
    }

    this.tools.forEach((tool) => {
      if (tool.transformType === type) {
        tool.visible = true;

        this.currentTransformTool = tool;

        return;
      }

      tool.visible = false;
    });
  }

  /**
   * 更新指针坐标以及射线
   */
  private updatePointerAndRaycaster(event: PointerEvent) {
    const rect = this.domElement.getBoundingClientRect();
    POINTER[0] = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    POINTER[1] = (-(event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(POINTER, this.getCamera());
  }

  private onPointerCancel = (e: PointerEvent) => {
    clearTimeout(this.pointerdownTimer);
    this.removePointer(e);
    this.cancel(this.onDragEnd);

    if (e.pointerType === 'mouse') {
      this.setHovered(true);
    }
  };

  /**
   * 如果当前正在拖拽操作，则取消并执行回调。
   * @param onCancel 取消操作时的回调。
   */
  private cancel(onCancel?: (evt: TransformDragEndEvent) => void) {
    if (!this.enabled || !this.selected) {
      return;
    }

    // 获取当前拖动轴
    const axisTool = this.currentTransformTool.getAxisToolByInteractiveObj(
      this.selected,
    );
    if (!axisTool) {
      this.selected = undefined;
      return;
    }

    let totalDiff = 0;
    // 触发当前工具轴 end handler
    // 显示其他工具轴
    this.currentTransformTool.axisTools.forEach((tool) => {
      if (tool === axisTool) {
        totalDiff = tool.handleDragEnd();
      } else {
        tool.setVisible(true);
      }
    });

    onCancel &&
      onCancel({
        type: this.currentTransformTool.transformType,
        axis: axisTool.axis,
        totalDiff: totalDiff,
      });

    this.selected = undefined;

    axisTool.setActive(false);
    this.updateCursor(false);
  }

  // pc端onmousedown之后的逻辑
  private startGesture = (event: PointerEvent) => {
    if (!this.enabled) {
      return;
    }
    this.updatePointerAndRaycaster(event);

    const interactions = this.intersectsObjects();

    if (!interactions.length) {
      return;
    }

    this.selected = interactions[0].object;

    // 获取当前拖动轴
    const axisTool = this.currentTransformTool.getAxisToolByInteractiveObj(
      this.selected,
    );
    if (!axisTool) {
      return;
    }
    this.setPlane(axisTool);

    if (
      !this.parent ||
      !this.raycaster.ray.intersectPlane(INTERSECTION, this.controlsPlane)
    ) {
      return;
    }

    mat4.invert(INVERSE_MATRIX, this.parent.matrixWorld);
    vec3.sub(
      OFFSET,
      INTERSECTION,
      mat4.getTranslation(WORLD_POS, this.matrixWorld),
    );

    // 触发当前工具轴 start handler
    // 隐藏其他工具轴
    this.currentTransformTool.axisTools.forEach((tool) => {
      if (tool !== axisTool) {
        tool.setVisible(false);
        tool.setActive(false);

        return;
      }

      tool.handleDragStart(OFFSET, INVERSE_MATRIX, this.matrixWorld);
    });

    if (event.pointerType !== 'mouse') {
      axisTool.setActive(true);
      this.updateCursor(true);
    }

    this.onDragStart &&
      this.onDragStart({
        type: this.currentTransformTool.transformType,
        axis: axisTool.axis,
      });
  };

  private onPointerDown = (event: PointerEvent) => {
    this.addPointer(event);

    if (event.pointerType === 'mouse') {
      this.startGesture(event);

      return;
    }

    if (this.pointers.length > 1) {
      clearTimeout(this.pointerdownTimer);
      return;
    }

    this.pointerdownTimer = window.setTimeout(() => {
      this.startGesture(event);
    }, LONG_PRESS_DURATION);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled || this.pointers.length > 1) {
      return;
    }

    this.updatePointerAndRaycaster(event);

    // 超过一段距离，取消长按事件
    if (event.pointerType === 'touch' && this.pointerdownTimer) {
      const pointerDownEvent = this.pointers.find(
        (e) => e.pointerId === event.pointerId,
      );
      if (!pointerDownEvent) {
        return;
      }
      if (
        vec2.distance(
          [pointerDownEvent.clientX, pointerDownEvent.clientY],
          [event.clientX, event.clientY],
        ) > CLICK_OFFSET_THRESHOLD
      ) {
        clearTimeout(this.pointerdownTimer);
        this.pointerdownTimer = 0;
        return;
      }
    }

    if (this.selected) {
      const axisTool = this.currentTransformTool.getAxisToolByInteractiveObj(
        this.selected,
      );
      if (
        !axisTool ||
        !this.raycaster.ray.intersectPlane(INTERSECTION, this.controlsPlane)
      ) {
        return;
      }
      const diff = axisTool.handleDrag(
        INTERSECTION,
        this.matrixWorld,
        this.quaternionWorld,
      );
      this.onDrag &&
        this.onDrag({
          type: this.currentTransformTool.transformType,
          axis: axisTool.axis,
          currDiff: diff.currDiff,
          totalDiff: diff.totalDiff,
        });

      return;
    }

    if (event.pointerType === 'mouse') {
      // hover support
      this.setHovered();
    }
  };

  private intersectsObjects(): TransformIntersection[] {
    INTERSECTIONS.length = 0;

    if (!this.visible) {
      return INTERSECTIONS;
    }

    this.raycaster.intersectObjects(
      this.currentTransformTool.interactiveObjects,
      false,
      INTERSECTIONS,
    );

    // 如果没有检测到可交互工具，检测等比缩放热区圈
    // 等比缩放热区圈是个圆，用数学计算
    if (!INTERSECTIONS.length && this.isScale(this.currentTransformTool)) {
      const rect = this.domElement.getBoundingClientRect();

      mat4.getTranslation(WORLD_POS, this.matrixWorld);
      worldPosToClipPos(WORLD_POS, WORLD_POS, this.getCamera());
      clipPosToScreenPos(TEMP_VEC2, WORLD_POS, rect);

      clipPosToScreenPos(TEMP_VEC2_2, [POINTER[0], POINTER[1], 1], rect);

      const dist = vec2.distance(TEMP_VEC2_2, TEMP_VEC2);

      TRANSFORM_INTERSECTIONS.length = 0;
      if (dist < SCALE_DETECT_LENGTH) {
        TRANSFORM_INTERSECTIONS.push({
          object: this.scaleTool.ring.interactive,
        });
      }
      return TRANSFORM_INTERSECTIONS;
    }

    return INTERSECTIONS;
  }

  /**
   * 根据当前指针坐标更新各操纵杆的悬浮状态
   * @param forceReset 是否忽略“已悬浮”的缓存，强制重新检测
   */
  private setHovered(forceReset = false) {
    const intersections = this.intersectsObjects();

    if (intersections.length > 0) {
      const object = intersections[0].object;

      if (
        (this.hovered !== object || forceReset) &&
        this.hovered !== undefined
      ) {
        const axisTool = this.currentTransformTool.getAxisToolByInteractiveObj(
          this.hovered,
        );

        if (axisTool) {
          axisTool.setActive(false);
          this.updateCursor(false);
        }

        this.hovered = undefined;
      }

      if (this.hovered !== object) {
        const axisTool =
          this.currentTransformTool.getAxisToolByInteractiveObj(object);

        if (axisTool) {
          axisTool.setActive(true);
          this.updateCursor(true);
        }

        this.hovered = object;
      }
      return;
    }

    if (this.hovered !== undefined) {
      const axisTool = this.currentTransformTool.getAxisToolByInteractiveObj(
        this.hovered,
      );
      if (axisTool) {
        axisTool.setActive(false);
        this.updateCursor(false);
      }
      this.hovered = undefined;
    }
  }

  private setPlane(axisTool: AxisTool) {
    mat4.getTranslation(WORLD_POS, this.matrixWorld);
    quat.copy(WORLD_QUAT, this.quaternionWorld);
    if (this.isRotate(this.currentTransformTool)) {
      this.controlsPlane.setFromNormalAndCoplanarPoint(
        vec3.transformQuat(vec3.create(), UNIT[axisTool.axis], WORLD_QUAT),
        WORLD_POS,
      );
      return;
    }

    // 等比缩放工具的平面始终垂直于相机
    if (axisTool === this.scaleTool.ring) {
      const { position, target } = this.getCamera();
      this.controlsPlane.setFromNormalAndCoplanarPoint(
        vec3.sub(OFFSET, position, target),
        WORLD_POS,
      );
      return;
    }

    this.controlsPlane.updateByAxis({
      axis: axisTool.axis,
      cameraPosition: this.getCamera().position,
      targetWorldPos: WORLD_POS,
      targetWorldQuat: WORLD_QUAT,
    });
  }

  /**
   * 重写updateMatrixWorld，自动更新组件的缩放。
   * 让旋转组件跟随摄像机旋转
   */
  public updateMatrixWorld(force = false): void {
    this.currentTransformTool.rotateWithCamera(this.getCamera());
    this.getCamera().getFixedScale(
      this.scale,
      mat4.getTranslation(WORLD_POS, this.matrixWorld),
    );

    /**
     * transform工具相对屏幕保持固定大小，因此要除以父元素缩放系数，
     * 保持this.scale * parentScale === fixedSCale
     */
    if (this.parent) {
      mat4.getScaling(WORLD_POS, this.parent.matrixWorld);

      safeDivVec(this.scale, this.scale, WORLD_POS);
    }

    super.updateMatrixWorld(force);
  }

  private isRotate(transformTool: TransformTool): transformTool is Rotate {
    return transformTool.transformType === TransformType.Rotate;
  }

  private isScale(transformTool: TransformTool): transformTool is Scale {
    return transformTool.transformType === TransformType.Scale;
  }

  private updateCursor(active: boolean) {
    if (!this.isScale(this.currentTransformTool)) {
      return;
    }

    document.body.style.cursor = active ? 'nwse-resize' : '';
  }
}
