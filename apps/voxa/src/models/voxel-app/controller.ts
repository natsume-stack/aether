import type { Stage } from '../stage';
import type { EditingHistory } from '../editing-history';

import { vec2, vec3 } from 'gl-matrix';
import {
  Actions,
  boundary,
  EditingMode,
  fillSpace,
  newBundle,
  traverseVoxels,
} from '@box/utils/helper';
import type { AxisType } from '@box/box-design';
import type { VEState } from './state';
import { PointerAction } from '../../redux/app-slice';
import { store } from '../../redux/store';
import type { Pointer } from '../pointer';
import { CONTROLS_STATE, OrbitControls } from '../rendering/controls/orbit';
import { Axis } from '../rendering/def';
import type { Models } from '../voxel-model';
import { Model } from '../voxel-model/model';
import type { EditingController } from '../editing/controller';
import type { BoxBoundary, GetCamera } from '../editing/interfaces';
import { getSymmetryBoundaries } from '../editing/util';
import {
  CLICK_OFFSET_THRESHOLD,
  DBL_CLICK_PRESERVE_TIME,
} from '../editing/const';
import { flipVoxels, getBoxBoundary } from '@box/utils/voxel';
import type { IEvents } from '../events/interface';
import type { TranslateTool } from './translate-tool';
import type { UpdateSpaceSize } from './interfaces';
import { INDEX_TO_AXIS } from './interfaces';
import { LONG_PRESS_DURATION } from '../../defs';
import { VoxelDimension } from '../project/defs';

export interface ControllerParams {
  stage: Stage;
  history: EditingHistory;
  events: IEvents;
  translateTool: TranslateTool;
  veState: VEState;
  editingController: EditingController;
  models: Models;
  pointer: Pointer;
  updateSpaceSize: UpdateSpaceSize;
  saveHistory: () => void;
}

export class Controller {
  private getCamera: GetCamera;
  private canvas: HTMLCanvasElement;
  /**
   * HTML根元素
   */
  private domElement: HTMLElement | null;
  private pointer: Pointer;

  // 已选中空间的的对角顶点，仅适用于长方体空间
  private selectSpace: { start: vec3; end: vec3 } = {
    start: [-1, -1, -1],
    end: [-1, -1, -1],
  };

  /**
   * 射线原点的世界坐标
   */
  public rayOrigin: vec3 = [0, 0, 0];
  /**
   * 射线方向向量，normalized
   */
  public rayDir: vec3 = [0, 0, 0];
  /**
   * 鼠标指向位置的世界坐标
   */
  public rayPoint: vec3 = [0, 0, 0];

  /**
   * 上一次mousedown时，鼠标的位置，用于判断是否发生了双击
   */
  private prevScreenPos?: vec2;
  /**
   * 判断双击操作的定时器
   */
  private dblClickTimer = -1;

  public models: Models;

  /**
   * voxel选择模式下的选择起点
   */
  private start: vec3 | undefined = undefined;
  /**
   * voxel选择模式下已选中空间的边界
   */
  private prevBoundaries: BoxBoundary[] = [];
  /**
   * rect-select相关
   * 当前操作鼠标的起始屏幕坐标
   */
  private screenStart: [number, number] | undefined = undefined;

  private cameraMoveSurface: vec3[] = [];

  private multipleSelect: boolean = false;

  private veState: VEState;

  private stage: Stage;

  private history: EditingHistory;

  private events: IEvents;

  public editStepCount = 0;
  public saveStepMark = 0;
  public previousEditTime = Date.now();

  public virtualCursorEditLock = true;

  private controls: OrbitControls;

  private translateTool: TranslateTool;

  private updateSpaceSize: UpdateSpaceSize;

  private saveHistory: () => void;

  private editingController: EditingController;

  private pointers: PointerEvent[] = [];

  // 记录点击时的时间戳，用于判断抬起时是否是长按抬起或单击抬起
  private pointerDownTimeStamp: number = 0;
  // 记录pointerdown时的定时器，用于判断是否是长按
  private pointerDownTimer: number = 0;

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

  constructor({
    stage,
    history,
    pointer,
    veState,
    models,
    translateTool,
    editingController,
    updateSpaceSize,
    saveHistory,
    events,
  }: ControllerParams) {
    this.stage = stage;

    this.history = history;

    this.events = events;

    this.getCamera = this.stage.getCamera;

    this.domElement = document.body.querySelector('#voxel-editor');

    this.canvas = this.stage.renderer.domElement;

    this.controls = this.stage.orbitControls;

    this.veState = veState;

    this.models = models;

    this.pointer = pointer;

    this.translateTool = translateTool;

    this.updateSpaceSize = updateSpaceSize;

    this.saveHistory = saveHistory;

    this.editingController = editingController;
  }

