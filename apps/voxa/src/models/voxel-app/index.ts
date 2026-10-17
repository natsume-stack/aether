import { mat4, vec3, vec4, quat } from 'gl-matrix';
import { IntlShape } from 'react-intl';
import { AXIS, AxisType } from '@box/box-design';
import type { EditingHistory } from '../editing-history';
import { VEState } from './state';
import { BoundaryBox } from '../boundary';
import { Controller } from './controller';
import { Pointer } from '../pointer';
import { Scene } from '../rendering/objects/scene';
import { Raycaster } from '../rendering/raycast';
import { Models } from '../voxel-model';
import { store } from '../../redux/store';
import {
  setDimension,
  setTool,
  setWorkspaceSize,
} from '../../redux/editing-slice';
import { MirrorPlane } from '../mirror-plane';
import { AttachPreview } from '../editing/attach-preview';
import { VoxelManager } from './voxel-manager';
import { DirectionIndicator } from '../direction-indicator';
import { SerializedVec3, serializeVec3 } from '../../utils/math';
import { TranslateTool } from './translate-tool';
import type { Stage } from '../stage';
import type { ApplyVoxels, SetTool, UpdateSpaceSize } from './interfaces';
import { EditingController } from '../editing/controller';
import type { IEvents } from '../events/interface';
import { Object3D } from '../rendering/objects/object3d';
import type { SkinPart } from '../skin-part';
import { IDENTITY_SCALE } from '../rendering/controls/transform/def';
import { VoxelDimension } from '../project/defs';
import { MIN_VOXEL_SIZE } from '../../defs';

const TEMP_MAT4 = mat4.create();

export interface VoxelAppOptions {
  regl: createREGL.Regl;
  getIntl: () => IntlShape | undefined;
  getSkinPart: (id: string) => SkinPart | undefined;
  history: EditingHistory;
  stage: Stage;
  events: IEvents;
}

export class VoxelApp {
  public readonly scene: Scene;

  private readonly stage: Stage;

  private readonly events: IEvents;

  public boundary: BoundaryBox;
  public directionIndicator: DirectionIndicator;
  public mirrorPlanes: Record<AxisType, MirrorPlane | undefined>;
  public pointer: Pointer;
  public readonly models: Models;

  public veController: Controller;
  public veState: VEState;
  /**
   * i18n
   */
  public getIntl: () => IntlShape | undefined;

  private getSkinPart: (id: string) => SkinPart | undefined;

  public connectedToGameEditor: boolean = false;

  public maxNameLen = 30;

  private attachPreview?: AttachPreview;

  /**
   * 体素模块的移动工具
   */
  public translateTool: TranslateTool;

  public readonly voxelManager: VoxelManager;

  public readonly history: EditingHistory;

  private enabled = true;

  private readonly editingController: EditingController;

  /**
   * 模型背景
   */
  private modelBackground = new Object3D();

  constructor(opt: VoxelAppOptions) {
    const { regl, getIntl, stage, history, events, getSkinPart } = opt;
    this.stage = stage;

    this.getIntl = getIntl;

    this.getSkinPart = getSkinPart;

    this.history = history;

    this.events = events;

    this.veState = new VEState();
    const spaceSize = store.getState().editing.workspaceSize;

    const scene = new Scene();
    scene.setBackgroundColor(vec4.fromValues(0, 0, 0, 1));

    const boundary = new BoundaryBox(this.stage.regl, spaceSize);
    const [x, y, z] = spaceSize;
    const directionIndicator = new DirectionIndicator({
      regl: this.stage.regl,
      centerX: x / 2,
      maxZ: z,
      shapeScale: Math.max(x, y, z),
    });

    const pointer = new Pointer(this.stage, new Raycaster());
    scene.children.push(pointer, boundary, directionIndicator);
    this.scene = scene;
    this.pointer = pointer;
    this.boundary = boundary;
    this.directionIndicator = directionIndicator;
    this.mirrorPlanes = {
      X: undefined,
      Y: undefined,
      Z: undefined,
    };

    this.models = new Models({
      regl,
      baseArgs: {
        voxels: spaceSize,
        wireFrameColor: vec3.fromValues(0.5, 0.5, 0.5),
        veState: this.veState,
      },
      pointer: this.pointer,
    });

    const { destination, selection, editing } = this.models;

    scene.children.push(destination, selection, editing);

    this.pointer.setIntersectTargets([
      this.models.destination,
      this.models.selection,
      this.boundary,
    ]);

    this.translateTool = new TranslateTool({
      stage: this.stage,
      voxelApp: this,
    });
    this.translateTool.disable();
    this.scene.add(this.translateTool);

    // 默认打开模型背景
    this.scene.add(this.modelBackground);

    this.editingController = new EditingController({
      stage: this.stage,
      models: {
        destination,
        selection,
        editing,
      },
      pointer: this.pointer,
      setTool: this.setTool,
      saveHistory: this.saveHistory,
      attachPreview: this.getAttachPreview(),
    });

    this.veController = new Controller({
      stage: this.stage,
      history: this.history,
      events: this.events,
      translateTool: this.translateTool,
      models: this.models,
      pointer: this.pointer,
      updateSpaceSize: this.updateSpaceSize,
      saveHistory: this.saveHistory,
      editingController: this.editingController,
      veState: this.veState,
    });

    this.voxelManager = new VoxelManager({
      applyVoxels: this.applyVoxels,
      models: this.models,
      controller: this.veController,
    });

    this.veController.attachEvent();
    this.registerHistoryCallback();
  }

