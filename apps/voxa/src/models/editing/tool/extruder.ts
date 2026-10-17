import { quat, vec2, vec3 } from 'gl-matrix';
import { clamp } from 'ramda';
import { setLayersTips } from '../../../redux/editing-slice';
import { store } from '../../../redux/store';
import { inRange } from '@box/utils/helper';
import { VoxelView } from '@box/utils/voxel';
import { clipPosToScreenPos } from '../../../utils/coordinate';
import { ControlsPlane } from '../../rendering/math/controls-plane';
import type { GetCamera } from '../interfaces';
import {
  composeSymmetryOperation,
  getCubeVertices,
  isEmptyVoxel,
  vertexToClipPos,
} from '../util';
import { BasicTool, Params } from './base';

/**
 * 体素的长宽高为1
 */
const VOXEL_SIZE = 1;

interface ExtruderParams extends Params {
  getCamera: GetCamera;
}

const WORLD_QUAT = quat.create();

/**
 * 挤压/拉伸的工具。
 * 拉伸时，增加独立的体的层数。
 * 挤压时，删减独立的体的层数。
 */
export class Extruder extends BasicTool {
  protected ignoreMode = true;

  private started = false;

  /**
   * 代表与hitNormal不同轴的另外两个方向轴。
   * 当hitNormal为(0, 1, 0)或者(0, -1, 0)时，axis为(1, 0, 1)。
   */
  private axis = vec3.create();

  private getCamera: GetCamera;

  private facePoints: vec3[] = [];

  private modelDimension = vec3.create();

  private maxRightVertex = vec3.create();

  private hitNormal = vec3.create();

  private hitNormalIdx = -1;

  /**
   * 用于做射线检测的平面。
   */
  private controlsPlane: ControlsPlane;

  // 层从 0 到 (dimension + 1) 0表示没有层，(dimension + 1) 表示满。
  /**
   * 当前拖动到的”层“
   */
  private currentLayers = 0;

  /**
   * 开始拖拽时，现有的”层“
   */
  private layersOnDragStart = 0;

  private maxLayers = 0;

  private minLayers = 0;

  constructor({ getCamera, ...others }: ExtruderParams) {
    super(others);

    this.controlsPlane = new ControlsPlane();

    this.getCamera = getCamera;
  }

  protected onEnabled(): void {
    this.collector.setLimit(2);
  }

  protected onDisabled(): void {
    this.clear();
  }

  protected onAbort(): void {
    this.started && this.clear();
  }

  public start() {
    if (this.started) {
      return;
    }

    const model = this.getPointingModel();

    if (!model) {
      return;
    }

    this.started = true;

    const hitNormal = this.pointer.getNormal();

    const voxelPos = this.pointer.getVoxelPos();

    const [x, y, z] = voxelPos;

    const textureId = model.voxels.getVoxel(x, y, z);

    this.collector.setSrc(this.modelsDict.destination);

    const tempClipPos = vec3.create();
    const tempMaxRightClip = vec3.fromValues(-2, 0, 0);

    vec3.copy(this.modelDimension, model.voxels.getDimension());

    this.initStateOnStart(hitNormal, voxelPos);

    const compareMaxRight = (pos: vec3, offset?: vec3) => {
      if (offset) {
        vec3.add(tempClipPos, pos, offset);
      } else {
        vec3.copy(tempClipPos, pos);
      }

      vertexToClipPos(tempClipPos, tempClipPos, this.getCamera());

      if (tempClipPos[0] > tempMaxRightClip[0]) {
        vec3.copy(tempMaxRightClip, tempClipPos);

        vec3.copy(this.maxRightVertex, pos);
      }
    };

    const centerOffset = VOXEL_SIZE / 2;

    this.editModes.face.parse({
      hitNormal,
      voxelView: model.voxels,
      options: {
        type: 'hitTextureId',
        hitTextureId: textureId,
      },
      startPos: voxelPos,
      operation: ({ pos }) => {
        this.facePoints.push(pos);

        // 先找在裁剪坐标系中，最靠右的边缘体素坐标
        if (!this.isEdge(model.voxels, pos, this.axis)) {
          return;
        }

        compareMaxRight(pos, [centerOffset, centerOffset, centerOffset]);
      },
    });

    const inflateEnd = vec3.add(vec3.create(), this.maxRightVertex, this.axis);

    // TODO 需要根据“边界”情况修正对比的值。
    const vertices = getCubeVertices(this.maxRightVertex, inflateEnd);

    // 再找到该平面中，最靠右的顶点。
    vertices.forEach((pos) => {
      compareMaxRight(pos);
    });

    // 再根据方向向量的正负性，确定需不需要补充体素长宽高的1单位距离。
    if (this.hitNormal[this.hitNormalIdx] > 0) {
      this.maxRightVertex[this.hitNormalIdx] += VOXEL_SIZE;
    }

    // 记录起始时的触点位置，后续在update中做对比，计算差值，再计算更新的层数。
    this.updatePosition();

    // 初始时，增加一层
    const newLayer = this.currentLayers + this.hitNormal[this.hitNormalIdx];

    this.modelsDict.destination.blockRender(true);
    this.modelsDict.editing.blockRender(false);

    this.updateLayer(newLayer);

    this.modelsDict.editing.bakeData();

    this.updateLayersTips();

    this.updatePointer(true);
  }