  public updateSelectSpace(a: vec3, b: vec3) {
    const { start, end } = boundary(
      a,
      b,
      [0, 0, 0],
      this.models.destination.voxels.getDimension(),
    );
    if (this.selectSpace.start[0] == -1) {
      this.selectSpace.start = start;
      this.selectSpace.end = end;
    } else {
      vec3.min(this.selectSpace.start, this.selectSpace.start, start);
      vec3.max(this.selectSpace.end, this.selectSpace.end, end);
    }
  }

  public getCameraMoveSurface() {
    return this.cameraMoveSurface;
  }

  public pickingIntersectMesh() {
    this.models.editing.voxelPoints = [];
    fillSpace(
      this.models.editing.voxels,
      [0, 0, 0],
      this.models.editing.voxels.shape,
      (i, j, k) => {
        return (
          this.models.destination.voxels.getVoxel(i, j, k) ||
          this.models.selection.voxels.getVoxel(i, j, k)
        );
      },
    );

    if (!this.pointer.isVoxelPosValid()) {
      return void 0;
    }
    const res = this.pointer.getVoxelPos();

    let pickedModel: Model;

    if (this.models.selection.voxels.getVoxel(res[0], res[1], res[2])) {
      pickedModel = this.models.selection;
    } else if (
      this.models.destination.voxels.getVoxel(res[0], res[1], res[2])
    ) {
      pickedModel = this.models.destination;
    } else {
      return void 0;
    }
    const color = pickedModel.voxels.getVoxel(res[0], res[1], res[2]);
    return {
      color,
      pickedModel,
    };
  }

  // TODO: remove this
  public performHollowOut() {
    const data = this.pickingIntersectMesh();
    if (!data) {
      return;
    }
    const { pickedModel, color } = data;
    const shape = pickedModel.voxels.shape;
    traverseVoxels(
      pickedModel.voxels,
      [0, 0, 0],
      [shape[0] - 1, shape[1] - 1, shape[2] - 1],
      (i, j, k, d, ptr) => {
        if (d === color) {
          pickedModel.voxels.data[ptr] = 0;
        }
      },
    );

    pickedModel.bakeData();
  }

  /**
   * TODO move this to editing tool
   * 通过魔棒工具选取体素。
   * @param type 魔棒选择功能。'adjacent': 相邻选择，'all': 同色选择。
   */
  public performColorSelection(type: 'adjacent' | 'all') {
    const { destination, selection, colorSelectMode } = this.models;

    if (!this.multipleSelect) {
      this.deSelect();
    }

    if (!this.pointer.isVoxelPosValid()) {
      return;
    }

    const [x, y, z] = this.pointer.getVoxelPos();

    const textureId =
      destination.voxels.getVoxel(x, y, z) ||
      selection.voxels.getVoxel(x, y, z);

    if (textureId === 0) {
      return;
    }

    if (this.selectSpace.start[0] == -1) {
      this.selectSpace.start = [Infinity, Infinity, Infinity];
      this.selectSpace.end = [0, 0, 0];
    }

    const params = {
      out: {
        lo: this.selectSpace.start,
        hi: this.selectSpace.end,
      },
      textureId,
    };

    if (type === 'adjacent') {
      colorSelectMode.selectAdjacent(params);
    } else {
      colorSelectMode.selectAll(params);
    }

    selection.bakeData();

    destination.bakeData();
  }

  public intersectSelection() {
    const len =
      this.models.destination.voxels.shape[0] *
      this.models.destination.voxels.shape[1] *
      this.models.destination.voxels.shape[2];
    let hasSelection = false;
    for (let i = 0; i < len; i++) {
      if (this.models.selection.voxels.data[i] != 0) {
        hasSelection = true;
      }
    }
    if (!hasSelection) {
      return;
    }
    for (let i = 0; i < len; i++) {
      if (this.models.selection.voxels.data[i] == 0) {
        this.models.destination.voxels.data[i] = 0;
      }
    }

    this.models.destination.bakeData();
  }

