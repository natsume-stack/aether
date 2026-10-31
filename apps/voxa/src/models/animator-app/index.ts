import { quat, vec4 } from 'gl-matrix';

import type { Stage } from '../stage';
import { getMeshId, VoxelManager } from '../voxel-app/voxel-manager';
import type { EditingHistory } from '../editing-history';
import type { IEvents } from '../events/interface';

import {
  clearHierarchyNodes,
  setBoxesVisible,
  setGridVisible,
  setEmissive,
  AnimatorMode,
  setAnimatorMode,
  setSkeletonVisible,
  renameHierarchyNode,
  setActiveMotionId,
  removeMotionsNodes,
  ProjectNodeType,
  ToolType,
  setToolType,
  PivotMode,
  setPivotMode,
} from '../../redux/animator-slice';
import { store } from '../../redux/store';

import { Scene } from '../rendering/objects/scene';
import { Box3 } from '../rendering/math/box3';

import { Grid } from '../grid';
import {
  everyNode,
  filterNotInteractiveNode,
  getBoneIdBySkinId,
  GetDefaultBounds,
  getNodeDescendants,
  getSkinIdByBoneId,
  isBonesInteractive,
  isControllerVisible,
  isSkinPartEmissive,
  isSkinPartInteractive,
} from './util';
import type { SwitchToVoxel } from '../interfaces';
import type { RenderConfig } from '../rendering/webgl-renderer';
import { NodeManager } from './node-manager/index';
import { MotionManager } from './motion-manager';
import { DirectionIndicator } from '../direction-indicator';
import { Exporter } from './exporter';
import { Loader } from './loader';
import { ROOT_BONE_ID, ROOT_SKIN_ID } from '../../defs';
import type { VoxaProfiler } from '../profiler';
import { HitBoxManager } from './hit-box-manager';
import { MeshesIdDict } from '../project/interfaces';
import { isEmptyBounds } from '../voxel-model/util';
import { voxelShapeToObjSize } from '../../utils/math';
import { ModelPivotManager } from './model-pivot-manager';
import type { SkinNode } from './node-manager/interface';

export interface AnimatorAppOptions {
  history: EditingHistory;
  stage: Stage;
  voxelManager: VoxelManager;
  switchToVoxel: SwitchToVoxel;
  events: IEvents;
  profiler: VoxaProfiler;
}

const TEMP_BOX = new Box3();

export class AnimatorApp {
  public readonly scene: Scene;

  public readonly nodeManager: NodeManager;

  public readonly motionManager: MotionManager;

  public readonly exporter: Exporter;

  public readonly loader: Loader;

  public readonly hitBoxManager: HitBoxManager;

  public readonly modelPivotManager: ModelPivotManager;

  private readonly voxelManager: VoxelManager;

  private grid: Grid;
  private enabled = false;

  private history: EditingHistory;
  private stage: Stage;
  private switchToVoxel: SwitchToVoxel;
  private events: IEvents;

  /**
   * 没有存在感的正方向指示箭头
   */
  private directionIndicator: DirectionIndicator;