  public saveHistory = () => {
    const { destination, selection } = this.models;
    this.history.saveVoxel({
      destVoxel: destination.voxels,
      selectVoxel: selection.voxels,
    });
  };

  private registerHistoryCallback() {
    this.history.registerVoxelCallback((data) => {
      const origin = this.models.destination.voxels.shape;
      const next = data.destVoxel.shape;

      // 如果尺寸有变化，需要移动摄像机+重置模型背景位置
      if (!vec3.equals(origin, next)) {
        // 计算摄像机偏移量
        const shift = vec3.create();
        const [nx, , nz] = next;
        const [x, , z] = origin;
        vec3.set(shift, (x - nx) / 2, 0, (z - nz) / 2);
        this.stage.translateCamera(shift);

        // 处理模型背景偏移
        this.recenterModelBackground(next);
      }

      this.applyVoxels(
        [data.destVoxel, data.selectVoxel],
        store.getState().editing.dimension,
      );

      this.translateTool.activate();
    });
  }

  public updateSpaceSize: UpdateSpaceSize = (
    spaceSize: vec3,
    clearEditing: boolean = true,
  ): boolean => {
    const currentSpaceSize = store.getState().editing.workspaceSize;
    const currentDimension = store.getState().editing.dimension;

    // 根据剪裁空间入参找出渲染维度信息
    let squashIdx = spaceSize.indexOf(0);

    // 没有轴向为0，设置为3D渲染
    if (squashIdx < 0) {
      squashIdx = VoxelDimension.XYZ;

      // 当有轴向为0的时，检查在此之前是否已经是2D渲染
      // 如果是，则以之前的渲染维度为准，其他轴数据自动调整到1
    } else if (currentDimension !== VoxelDimension.XYZ) {
      squashIdx = currentDimension;
    }

    // 找出渲染维度信息后，剪裁空间代表体素shape，每个轴向最小值都为1
    vec3.max(spaceSize, spaceSize, [
      MIN_VOXEL_SIZE,
      MIN_VOXEL_SIZE,
      MIN_VOXEL_SIZE,
    ]);

    if (vec3.equals(currentSpaceSize, spaceSize)) {
      // 体素空间与之前相等，不需要剪裁体素，只修改渲染维度
      this.history.saveAction({
        action: setDimension({
          dimension: squashIdx,
        }),
      });
      return false;
    }

    this.history.setGroup();

    const shift = vec3.create();
    const [nx, ny, nz] = spaceSize;
    const [x, , z] = currentSpaceSize;

    vec3.set(shift, (x - nx) / 2, 0, (z - nz) / 2);
    this.stage.translateCamera(shift);

    this.recenterModelBackground([nx, ny, nz]);

    // 需要修改渲染维度
    if (squashIdx !== currentDimension && squashIdx !== VoxelDimension.XYZ) {
      // 在压缩维度之前先按照 3D resize 规则剪裁其余两个维度的体素
      const beforeSquashSpace = vec3.clone(spaceSize);
      beforeSquashSpace[squashIdx] = currentSpaceSize[squashIdx];
      this.models.resize(beforeSquashSpace, clearEditing);

      // 将体素压缩至2D状态
      this.models.squashToTwoDimension(squashIdx);
    } else {
      this.models.resize(spaceSize, clearEditing);
    }

    this.resizeComponents(spaceSize);

    store.dispatch(
      setWorkspaceSize({
        workspaceSize: [nx, ny, nz],
      }),
    );

    this.saveHistory();

    this.history.saveAction({
      action: setDimension({
        dimension: squashIdx,
      }),
    });

    this.history.unsetGroup();

    return true;
  };

  /**
   * 显示/隐藏镜像平面
   * @param axis 镜像平面的法线方向
   * @param visible 是否显示镜像平面
   */
  public toggleMirrorPlane(axis: AxisType, visible: boolean) {
    const size = store.getState().editing.workspaceSize;
    let mirrorPlane = this.mirrorPlanes[axis];
    if (!mirrorPlane) {
      mirrorPlane = new MirrorPlane(this.stage.regl, size, axis);
      this.mirrorPlanes[axis] = mirrorPlane;
      this.scene.add(mirrorPlane);
    }
    mirrorPlane.visible = visible;
  }

