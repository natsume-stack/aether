import { quat, vec2, vec3 } from 'gl-matrix';
import type { Pointer } from '../../pointer';
import { DEFAULT_POS } from '../const';
import { BoxBoundary, GetCamera } from '../interfaces';
import { boundary } from '@box/utils/helper';
import { ControlsPlane } from '../../rendering/math/controls-plane';
import { Axis } from '../../rendering/def';
import { getCubeVertices, getSymmetryPoints, isEmptyCollection } from '../util';
import { EditingCollector } from '../collector';
import { MirrorMode, setLayersTips } from '../../../redux/editing-slice';
import { store } from '../../../redux/store';
import {
  clipPosToScreenPos,
  worldPosToClipPos,
} from '../../../utils/coordinate';
import type { Stage } from '../../stage';

/**
 * 体建造时，预览的阶段。
 */
export enum BoxBuildingStep {
  None,
  /**
   * 构建单层平面
   */
  Rect,
  /**
   * 构建体的高度
   */
  Height,
}

type CalibrateLayers = (layers: number) => number;

/**
 * 用于建造体的工具类。
 * 分两端进行建造
 * 1. 建造平面矩形。
 * 2. 建造体的高度。
 */
export class BoxBuilder {
  /**
   * 绘制体高度时，在平面拖拽的起点位置。
   */
  private surfaceDragStartPos = vec3.clone(DEFAULT_POS);

  /**
   * 当前的绘制阶段
   */
  private step: BoxBuildingStep = BoxBuildingStep.None;

  /**
   * 执行射线检测的平面。
   */
  private surface = new ControlsPlane();

  private hitNormal = vec3.create();

  /**
   * 与hitNormal垂直的方向轴。用于确定平面的延伸方向。
   * 建造矩形时使用。
   */
  private axis = vec3.create();

  /**
   * 操作时的方向轴，仅用于确认x、y、z轴，不区分正负。
   * 建造高度时使用。
   */
  private direction = vec3.create();

  private boundaries: BoxBoundary[] = [];

  private modelDimension: vec3 = vec3.create();

  /**
   * 开始建造高度时，记录平面最右侧的顶点。
   */
  private surfaceRightVertex = vec3.create();

  /**
   * 开始建造高度时，记录平面的高低点，用于对比确定体的变化方向。
   */
  private surfaceLo = vec3.create();
  private surfaceHi = vec3.create();

  /**
   * 校准layers的函数。
   */
  private layersCalibration?: CalibrateLayers;

  constructor(
    private pointer: Pointer,
    private getCamera: GetCamera,
    private collector: EditingCollector,
    private stage: Stage,
  ) {}

  /**
   * 切换到下一个构建阶段。
   */
  private setStep(step: BoxBuildingStep) {
    if (this.step === step) {
      return;
    }

    switch (step) {
      case BoxBuildingStep.Rect:
        this.collector.setLimit(2);
        break;
      case BoxBuildingStep.Height:
        this.collector.setLimit(3);
        break;
      default:
        this.clear();
        return;
    }

    this.step = step;

    this.updateSurface();
  }

  public getStep() {
    return this.step;
  }

  /**
   * 清空当前状态和操作
   */
  public clear() {
    this.step = BoxBuildingStep.None;

    vec3.zero(this.surfaceDragStartPos);

    vec3.copy(this.axis, DEFAULT_POS);
    vec3.copy(this.hitNormal, DEFAULT_POS);

    vec3.zero(this.surfaceRightVertex);

    store.dispatch(
      setLayersTips({
        visible: false,
      }),
    );

    this.updateCursorStyle();
  }

  public generateBoxBoundaries(
    symmetry: Partial<MirrorMode>,
  ): BoxBoundary[] | undefined {
    const collection = this.collector.getCollection();

    if (isEmptyCollection(collection)) {
      return;
    }

    const start = collection[0];
    const end = collection[collection.length - 1];

    const startPoints = getSymmetryPoints({
      point: start,
      range: this.modelDimension,
      opts: symmetry,
    });

    const endPoints = getSymmetryPoints({
      point: end,
      range: this.modelDimension,
      opts: symmetry,
    });

    return startPoints.reduce<BoxBoundary[]>((prev, start, idx) => {
      const end = endPoints[idx];

      if (end) {
        const boxBoundary = boundary(
          start,
          end,
          [0, 0, 0],
          this.modelDimension,
        );

        prev.push(boxBoundary);

        // 只处理首个
        if (this.step === BoxBuildingStep.Height && idx === 0) {
          const { lo, hi } = this.getSurfaceBoundary(
            boxBoundary.start,
            boxBoundary.end,
          );

          this.updateTips(lo, hi);
        }
      }

      return prev;
    }, []);
  }

  public updateDimension(dimension: vec3) {
    vec3.copy(this.modelDimension, dimension);
  }