  /**
   * 删除voxel
   * 如果有选中的voxel，则删除选中部分，同时隐藏可能出现的transformControl
   * 如果没有选中部分，则删除空间内的所有voxel
   */
  public clearVoxels() {
    this.selectSpace.start = [-1, -1, -1];
    this.selectSpace.end = [-1, -1, -1];

    this.models.selection.clearVoxel() || this.models.destination.clearVoxel();

    this.saveHistory();

    this.translateTool.activate();
  }

  private selectAll() {
    const len =
      this.models.destination.voxels.shape[0] *
      this.models.destination.voxels.shape[1] *
      this.models.destination.voxels.shape[2];
    for (let i = 0; i < len; i++) {
      if (this.models.selection.voxels.data[i] === 0) {
        this.models.selection.voxels.data[i] =
          this.models.destination.voxels.data[i];
      }
      this.models.destination.voxels.data[i] = 0;
    }
    this.models.selection.concatMeshBuffers(
      this.models.destination.rawMeshBuffer,
      this.models.destination.cIndexBuffer,
    );
    this.models.selection.bakeData(() => {
      this.models.destination.cleanMeshData();
    });
  }

  public deSelect() {
    const len =
      this.models.destination.voxels.shape[0] *
      this.models.destination.voxels.shape[1] *
      this.models.destination.voxels.shape[2];

    for (let i = 0; i < len; i++) {
      if (this.models.selection.voxels.data[i] != 0) {
        this.models.destination.voxels.data[i] =
          this.models.selection.voxels.data[i];
      }
      this.models.selection.voxels.data[i] = 0;
    }

    this.selectSpace.start = [-1, -1, -1];
    this.selectSpace.end = [-1, -1, -1];
    this.screenStart = undefined;

    this.models.destination.concatMeshBuffers(
      this.models.selection.rawMeshBuffer,
      this.models.selection.cIndexBuffer,
    );
    this.models.destination.bakeData();
    this.models.selection.cleanMeshData();
  }

  public flip(axis: AxisType) {
    let model: Model;

    if (this.models.selection.vertexCount > 0) {
      model = this.models.selection;
    } else if (this.models.destination.vertexCount > 0) {
      model = this.models.destination;
    } else {
      // TODO: 没有voxel的情况, 可能要补充交互
      return;
    }

    flipVoxels(model.voxels, axis);

    model.bakeData();

    this.saveHistory();
  }

  public rotate(axis: AxisType) {
    const { dimension } = store.getState().editing;
    // 2D状态时，只允许旋转被压缩的轴向
    if (dimension !== VoxelDimension.XYZ && INDEX_TO_AXIS[dimension] !== axis) {
      return;
    }

    let model: Model;
    let isSelection = false;

    if (this.models.selection.vertexCount > 0) {
      model = this.models.selection;
      isSelection = true;
    } else if (this.models.destination.vertexCount > 0) {
      model = this.models.destination;
    } else {
      // TODO: 没有voxel的情况, 可能要补充交互
      return;
    }

    this.models.editing.cleanMeshData();
    this.models.editing.clearVoxel();

    this.history.setGroup();

    switch (axis) {
      case 'X':
        if (isSelection) {
          this.selectionRotateX(model);
        } else {
          this.spaceRotateX(model);
        }
        break;
      case 'Y':
        if (isSelection) {
          this.selectionRotateY(model);
        } else {
          this.spaceRotateY(model);
        }
        break;
      case 'Z':
        if (isSelection) {
          this.selectionRotateZ(model);
        } else {
          this.spaceRotateZ(model);
        }
      default:
        break;
    }

    // set model using editing voxels
    traverseVoxels(
      this.models.editing.voxels,
      [0, 0, 0],
      model.voxels.getDimension(),
      (i, j, k, d) => {
        model.voxels.setVoxel(i, j, k, d);
      },
    );

    model.bakeData();

    this.saveHistory();

    this.history.unsetGroup();
  }

  /**
   * （只可能发生在裁剪空间之后的旋转选中部分操作前）
   * 更新建模空间。如无更新，则返回当前模型的boundary
   * @param model
   * @param options
   * @returns
   */
  private updateWorkspace(
    model: Model,
    options: {
      main: Axis;
      cross1: Axis;
      cross2: Axis;
    },
  ): BoxBoundary | undefined {
    const { main, cross1, cross2 } = options;
    if (main === Axis.E || cross1 === Axis.E || cross2 === Axis.E) {
      return;
    }

    const boundary = getBoxBoundary(model.voxels);
    const diameters = Model.getDiameters(boundary);
    const shape = model.voxels.shape;

    const s1 = shape[cross1];
    const s2 = shape[cross2];

    const d1 = diameters[cross1];
    const d2 = diameters[cross2];

    if (s1 >= d2 && s2 >= d1) {
      return boundary;
    }

    const newSize = [Math.max(s1, d2), Math.max(s2, d1)];
    newSize.splice(main, 0, shape[main]);

    if (Number(store.getState().editing.dimension) === main) {
      newSize[main] = 0;
    }

    this.updateSpaceSize([newSize[0], newSize[1], newSize[2]]);
  }