  public update() {
    if (!this.started) {
      return;
    }

    this.updatePosition();

    const collection = this.collector.getCollection();

    const collectionStart = collection[0];

    const collectionEnd = collection[collection.length - 1];

    const posOffset = Math.floor(
      collectionEnd[this.hitNormalIdx] - collectionStart[this.hitNormalIdx],
    );

    const offset = this.hitNormal[this.hitNormalIdx] > 0 ? VOXEL_SIZE : 0;

    if (this.updateLayer(this.layersOnDragStart + offset + posOffset)) {
      this.updateLayersTips();

      this.modelsDict.editing.bakeData();
    }
  }

  public end() {
    if (!this.started) {
      return;
    }

    const { destination, editing } = this.modelsDict;

    // 层数不同时，说明产生有效变化。
    if (this.currentLayers !== this.layersOnDragStart) {
      destination.voxels.copy(editing.voxels);

      destination.blockRender(false);

      editing.blockRender(true);

      destination.bakeData();

      this.saveHistory();
    }

    this.clear();
  }

  private clear() {
    this.started = false;

    this.collector.clear();

    this.facePoints = [];

    this.layersOnDragStart = 0;

    this.currentLayers = 0;

    this.hitNormalIdx = -1;

    vec3.zero(this.hitNormal);

    vec3.zero(this.axis);

    store.dispatch(setLayersTips({ visible: false }));

    this.updatePointer(false);

    const { destination, editing } = this.modelsDict;

    destination.blockRender(false);

    editing.blockRender(true);
  }

  /**
   * 根据点击时的指针状态，更新一些数据和状态。
   */
  private initStateOnStart(hitNormal: vec3, voxelPos: vec3) {
    for (let i = 0; i < 3; i++) {
      if (hitNormal[i] === 0) {
        this.axis[i] = 1;
      } else {
        this.axis[i] = 0;
        this.hitNormalIdx = i;
      }
    }

    this.controlsPlane.updateByAxis({
      axis: this.hitNormalIdx,
      cameraPosition: this.getCamera().position,
      targetWorldPos: voxelPos,
      targetWorldQuat: WORLD_QUAT,
    });

    vec3.copy(this.hitNormal, hitNormal);

    // 起始时，如果是正方向，需要补充一个体素尺寸
    const offset = this.hitNormal[this.hitNormalIdx] > 0 ? VOXEL_SIZE : 0;

    this.layersOnDragStart = voxelPos[this.hitNormalIdx] + offset;

    this.currentLayers = this.layersOnDragStart;

    this.maxLayers = this.modelDimension[this.hitNormalIdx] + VOXEL_SIZE;
  }

  private updatePosition() {
    const pos = vec3.create();

    this.pointer.raycaster.ray.intersectPlane(pos, this.controlsPlane);

    this.collector.addPosition(pos);
  }

  private updateLayer(newLayers: number): boolean {
    newLayers = clamp(this.minLayers, this.maxLayers, newLayers);

    if (newLayers === this.currentLayers) {
      return false;
    }

    const layersDiff = newLayers - this.currentLayers;

    const layerStep = Math.sign(layersDiff);

    const hitNormalOffset = this.hitNormal[this.hitNormalIdx];

    // 判断是否在”增加“层
    const isAddingLayers = Math.sign(layersDiff) === hitNormalOffset;

    if (isAddingLayers) {
      this.addLayers({
        targetLayers: newLayers,
        layerStep,
        hitNormalOffset,
      });
    } else {
      this.removeLayers({
        targetLayers: newLayers,
        layerStep,
        hitNormalOffset,
      });
    }

    return true;
  }