  /**
   * 根据指针的方向向量，更新计算方向轴。
   */
  public updateData(hitNormal: vec3, modelDimension: vec3) {
    vec3.copy(this.hitNormal, hitNormal);

    // axis用于计算底部平面的延伸方向。
    vec3.set(
      this.axis,
      hitNormal[0] === 0 ? 1 : 0,
      hitNormal[1] === 0 ? 1 : 0,
      hitNormal[2] === 0 ? 1 : 0,
    );

    /**
     * direction与hitNormal相同，取绝对值，不区分正负。
     */
    vec3.set(
      this.direction,
      Math.abs(hitNormal[0]),
      Math.abs(hitNormal[1]),
      Math.abs(hitNormal[2]),
    );

    vec3.copy(this.modelDimension, modelDimension);
  }

  private intersectSurface(): vec3 | undefined {
    return this.pointer.raycaster.ray.intersectPlane(
      vec3.create(),
      this.surface,
    );
  }

  public updatePosition() {
    // 起点位置是在外部确定
    const collection = this.collector.getCollection();

    const start = collection[0];

    if (!start) {
      return;
    }

    // 基于平面检测更新end
    const end = this.intersectSurface();

    if (!end) {
      return;
    }

    if (this.step === BoxBuildingStep.Rect) {
      vec3.floor(end, end);

      /**
       * end需要与start处在同个平面
       */
      this.axis.forEach((value, idx) => {
        if (value === 0) {
          end[idx] = start[idx];
        }
      });

      this.collector.addPosition(end);

      return;
    }

    const rectEnd = collection[1];

    if (!rectEnd) {
      return;
    }

    /**
     * updating height
     */
    if (this.step === BoxBuildingStep.Height) {
      const shift = vec3.sub(vec3.create(), end, this.surfaceDragStartPos);

      vec3.floor(shift, shift);

      vec3.mul(shift, shift, this.direction);

      vec3.add(end, rectEnd, shift);

      this.collector.addPosition(end);
    }
  }

  /**
   * 根据当前的状态以及绘制阶段，更新平面，用于射线检测。
   */
  private updateSurface() {
    const planeNormal = vec3.create();
    const vertex = vec3.create();

    let isBuildingHeight = false;

    const offset = FACE_POINTS[this.hitNormal.join()];

    if (!offset) {
      return;
    }

    const [start, rectEnd] = this.collector.getCollection();

    switch (this.step) {
      /**
       * 绘制矩形时，平面为pointer选中的平面。
       */
      case BoxBuildingStep.Rect:
        if (!start) {
          return;
        }

        vec3.copy(planeNormal, this.hitNormal);

        vec3.add(vertex, start, offset);

        this.surface.setFromNormalAndCoplanarPoint(planeNormal, vertex);
        break;
      /**
       * 绘制高度时，平面为垂直于选中平面的平面
       */
      case BoxBuildingStep.Height:
        if (!rectEnd) {
          return;
        }

        let axis: Axis = Axis.Z;

        if (this.hitNormal[0] !== 0) {
          axis = Axis.X;
        } else if (this.hitNormal[1] !== 0) {
          axis = Axis.Y;
        }

        vec3.add(vertex, rectEnd, offset);

        this.surface.updateByAxis({
          axis,
          cameraPosition: this.getCamera().position,
          targetWorldPos: vertex,
          targetWorldQuat: quat.create(),
        });

        isBuildingHeight = true;
        break;
      default:
        return;
    }

    /**
     * 是否立即执行一次检测，更新surfacePrevEnd。
     * 绘制高度时需要，因为绘制高度时是通过相对值进行计算。
     */
    if (!isBuildingHeight) {
      return;
    }

    const res = this.intersectSurface();

    if (!res) {
      return;
    }

    vec3.floor(this.surfaceDragStartPos, res);
  }

  public getBoundaries() {
    return this.boundaries;
  }

  /**
   * 设置当前模式为矩形绘制。
   */
  public setBuildingRect(params: {
    voxelPos: vec3;
    hitNormal: vec3;
    modelDimension: vec3;
  }) {
    const { voxelPos, hitNormal, modelDimension } = params;

    this.updateData(hitNormal, modelDimension);

    this.collector.setCollection([voxelPos, vec3.clone(voxelPos)]);

    this.setStep(BoxBuildingStep.Rect);
  }

  /**
   * 设置当前模式为高度建造模式。
   */
  public setBuildingHeight() {
    const collection = this.collector.getCollection();

    if (collection.length < 2) {
      return;
    }

    this.setStep(BoxBuildingStep.Height);

    const newCollection = collection.slice();

    const last = newCollection[newCollection.length - 1];

    newCollection.push(vec3.clone(last));

    this.collector.setCollection(newCollection);

    this.initTips(newCollection);
  }