  /**
   * 旋转前移动selection voxel, 保证不会在旋转后移出建模空间
   * @param model selection model
   * @param options 指示旋转轴和旋转平面
   */
  private accommodateModel(
    model: Model,
    options: {
      main: Axis;
      cross1: Axis;
      cross2: Axis;
      boundary?: BoxBoundary;
    },
  ) {
    const { cross1, cross2 } = options;
    if (cross1 === Axis.E || cross2 === Axis.E) {
      return;
    }

    const boundary = options.boundary ?? getBoxBoundary(model.voxels);

    const shape = model.voxels.shape;
    const diameters = Model.getDiameters(boundary);
    const shift = [0, 0, 0];

    const s1 = shape[cross1];
    const s2 = shape[cross2];
    const d1 = diameters[cross1];
    const d2 = diameters[cross2];

    const { start } = boundary;

    // 如果旋转后轴1上的长度无法完全容纳轴2上的内容
    // 需要将内容沿轴1移动至恰好容纳
    if (start[cross1] + d2 > s1) {
      shift[cross1] = s1 - (start[cross1] + d2);
    }

    // 如果旋转后轴2上的长度无法完全容纳轴1上的内容
    // 需要将内容沿轴2移动至恰好容纳
    if (start[cross2] + d1 > s2) {
      shift[cross2] = s2 - (start[cross2] + d1);
    }

    if (shift[cross1] !== 0 || shift[cross2] !== 0) {
      model.translate(vec3.fromValues(shift[0], shift[1], shift[2]));
      model.updateRotateBox({ ...options, boundary: undefined });
    } else {
      model.updateRotateBox({ ...options, boundary });
    }
  }

  private spaceRotateX(model: Model) {
    const [sx, sy, sz] = model.voxels.shape;
    const rotatedSpace: vec3 = [sx, sz, sy];
    const dimension = model.voxels.getDimension();

    this.models.editing.reAlloc(rotatedSpace);

    traverseVoxels(model.voxels, [0, 0, 0], dimension, (i, j, k, d, idx) => {
      this.models.editing.voxels.setVoxel(i, k, dimension[1] - j, d);
      model.voxels.data[idx] = 0;
    });

    if (store.getState().editing.dimension === VoxelDimension.YZ) {
      rotatedSpace[VoxelDimension.YZ] = 0;
    }

    this.updateSpaceSize(rotatedSpace, false);
  }

  private spaceRotateY(model: Model) {
    const [sx, sy, sz] = model.voxels.shape;
    const rotatedSpace: vec3 = [sz, sy, sx];
    const dimension = model.voxels.getDimension();

    this.models.editing.reAlloc(rotatedSpace);

    traverseVoxels(model.voxels, [0, 0, 0], dimension, (i, j, k, d, idx) => {
      this.models.editing.voxels.setVoxel(dimension[2] - k, j, i, d);
      model.voxels.data[idx] = 0;
    });

    if (store.getState().editing.dimension === VoxelDimension.XZ) {
      rotatedSpace[VoxelDimension.XZ] = 0;
    }

    this.updateSpaceSize(rotatedSpace, false);
  }

  private spaceRotateZ(model: Model) {
    const [sx, sy, sz] = model.voxels.shape;
    const rotatedSpace: vec3 = [sy, sx, sz];
    const dimension = model.voxels.getDimension();

    this.models.editing.reAlloc(rotatedSpace);

    traverseVoxels(model.voxels, [0, 0, 0], dimension, (i, j, k, d, idx) => {
      this.models.editing.voxels.setVoxel(j, dimension[0] - i, k, d);
      model.voxels.data[idx] = 0;
    });

    if (store.getState().editing.dimension === VoxelDimension.XY) {
      rotatedSpace[VoxelDimension.XY] = 0;
    }

    this.updateSpaceSize(rotatedSpace, false);
  }