  /**
   * 判断体素点是否为指定的轴方向上的边缘”边缘“
   */
  private isEdge(voxelView: VoxelView, pos: vec3, axis: vec3) {
    const tempPos = vec3.create();
    const tempOffset = vec3.create();
    const min: vec3 = [0, 0, 0];
    const max = this.modelDimension;

    const test = (pos: vec3, offset: vec3) => {
      vec3.add(tempPos, pos, offset);

      if (!inRange(tempPos, min, max)) {
        return true;
      }

      const [x, y, z] = tempPos;

      if (isEmptyVoxel(voxelView.getVoxel(x, y, z))) {
        return true;
      }
    };

    for (let i = 0; i < 3; i++) {
      if (axis[i] === 0) {
        continue;
      }

      vec3.zero(tempOffset);

      tempOffset[i] = 1;

      if (test(pos, tempOffset)) {
        return true;
      }

      tempOffset[i] = -1;

      if (test(pos, tempOffset)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 更新“层数提示“的组件
   */
  private updateLayersTips() {
    const tempPos = vec3.clone(this.maxRightVertex);

    const diff = this.currentLayers - this.layersOnDragStart;

    tempPos[this.hitNormalIdx] += diff;

    vertexToClipPos(tempPos, tempPos, this.getCamera());

    const position: vec2 = [0, 0];

    clipPosToScreenPos(position, tempPos, this.stage.getRendererDOMRect());

    let layers = Math.abs(diff);

    const isAddingLayers =
      Math.sign(diff) === this.hitNormal[this.hitNormalIdx];

    if (!isAddingLayers) {
      layers = -1 * layers;
    }

    store.dispatch(
      setLayersTips({
        visible: true,
        position,
        layers: `${layers}`,
      }),
    );
  }

  private updatePointer(isDragging: boolean) {
    if (isDragging) {
      this.pointer.setDrawingEnabled(false);

      const cursorKeyword = 'ns-resize';

      document.body.style.cursor = cursorKeyword;
    } else {
      this.pointer.setDrawingEnabled(true);

      this.pointer.update();

      const cursorKeyword = 'unset';

      document.body.style.cursor = cursorKeyword;
    }
  }

  /**
   * 以特定步长，增加当前层，到达指定层。
   */
  private addLayers(params: {
    targetLayers: number;
    layerStep: number;
    hitNormalOffset: number;
  }) {
    const { targetLayers, layerStep, hitNormalOffset } = params;

    // 对“层“操作时，顶点的偏差
    const posOffset = vec3.create();

    const tempPos = vec3.create();

    const paletteTextureId = store.getState().palette.selectedId;

    const { editing, destination } = this.modelsDict;

    let isUpperLayer: () => boolean;

    if (hitNormalOffset > 0) {
      isUpperLayer = () => this.currentLayers > this.layersOnDragStart;
    } else {
      isUpperLayer = () => this.currentLayers < this.layersOnDragStart;
    }

    const operation = composeSymmetryOperation({
      opts: store.getState().editing.mirrorMode,
      range: this.modelDimension,
      operation: ({ pos: [x, y, z] }) => {
        const srcTextureId = destination.voxels.getVoxel(x, y, z);

        let textureId = paletteTextureId;

        if (isUpperLayer()) {
          if (isEmptyVoxel(srcTextureId)) {
            editing.voxels.setVoxel(x, y, z, textureId);
          }
        } else {
          editing.voxels.setVoxel(x, y, z, srcTextureId);
        }
      },
    });

    while (this.currentLayers !== targetLayers) {
      // 增加时，从下一层开始执行
      this.currentLayers += layerStep;

      posOffset[this.hitNormalIdx] =
        this.currentLayers - this.layersOnDragStart;

      this.facePoints.forEach((point) => {
        vec3.add(tempPos, point, posOffset);

        if (!inRange(tempPos, [0, 0, 0], this.modelDimension)) {
          return;
        }

        operation({ pos: tempPos });
      });
    }
  }

  /**
   * 以特定步长，删减当前层，到达指定层。
   */
  private removeLayers(params: {
    targetLayers: number;
    layerStep: number;
    hitNormalOffset: number;
  }) {
    const { targetLayers, layerStep, hitNormalOffset } = params;

    const posOffset = vec3.create();

    const tempPos = vec3.create();

    const { editing, destination } = this.modelsDict;

    let isUpperLayer: () => boolean;

    if (hitNormalOffset > 0) {
      isUpperLayer = () => this.currentLayers > this.layersOnDragStart;
    } else {
      isUpperLayer = () => this.currentLayers < this.layersOnDragStart;
    }

    const operation = composeSymmetryOperation({
      opts: store.getState().editing.mirrorMode,
      range: this.modelDimension,
      operation: ({ pos: [x, y, z] }) => {
        const textureId = isUpperLayer()
          ? destination.voxels.getVoxel(x, y, z)
          : 0;

        editing.voxels.setVoxel(x, y, z, textureId);
      },
    });

    // 删减时，需要从当前层开始执行
    while (this.currentLayers !== targetLayers) {
      posOffset[this.hitNormalIdx] =
        this.currentLayers - this.layersOnDragStart;

      this.facePoints.forEach((point) => {
        vec3.add(tempPos, point, posOffset);

        if (!inRange(tempPos, [0, 0, 0], this.modelDimension)) {
          return;
        }

        operation({ pos: tempPos });
      });

      this.currentLayers += layerStep;
    }
  }
}