  constructor(opt: AnimatorAppOptions) {
    this.stage = opt.stage;
    this.history = opt.history;
    this.switchToVoxel = opt.switchToVoxel;
    this.events = opt.events;

    this.voxelManager = opt.voxelManager;

    // 注册撤销重做时的副作用
    this.history.registerActionCallback('setAnimatorMode', () => {
      this.toMode(store.getState().animator.mode);
    });
    this.history.registerActionCallback('setPivotMode', () => {
      const { pivotMode } = store.getState().animator;

      this.switchPivotMode(pivotMode);
    });

    // 初始化多部件场景
    const scene = new Scene();
    scene.setBackgroundColor(vec4.fromValues(0, 0, 0, 1));

    this.scene = scene;

    this.modelPivotManager = new ModelPivotManager({
      stage: this.stage,
      scene: this.scene,
      history: this.history,
      getDefaultBounds: this.getDefaultBounds,
    });

    this.nodeManager = new NodeManager(
      opt.voxelManager,
      this.history,
      this.stage,
      this.scene,
    );

    this.grid = new Grid(this.stage.regl);
    // 默认为xy平面，旋转为xz平面
    quat.rotateX(this.grid.quaternion, this.grid.quaternion, Math.PI / 2);
    this.scene.add(this.grid);

    this.directionIndicator = new DirectionIndicator({
      regl: this.stage.regl,
      centerX: 0,
      maxZ: 160,
      shapeScale: 80,
    });
    this.scene.add(this.directionIndicator);

    this.motionManager = new MotionManager({
      history: this.history,
      events: this.events,
      nodeManager: this.nodeManager,
      profiler: opt.profiler,
    });

    this.exporter = new Exporter(this.nodeManager);
    this.loader = new Loader(
      this.nodeManager,
      this.history,
      this.scene,
      this.getDefaultBounds,
    );

    this.hitBoxManager = new HitBoxManager(
      this.history,
      this.stage,
      this.scene,
      this.setToolType,
      this.getDefaultBounds,
    );

    this.nodeManager.addListener('dragEnd', () => {
      this.motionManager.addKeyframe(store.getState().animator.activeIds);
    });
    this.nodeManager.addListener('dbClick', (id) => {
      this.switchToVoxel(id);
    });
    this.nodeManager.addListener('select', ({ ids, saveRecord }) => {
      if (store.getState().animator.mode === AnimatorMode.Motion) {
        this.motionManager.updateActiveKeyframes(saveRecord);
      }
    });
    this.nodeManager.addListener('remove', ({ nodes, saveRecord }) => {
      const ids: string[] = [];

      nodes.forEach(({ node, children }) => {
        ids.push(node.id, ...Object.keys(children));
      });

      this.history.saveAction({
        action: removeMotionsNodes(ids),
        saveRecord,
      });
    });

    this.enable();
  }