  /**
   * 根据当前建造阶段，更新鼠标的样式。
   * - 建造高度时，设置垂直滚轮样式（ns-resize）。
   * - 其余情况恢复默认。
   */
  private updateCursorStyle() {
    const cursorKeyword =
      this.step === BoxBuildingStep.Height ? 'ns-resize' : 'unset';

    document.body.style.cursor = cursorKeyword;
  }

  /**
   * 初始化“层数提示”。
   */
  private initTips(list: vec3[]) {
    const [rectStart, rectEnd] = list;

    const { start: boundaryStart, end: boundaryEnd } = boundary(
      rectStart,
      rectEnd,
      [0, 0, 0],
      this.modelDimension,
    );

    const isNegative = this.hitNormal.some((v) => v < 0);

    const { lo, hi } = this.getSurfaceBoundary(boundaryStart, boundaryEnd);

    vec3.copy(this.surfaceLo, lo);
    vec3.copy(this.surfaceHi, hi);

    // 需要根据平面延伸方向填充1。因为体素长宽高为1.
    vec3.add(this.surfaceHi, this.surfaceHi, this.axis);

    const vertices = getCubeVertices(this.surfaceLo, this.surfaceHi);

    const tempClipPos = vec3.create();
    const maxRightClip = vec3.fromValues(-2, 0, 0);

    // 寻找在裁剪坐标系下，最右侧的点。后续基于这个点 + 体的高度差，计算tips的屏幕坐标。
    vertices.forEach((v) => {
      worldPosToClipPos(tempClipPos, v, this.getCamera());

      if (tempClipPos[0] > maxRightClip[0]) {
        vec3.copy(maxRightClip, tempClipPos);

        vec3.copy(this.surfaceRightVertex, v);
      }
    });

    const pos = vec2.create();

    clipPosToScreenPos(pos, maxRightClip, this.stage.getRendererDOMRect());

    const layers = isNegative ? -1 : 1;

    this.setLayers(layers, pos);

    this.updateCursorStyle();
  }

  private updateTips(start: vec3, end: vec3) {
    const shift = vec3.create();

    vec3.sub(shift, end, start);
    vec3.mul(shift, shift, this.direction);
    let layers = 0;

    if (vec3.exactEquals(shift, [0, 0, 0])) {
      const isNegative = this.hitNormal.some((v) => v < 0);

      layers = isNegative ? -1 : 1;
    } else {
      let ratio = 1;

      // 起点发生了变化，说明体在朝负方向变化。
      if (!vec3.exactEquals(start, this.surfaceLo)) {
        ratio = -1;
      }

      vec3.scale(shift, shift, ratio);

      layers = ratio * (vec3.len(shift) + 1);
    }

    const clipPos = vec3.create();

    vec3.add(clipPos, this.surfaceRightVertex, shift);

    worldPosToClipPos(clipPos, clipPos, this.getCamera());

    const pos = vec2.create();

    clipPosToScreenPos(pos, clipPos, this.stage.getRendererDOMRect());

    this.setLayers(layers, pos);
  }

  /**
   * 根据hitNormal计算平面的boundary。
   * 当hitNormal方向为正方向时，给lo跟hi增加一个方向向量的偏差。
   * 原因是体素的坐标点是以最低点为坐标，需要根据情况调整，来准确算出“在变化的平面”。
   */
  private getSurfaceBoundary(start: vec3, end: vec3) {
    const isNegative = this.hitNormal.some((v) => v < 0);

    const lo = vec3.create();
    const hi = vec3.create();

    if (isNegative) {
      vec3.copy(lo, start);
      vec3.copy(hi, end);
    } else {
      vec3.add(lo, start, this.hitNormal);
      vec3.add(hi, end, this.hitNormal);
    }

    return { lo, hi };
  }

  /**
   * 设置layers，并更新store。
   */
  private setLayers(newLayers: number, position: vec2) {
    let layers = newLayers;

    if (this.layersCalibration) {
      layers = this.layersCalibration(layers);
    }

    const [x, y] = position;

    store.dispatch(
      setLayersTips({
        visible: true,
        position: [x, y],
        layers: `${layers}`,
      }),
    );
  }

  /**
   * 设置“层数提示”的调整函数。
   * “层数”会根据体高度的建造方向变化，带有“正负”。
   * 建造工具会处理成一直是“正”。
   * 删减工具会处理成一直是“负”。
   */
  public setLayersCalibration(fn: CalibrateLayers) {
    this.layersCalibration = fn;
  }
}

const FACE_POINTS: Record<string, vec3> = {
  '0,0,-1': [0, 0, 0],
  '0,0,1': [1, 0, 1],
  '0,1,0': [0, 1, 0],
  '0,-1,0': [0, 0, 0],
  '-1,0,0': [0, 0, 0],
  '1,0,0': [1, 1, 1],
};