  /**
   * 根据模型实际体素使用情况调整空间大小，裁剪没有体素的空间
   * 如果模型为空或者外切长方体未改变，则直接返回
   */
  public trimSpace() {
    const { changed, start: shift } = this.models.trim();

    if (!changed) {
      return;
    }

    const size = this.models.destination.voxels.shape;

    this.stage.translateCamera(shift);

    this.resizeComponents(size);

    const [x, y, z] = size;

    this.recenterModelBackground([x, y, z]);

    store.dispatch(
      setWorkspaceSize({
        workspaceSize: [x, y, z],
      }),
    );

    this.saveHistory();
  }

  /**
   * 更新编辑器内组件的样式。
   * @param spaceSize 模型空间大小
   */
  private resizeComponents(spaceSize: vec3) {
    this.boundary.update(spaceSize);
    const [x, y, z] = spaceSize;
    this.directionIndicator.update({
      regl: this.stage.regl,
      centerX: x / 2,
      maxZ: z,
      shapeScale: Math.max(x, y, z),
    });

    // 如果开启移动工具，需要重新计算移动工具位置
    this.translateTool.activate();

    // 如有镜像平面，需要一起更新
    AXIS.forEach((axis) => {
      this.mirrorPlanes[axis]?.update(spaceSize, axis);
    });
  }

  /**
   * 传入体素视图数组，更新destination和selection。
   * @param voxels 体素视图数组。首位用于更新destination，第二位用于更新selection。
   */
  public applyVoxels: ApplyVoxels = (
    voxels,
    dimension = VoxelDimension.XYZ,
  ) => {
    const [newDestination, newSelection] = voxels;

    if (!newDestination) {
      return;
    }

    const toResize = !vec3.equals(
      newDestination.shape,
      this.models.destination.voxels.shape,
    );

    if (toResize) {
      this.resizeComponents(newDestination.shape);

      store.dispatch(
        setWorkspaceSize({
          workspaceSize: serializeVec3(newDestination.shape),
        }),
      );

      this.models.editing.reAlloc(newDestination.shape);
    }

    if (dimension !== store.getState().editing.dimension) {
      store.dispatch(
        setDimension({
          dimension,
        }),
      );
    }

    this.models.destination.setVoxels(newDestination);

    if (newSelection) {
      this.models.selection.setVoxels(newSelection);
    } else if (toResize) {
      this.models.selection.reAlloc(newDestination.shape);
    }

    this.pointer.update();
  };

  /**
   * 销毁editor
   * - 解除内部对全局事件的监听
   * - 销毁模型数据
   */
  public destroy() {
    this.veController.releaseEvent();

    const { destination, selection, editing } = this.models;

    [destination, selection, editing].forEach((model) => {
      model.destroy();
    });
  }

  /**
   * 设置editor使用的工具（action / tool）以及模式（mode）
   * 并更新store。
   */
  public setTool: SetTool = (options) => {
    const res = this.editingController.setTool(options);

    // 禁用当前的工具。目前用于兼容尚未被迁移到editing的工具
    if (!res) {
      this.editingController.disable();
    } else {
      this.editingController.enable();
    }

    const { toolType, mode } = options;

    store.dispatch(
      setTool({
        toolType,
        mode,
      }),
    );
  };

  public getAttachPreview(): AttachPreview {
    if (!this.attachPreview) {
      this.attachPreview = new AttachPreview(this.stage.regl);

      this.scene.add(this.attachPreview);
    }

    return this.attachPreview;
  }

  /**
   * 设置体素模式下的模型背景
   * @param model 当前编辑的模型
   * @param background 背景内容
   */
  public setModelBackground(model: Object3D, background?: Object3D[]) {
    vec3.set(this.modelBackground.position, 0, 0, 0);
    quat.set(this.modelBackground.quaternion, 0, 0, 0, 1);
    vec3.copy(this.modelBackground.scale, IDENTITY_SCALE);

    background && this.modelBackground.add(...background);
    this.modelBackground.updateMatrixWorld(true);

    mat4.invert(TEMP_MAT4, model.matrixWorld);
    mat4.getTranslation(this.modelBackground.position, TEMP_MAT4);
    mat4.getRotation(this.modelBackground.quaternion, TEMP_MAT4);
    mat4.getScaling(this.modelBackground.scale, TEMP_MAT4);
  }

  /**
   * 每次修改体素编辑空间大小的时候，背景模型的相对位置发生改变
   * 需要重置当前编辑的模型中心点并且重新计算背景模型的位置
   * @param newSpace
   * @returns
   */
  private recenterModelBackground(newSpace: SerializedVec3) {
    const { editingSkinPartId } = store.getState().app;
    if (!editingSkinPartId) {
      return;
    }
    const skinPart = this.getSkinPart(editingSkinPartId);
    if (!skinPart) {
      return;
    }
    skinPart.updateSize(newSpace);
    this.setModelBackground(skinPart);
  }

  /**
   * 设置背景模型是否可见
   * @param visible 是否可见
   */
  public toggleModelBackground(visible: boolean) {
    if (visible) {
      this.scene.add(this.modelBackground);
    } else {
      this.scene.remove(this.modelBackground);
    }
  }

  public enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.veController.attachEvent();
  }

  public disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.veController.releaseEvent();
  }
}