  /**
   * 启用APP，并启动相关组件
   */
  public enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.nodeManager.transform.enable();
    this.activate();
  }

  /**
   * 禁用APP，并禁用相关组件
   */
  public disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.nodeManager.transform.disable();
    this.deactivate();
  }

  private activate() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.events
      .addListener('abort', this.abort)
      .addListener('delete', this.onDelete)
      .addListener('selectAll', this.onSelectAll)
      .addListener('deSelect', this.onDeSelect);
  }

  private deactivate() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);

    this.events
      .removeListener('abort', this.abort)
      .removeListener('delete', this.onDelete)
      .removeListener('selectAll', this.onSelectAll)
      .removeListener('deSelect', this.onDeSelect);
  }

  private abort = () => {
    this.nodeManager.transform.abort();
    this.hitBoxManager.abort();
    this.modelPivotManager.abort();
  };

  private onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Shift') {
      this.nodeManager.transform.setPivotHelperVisible(true);
      this.modelPivotManager.setPivotHelperVisible(true);
    }
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key === 'Shift') {
      this.nodeManager.transform.setPivotHelperVisible(false);
      this.modelPivotManager.setPivotHelperVisible(false);
    }
  };

  private onDelete = () => {
    const { activeIds, mode } = store.getState().animator;

    // 只在setup模式响应删除
    if (mode === AnimatorMode.Setup && activeIds.length > 0) {
      this.nodeManager.removeNodes(activeIds);
    }
  };

  private onSelectAll = () => {
    const { hierarchyData } = store.getState().animator;
    const skinPartInteractive = isSkinPartInteractive();
    let ids: string[] = [];

    if (skinPartInteractive) {
      const skinIds = hierarchyData[ROOT_SKIN_ID].childrenIds;
      if (skinIds) {
        ids = ids.concat(skinIds);
      }
    }

    if (isBonesInteractive()) {
      ids = ids.concat(getNodeDescendants(ROOT_BONE_ID));
    } else if (skinPartInteractive) {
      // 如果是骨骼不可交互的模式，需要过滤掉骨骼节点，但是要选中蒙皮
      everyNode(ROOT_BONE_ID, hierarchyData, (node) => {
        if (node.type === ProjectNodeType.Bone && node.skinId) {
          ids.push(node.skinId);
        }

        return true;
      });
    }

    this.nodeManager.setActiveIds(ids);
  };

  private onDeSelect = () => {
    const { activeIds } = store.getState().animator;

    if (activeIds.length > 0) {
      this.nodeManager.setActiveIds([]);
    }
  };

  public resetCamera() {
    // 如果当前页面没有部件
    // 使用默认摄像机视角
    const skinNodes = this.nodeManager.getAllSkinNodes();
    if (!skinNodes.length) {
      this.stage.resetCamera();
      return;
    }

    TEMP_BOX.makeEmpty();
    skinNodes.forEach((skinNode) => {
      TEMP_BOX.expandByObject(skinNode);
    });
    this.stage.resetCamera({ max: TEMP_BOX.max, min: TEMP_BOX.min });
  }

  /**
   * 是否显示骨骼
   * @param show 是否显示
   */
  public toggleSkeleton(show: boolean) {
    store.dispatch(setSkeletonVisible(show));
  }

  /**
   * 是否显示部件框
   */
  public toggleBoxes(show: boolean) {
    store.dispatch(setBoxesVisible(show));
  }

  /**
   * 是否显示地面网格
   */
  public toggleGrid(show: boolean) {
    this.grid.visible = show;
    store.dispatch(setGridVisible(show));
  }

  public toggleEmissive(emissive: boolean) {
    store.dispatch(setEmissive(emissive));
  }

  public setToolType = (toolType: ToolType) => {
    this.hitBoxManager.switchTransformType(toolType);
    this.nodeManager.transform.switchTransformType(toolType);

    store.dispatch(setToolType(toolType));

    const { mode, activeIds } = store.getState().animator;
    this.nodeManager.transform.setTransformControlsVisible(
      isControllerVisible(mode, activeIds),
    );
  };

  /**
   * 删除当前除根节点外的所有节点
   */
  public destroyNodes() {
    this.nodeManager.setActiveIds([], false);

    this.nodeManager.clear();

    store.dispatch(clearHierarchyNodes());
  }

  public getRenderConfig(): RenderConfig {
    const emissive = isSkinPartEmissive();
    return {
      postProcess: emissive,
      bloomEnabled: emissive,
      /**
       * 编辑工具中使用ao-mesher，不需要ssao
       */
      ssaoEnabled: false,
    };
  }

  /**
   * 设置animator的编辑模式
   * 如果要设置动画编辑模式，需要具有相关权限。
   */
  public setMode(mode: AnimatorMode) {
    const { animator, permission } = store.getState();

    /**
     * 与当前模式相同时，不重复执行
     * 进入动画编辑模式需要权限
     */
    if (
      animator.mode === mode ||
      (mode === AnimatorMode.Motion && !permission.editAnimations)
    ) {
      return;
    }

    const { activeIds, activeMotionId, motionData, pivotMode } = animator;

    this.history.setGroup();

    if (!activeMotionId && motionData.motionIds[0]) {
      this.history.saveAction({
        action: setActiveMotionId(motionData.motionIds[0]),
      });
    }

    // 如果切换模式前处于中心点模式，先关闭中心点模式
    if (pivotMode !== PivotMode.None) {
      this.setPivotMode(PivotMode.None);
    }

    this.toMode(mode);

    this.history.saveAction({ action: setAnimatorMode(mode) });

    // 动画编辑模式下，禁用部件交互
    // filterNotInteractiveNode 过滤掉不可交互的节点
    this.nodeManager.setActiveIds(filterNotInteractiveNode(activeIds));

    this.history.unsetGroup();
  }

  public toMode(mode: AnimatorMode) {
    const { animator } = store.getState();

    const { activeIds } = animator;

    this.events.emit('abort');

    this.nodeManager.clearTempGroup(activeIds);

    switch (mode) {
      case AnimatorMode.Motion:
        this.hitBoxManager.checkOut();
        this.motionManager.checkIn();
        break;
      case AnimatorMode.Setup:
        this.hitBoxManager.checkOut();
        this.motionManager.checkOut();
        break;
      case AnimatorMode.HitBox:
        this.motionManager.checkOut();
        this.hitBoxManager.checkIn();
        break;
    }

    this.nodeManager.makeTempGroup(activeIds);

    this.nodeManager.transform.updateParamPanelData();

    const controllerVisible = isControllerVisible(mode, activeIds);
    this.nodeManager.transform.setTransformControlsVisible(controllerVisible);
  }

  public renameNode(id: string, newName: string) {
    this.history.saveAction({
      action: renameHierarchyNode({ id, newName }),
    });
  }

  /**
   * 根据当前模型整体数据，计算框
   */
  public getDefaultBounds: GetDefaultBounds = (skinNodes?: SkinNode[]) => {
    const meshesIdDict: MeshesIdDict = {};
    let meshCount = 0;

    this.voxelManager.clearUnusedFlippedMesh();

    Array.from(this.voxelManager.map.keys()).forEach((voxelId) => {
      const voxelRes = this.voxelManager.map.get(voxelId);
      if (!voxelRes) {
        return;
      }

      Object.values(voxelRes.meshes).forEach(
        ({ bounds, boundaryStart, flip }) => {
          if (isEmptyBounds(bounds)) {
            // 此时为空体素，不计算mesh数据
            return;
          }
          const newBounds = voxelShapeToObjSize(bounds, voxelRes.dimension);

          meshesIdDict[getMeshId(voxelRes.id, flip)] = {
            index: meshCount,
            newBounds,
            boundaryStart: boundaryStart,
          };

          meshCount++;
        },
      );
    });

    return this.exporter.getModelBounds(meshesIdDict, skinNodes);
  };

  /**
   * 根据中心点模式，修改各个控件的状态
   */
  private switchPivotMode(pivotMode: PivotMode) {
    if (pivotMode === PivotMode.Model) {
      this.nodeManager.transform.disable();
      this.nodeManager.transform.setTransformControlsVisible(false);

      this.modelPivotManager.enable();

      return;
    }

    this.modelPivotManager.disable();

    this.nodeManager.transform.enable();
    this.nodeManager.transform.switchSkinPivotMode(
      pivotMode === PivotMode.SkinNode,
    );
  }

  /**
   * 进入中心点模式（模型中心点 / 部件中心点）/ 退出中心点模式
   */
  public setPivotMode(pivotMode: PivotMode, saveRecord = true) {
    this.switchPivotMode(pivotMode);
    this.history.setGroup();
    this.history.saveAction({
      action: setPivotMode(pivotMode),
      saveRecord: saveRecord,
    });

    if (pivotMode !== PivotMode.Model) {
      const { activeIds } = store.getState().animator;
      // 进入中心点模式时，单选骨骼则选中其绑定的蒙皮
      // 退出中心点模式时，单选已绑骨骼的蒙皮则选中骨骼
      // 但定向创作模式下不可选中骨骼，需要重新选中一遍直绑的皮肤，触发隐藏操作轴等业务逻辑
      const newActiveId = pivotMode
        ? getSkinIdByBoneId(activeIds[0])
        : isBonesInteractive()
        ? getBoneIdBySkinId(activeIds[0])
        : activeIds[0];

      newActiveId && this.nodeManager.setActiveIds([newActiveId], saveRecord);
    }

    this.history.unsetGroup();
  }
}