  private selectionRotateX(model: Model) {
    const boundary = this.updateWorkspace(model, {
      main: Axis.X,
      cross1: Axis.Y,
      cross2: Axis.Z,
    });

    this.accommodateModel(model, {
      main: Axis.X,
      cross1: Axis.Y,
      cross2: Axis.Z,
      boundary,
    });

    const { start, end } = model.rotateBox;

    const cy = (start[1] + end[1]) / 2;
    const cz = (start[2] + end[2]) / 2;

    traverseVoxels(model.voxels, start, end, (i, j, k, d) => {
      const dy = -(k - cz);
      const dz = j - cy;
      this.models.editing.voxels.setVoxel(i, cy + dy, cz + dz, d);
    });
  }

  private selectionRotateY(model: Model) {
    const boundary = this.updateWorkspace(model, {
      main: Axis.Y,
      cross1: Axis.X,
      cross2: Axis.Z,
    });

    this.accommodateModel(model, {
      main: Axis.Y,
      cross1: Axis.X,
      cross2: Axis.Z,
      boundary,
    });

    const { start, end } = model.rotateBox;

    const cx = (start[0] + end[0]) / 2;
    const cz = (start[2] + end[2]) / 2;

    traverseVoxels(model.voxels, start, end, (i, j, k, d) => {
      const dx = -(k - cz);
      const dz = i - cx;
      this.models.editing.voxels.setVoxel(cx + dx, j, cz + dz, d);
    });
  }

  private selectionRotateZ(model: Model) {
    const boundary = this.updateWorkspace(model, {
      main: Axis.Z,
      cross1: Axis.X,
      cross2: Axis.Y,
    });

    this.accommodateModel(model, {
      main: Axis.Z,
      cross1: Axis.X,
      cross2: Axis.Y,
      boundary,
    });

    const { start, end } = model.rotateBox;

    const cx = (start[0] + end[0]) / 2;
    const cy = (start[1] + end[1]) / 2;

    traverseVoxels(model.voxels, start, end, (i, j, k, d) => {
      const dx = -(j - cy);
      const dy = i - cx;
      this.models.editing.voxels.setVoxel(cx + dx, cy + dy, k, d);
    });
  }

  private beginVoxelSelect() {
    if (this.start) {
      return;
    }

    if (!this.pointer.isVoxelPosValid()) {
      return;
    }

    const res = this.pointer.getVoxelPos();

    this.start = res;

    const { destination, selection, editing } = this.models;

    const { mirrorMode } = store.getState().editing;
    const dimension = destination.voxels.getDimension();

    this.prevBoundaries = getSymmetryBoundaries({
      boxBoundary: {
        start: res,
        end: res,
      },
      range: dimension,
      opts: mirrorMode,
    });

    // 将整个selection模型空间拷贝到editing模型上
    traverseVoxels(
      selection.voxels,
      [0, 0, 0],
      dimension,
      (x, y, z, d, ptr) => {
        editing.voxels.data[ptr] = d;
      },
    );

    // 将鼠标按下位置的体素放入selection中
    this.prevBoundaries.forEach(({ start, end }) => {
      const [x, y, z] = start;
      selection.voxels.setVoxel(
        x,
        y,
        z,
        destination.voxels.getVoxel(x, y, z) ||
          editing.voxels.getVoxel(x, y, z),
      );

      this.updateSelectSpace(start, end);
    });
  }

  private onVoxelSelect() {
    if (!this.start || !this.pointer.isVoxelPosValid()) {
      return;
    }

    const res = this.pointer.getVoxelPos();

    const dimension = this.models.editing.voxels.getDimension();

    const { mirrorMode } = store.getState().editing;

    const newBoundaries = getSymmetryBoundaries({
      boxBoundary: { start: this.start, end: res },
      range: dimension,
      opts: mirrorMode,
    });

    // 新增的选中buf用destination或者已选中的selection部分的材质渲染
    this.prevBoundaries.forEach(({ start, end }, idx) => {
      const { start: newStart, end: newEnd } = newBoundaries[idx];
      this.models.selection.voxels = newBundle(
        this.models.selection.voxels,
        start,
        end,
        newStart,
        newEnd,
        (x, y, z) => this.models.editing.voxels.getVoxel(x, y, z),
        (x, y, z) =>
          this.models.destination.voxels.getVoxel(x, y, z) ||
          this.models.editing.voxels.getVoxel(x, y, z),
      );

      this.updateSelectSpace(start, end);
      this.updateSelectSpace(newStart, newEnd);
    });

    this.prevBoundaries = newBoundaries;

    this.models.selection.bakeData();
  }

  private endVoxelSelect() {
    const { destination, selection } = this.models;

    if (this.start || this.pointer.isVoxelPosValid()) {
      // 挖除destination中selection的部分
      fillSpace(
        destination.voxels,
        this.selectSpace.start,
        this.selectSpace.end,
        0,
        (x, y, z) => selection.voxels.getVoxel(x, y, z) != 0,
      );
    }

    selection.bakeData();
    destination.bakeData();

    this.start = undefined;

    this.saveHistory();
  }

  public mouseDetect(target: EventTarget | null) {
    return target === this.domElement || target === this.canvas;
  }

  public onPointerDown = (e: PointerEvent) => {
    this.addPointer(e);
    if (e.pointerType === 'mouse') {
      this.startGesture(e);
    } else {
      // 大于一个指，则不处理后面的逻辑，并清掉第一个指的逻辑
      if (this.pointers.length > 1) {
        clearTimeout(this.pointerDownTimer);
        this.pointerDownTimeStamp = 0;
        return;
      }
      this.pointerDownTimeStamp = new Date().getTime();
      this.pointerDownTimer = window.setTimeout(() => {
        this.startGesture(e);
      }, LONG_PRESS_DURATION);
    }
  };

  /**
   * pc端mousedown后的逻辑
   * @param e
   * @returns
   */
  public startGesture = (e: PointerEvent) => {
    /**
     * 还在加载或者处于导入模型的预览页时不处理 mousedown
     */
    if (this.veState.projectLoading || this.veState.previewMeshMode) {
      return;
    }

    /**
     * 未点击在编辑器区域内的事件不做处理，右键不处理，正在旋转时不处理
     */
    if (
      !this.mouseDetect(e.target) ||
      e.button == 2 ||
      this.controls.state === CONTROLS_STATE.ROTATE
    ) {
      return;
    }

    // 如果当前焦点在输入框，则不处理鼠标事件
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }

    /**
     * 如果中间键按下，则进行镜头移动，否则全都是编辑体素
     */
    if (e.button === 1) {
      return;
    } else {
      this.stage.setPointerAction(PointerAction.Dragging);
    }

    // 更新鼠标点击位置的屏幕坐标
    this.screenStart = [e.clientX, e.clientY];

    /**
     * 更新鼠标点击位置的世界坐标
     */
    const { width, height } = this.stage.getRendererDOMRect();

    vec3.transformMat4(
      <vec3>this.rayPoint,
      [(2.0 * e.clientX) / width - 1.0, (-2.0 * e.clientY) / height + 1.0, 0.0],
      this.getCamera().invViewProjection,
    );
    /**
     * 更新当前摄像机观察坐标系原点（即摄像机自己）的世界坐标
     * TODO 看起来如果摄像机没有变化，这一步是没有必要的？
     */
    vec3.transformMat4(
      <vec3>this.rayOrigin,
      [0, 0, 0],
      this.getCamera().viewMatrixInverse,
    );

    /**
     * 更新鼠标点击位置的方向向量
     */
    vec3.normalize(
      this.rayDir,
      vec3.subtract(vec3.create(), this.rayPoint, this.rayOrigin),
    );

    // 判断是否是双击
    if (this.triggerDblClick(this.screenStart)) {
      return true;
    }

    const { toolType, mode } = store.getState().editing;

    if (toolType === Actions.HollowOut) {
      this.performHollowOut();
      return;
    }

    if (toolType === Actions.Select) {
      // 如果已有选中的部分且不是多选状态，先取消选择
      (this.selectSpace.start[0] != -1 || this.screenStart) &&
        !this.multipleSelect &&
        this.deSelect();

      mode === EditingMode.voxel && this.beginVoxelSelect();

      return;
    }

    if (toolType === Actions.ColorSelect) {
      this.performColorSelection('adjacent');
      this.saveHistory();
      return;
    }

    this.editingController.onPointerDown();
  };

  /**
   * pc mousemove的逻辑
   * @param e
   */
  public moveGesture = (e: PointerEvent) => {
    if (!this.mouseDetect(e.target)) {
      return;
    }

    const { toolType, mode } = store.getState().editing;

    this.screenStart = [e.clientX, e.clientY];

    const { width, height } = this.stage.getRendererDOMRect();

    vec3.transformMat4(
      <vec3>this.rayPoint,
      [(2.0 * e.clientX) / width - 1.0, (-2.0 * e.clientY) / height + 1.0, 0.0],
      this.getCamera().invViewProjection,
    );
    vec3.transformMat4(
      <vec3>this.rayOrigin,
      [0, 0, 0],
      this.getCamera().viewMatrixInverse,
    );
    vec3.normalize(
      <vec3>this.rayDir,
      vec3.subtract(vec3.create(), this.rayPoint, this.rayOrigin),
    );

    if (
      this.prevScreenPos &&
      !this.isDblClickOffset(this.screenStart, this.prevScreenPos)
    ) {
      this.clearDblClickData();
    }

    if (store.getState().app.pointerAction !== PointerAction.Dragging) {
      return;
    }

    // TODO move these to tool
    if (toolType === Actions.Select && mode === EditingMode.voxel) {
      this.onVoxelSelect();

      return;
    }

    this.editingController.onPointerMove();
  };

  public onPointerMove = (e: PointerEvent) => {
    // 移动端move来确定是否按下后移动了一段距离，来清空长按的定时器和点击的时间戳
    if (e.pointerType === 'touch' && this.pointerDownTimeStamp) {
      const pointerDownEvent = this.pointers.find(
        (event) => event.pointerId === e.pointerId,
      );
      if (!pointerDownEvent) {
        return;
      }
      if (
        vec2.distance(
          [pointerDownEvent.clientX, pointerDownEvent.clientY],
          [e.clientX, e.clientY],
        ) > CLICK_OFFSET_THRESHOLD
      ) {
        clearTimeout(this.pointerDownTimer);
        this.pointerDownTimeStamp = 0;
        return;
      }
    }

    this.moveGesture(e);
  };

  public onPointerCanel = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      this.endGesture(e);
    } else {
      if (this.pointerDownTimer) {
        clearTimeout(this.pointerDownTimer);
      }
      if (
        this.pointers.length === 1 &&
        this.pointerDownTimeStamp &&
        new Date().getTime() - this.pointerDownTimeStamp < LONG_PRESS_DURATION
      ) {
        // 触发点击
        this.startGesture(e);
        this.endGesture(e);
      } else {
        this.endGesture(e);
      }
    }
    this.removePointer(e);
  };

  /**
   * pc端鼠标抬起后的逻辑
   * @param e
   */
  public endGesture = (e: PointerEvent) => {
    this.screenStart = [e.clientX, e.clientY];

    const { width, height } = this.stage.getRendererDOMRect();

    /**
     * 获取鼠标点击位置的世界坐标
     */
    vec3.transformMat4(
      <vec3>this.rayPoint,
      [(2.0 * e.clientX) / width - 1.0, (-2.0 * e.clientY) / height + 1.0, 0.0],
      this.getCamera().invViewProjection,
    );

    vec3.transformMat4(
      <vec3>this.rayOrigin,
      [0, 0, 0],
      this.getCamera().viewMatrixInverse,
    );
    vec3.normalize(
      <vec3>this.rayDir,
      vec3.subtract(vec3.create(), this.rayPoint, this.rayOrigin),
    );

    if (store.getState().app.pointerAction !== PointerAction.Dragging) {
      return;
    }

    const { toolType, mode } = store.getState().editing;

    let toSetMouseIdle = true;

    switch (toolType) {
      case Actions.Select:
        if (mode === EditingMode.voxel) {
          this.endVoxelSelect();
        }
        break;
      case Actions.Erase:
      case Actions.Attach:
        this.editingController.onPointerUp();

        if (mode === EditingMode.box) {
          toSetMouseIdle = false;
        }
        break;
      default:
        this.editingController.onPointerUp();
        break;
    }

    toSetMouseIdle && this.stage.setPointerAction(PointerAction.Idle);

    this.editStepCount++;
    this.previousEditTime = Date.now();
  };

  public onKeyDown = (e: KeyboardEvent) => {
    if (e.target && e.target instanceof HTMLInputElement) {
      return;
    }

    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        this.multipleSelect = true;

        this.editingController.onPressShift();
        break;
    }
  };

  /**
   * 中断当前工具的操作
   */
  public abortAction() {
    switch (store.getState().editing.toolType) {
      case Actions.Select:
        this.abortVoxelSelect();
        break;
      case Actions.Translate:
        this.translateTool.abort();
        break;
      default:
        this.editingController.abort();
        break;
    }
  }

  /**
   * 中断体素选择操作。
   */
  private abortVoxelSelect() {
    if (store.getState().editing.mode === EditingMode.voxel) {
      const { selection, destination } = this.models;

      this.prevBoundaries.forEach(({ start, end }) => {
        newBundle(
          selection.voxels,
          start,
          end,
          [0, 0, 0],
          [0, 0, 0],
          (x, y, z) => this.models.editing.voxels.getVoxel(x, y, z),
          (x, y, z) =>
            this.models.destination.voxels.getVoxel(x, y, z) ||
            this.models.editing.voxels.getVoxel(x, y, z),
        );
      });

      destination.bakeData();
      selection.bakeData();

      this.start = undefined;

      this.stage.setPointerAction(PointerAction.Idle);
    }
  }

  /**
   * 监听events的”deSelect“事件
   */
  private onDeSelect = () => {
    if (this.models.selection.vertexCount === 0) {
      return;
    }

    this.deSelect();
    this.saveHistory();

    // 重新激活移动工具
    this.translateTool.activate();
  };

  private onSelectAll = () => {
    this.selectAll();

    this.saveHistory();
    // 重新激活移动工具
    this.translateTool.activate();
  };

  public onKeyUp = (e: KeyboardEvent) => {
    if (e.target && e.target instanceof HTMLInputElement) {
      return;
    }

    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        this.multipleSelect = false;

        this.editingController.onReleaseShift();
        break;
    }
  };

  public onDragOver(ev: DragEvent) {
    return ev.preventDefault();
  }

  public onDrop(ev: DragEvent) {
    ev.preventDefault();
    if (!ev.dataTransfer) {
      return;
    }
  }

  public attachEvent() {
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerCanel);
    window.addEventListener('pointercancel', this.onPointerCanel);
    window.addEventListener('dragover', this.onDragOver);
    window.addEventListener('drop', this.onDrop);
    window.addEventListener('contextmenu', this.onContextMenu);

    this.events
      .addListener('abort', this.onAbort)
      .addListener('delete', this.onDelete)
      .addListener('selectAll', this.onSelectAll)
      .addListener('deSelect', this.onDeSelect);
  }

  public releaseEvent() {
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointercancel', this.onPointerCanel);
    window.removeEventListener('pointerup', this.onPointerCanel);
    window.removeEventListener('dragover', this.onDragOver);
    window.removeEventListener('drop', this.onDrop);
    window.addEventListener('contextmenu', this.onContextMenu);

    this.events
      .removeListener('abort', this.onAbort)
      .removeListener('delete', this.onDelete)
      .removeListener('selectAll', this.onSelectAll)
      .removeListener('deSelect', this.onDeSelect);
  }

  /**
   * 双击操作
   * 不是直接监听dblClick，而是在mousedown中，判断是否为双击，如果是，则触发双击事件。
   */
  private onDblClick = () => {
    const { toolType } = store.getState().editing;

    if (toolType === Actions.ColorSelect) {
      this.performColorSelection('all');
      this.saveHistory();
      return;
    }

    this.editingController.onDblClick();
  };

  private triggerDblClick(screenPos: vec2): boolean {
    if (!this.prevScreenPos) {
      this.prevScreenPos = vec2.clone(screenPos);

      this.dblClickTimer = window.setTimeout(() => {
        this.prevScreenPos = undefined;

        this.dblClickTimer = -1;
      }, DBL_CLICK_PRESERVE_TIME);

      return false;
    }

    const toTriggerDblClick = this.isDblClickOffset(
      screenPos,
      this.prevScreenPos,
    );

    this.clearDblClickData();

    if (toTriggerDblClick) {
      this.onDblClick();

      return true;
    }

    return false;
  }

  /**
   * 根据当前的鼠标位置，判断位置
   * @param newScreenPos 当前的鼠标坐标
   * @param prevScreenPos 上一次的鼠标坐标
   */
  private isDblClickOffset(newScreenPos: vec2, prevScreenPos: vec2): boolean {
    const delta = vec2.distance(newScreenPos, prevScreenPos);

    return delta <= CLICK_OFFSET_THRESHOLD;
  }

  /**
   * 清理双击的定时器和记录
   */
  private clearDblClickData() {
    clearTimeout(this.dblClickTimer);

    this.dblClickTimer = -1;

    this.prevScreenPos = undefined;
  }

  private onContextMenu = (evt: MouseEvent) => {
    evt.preventDefault();
  };

  private onAbort = () => {
    this.abortAction();
  };

  private onDelete = () => {
    this.clearVoxels();
  };
}
