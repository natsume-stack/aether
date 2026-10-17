import { mat3, mat4, quat, vec3 } from 'gl-matrix';

import type { Stage } from '../../stage';
import type { SkinManager } from './skin-manager';
import type { BoneManager } from './bone-manager';
import type { EditingHistory } from '../../editing-history';
import type { Scene } from '../../rendering/objects/scene';
import type { Group } from '../../rendering/objects/group';
import type { EventMap, SkinNode } from './interface';

import {
  TransformControls,
  TransformDragEvent,
  TransformDragEndEvent,
} from '../../rendering/controls/transform';
import { SkinPivotHelper } from './pivot-helper';
import {
  ProjectNodeType,
  AnimatorMode,
  ParamPanelData,
  setHoveredId,
  setHoveredObjectId,
  setHoveredSkinPartIds,
  updateHierarchyNodesAlpha,
  updateParamPanelData,
  ToolAxis,
  ToolType,
  setToolAxis,
  IDENTITY_PARAM_PANEL,
  PivotMode,
} from '../../../redux/animator-slice';
import { RootState, store } from '../../../redux/store';
import { DragControls } from '../../rendering/controls/drag';
import {
  getRootParentId,
  getBreadcrumbs,
  parseActiveIds,
  isSkinPart,
  isBoneNode,
  getActiveBoneIds,
  getBoneIdBySkinId,
  getSkinIdByBoneId,
  isBonesInteractive,
  isControllerVisible,
  isSkinPartInteractive,
} from '../util';
import { PointerAction } from '../../../redux/app-slice';
import {
  IDENTITY_SCALE,
  MIN_SCALE_VEC,
  TransformType,
} from '../../rendering/controls/transform/def';
import { getEuler } from '../../rendering/math/quat';
import { radToDegree, serializeMat3, serializeVec3 } from '../../../utils/math';
import { isMobile } from '../../../utils/devices';
import { Axis } from '../../rendering/def';
import { FIXED_TORUS_RADIUS } from '../../rendering/controls/transform/scale';
import { BoneNode } from '../../bone';

const TEMP_VEC3 = vec3.create();
const TEMP_SCALE = vec3.create();
const TEMP_QUAT = quat.create();
const TEMP_MAT4 = mat4.create();
const TEMP_MAT3 = mat3.create();
const TEMP_MAT3_2 = mat3.create();

const INVERSE_FIXED_SCALE = vec3.create();
vec3.inverse(INVERSE_FIXED_SCALE, [
  FIXED_TORUS_RADIUS,
  FIXED_TORUS_RADIUS,
  FIXED_TORUS_RADIUS,
]);

type InitParams = {
  stage: Stage;
  history: EditingHistory;
  scene: Scene;
  skinNodeManager: SkinManager;
  boneNodeManager: BoneManager;
  tempGroup: Group;
  setActiveIds: (ids: string[]) => void;
  expandParents: (ids: string) => void;
  emit: <K extends keyof EventMap>(type: K, data: EventMap[K]) => boolean;
};

export class TransformManager {
  private oldState: RootState | undefined;

  private dragControls: DragControls;

  private stage: Stage;

  private canvas: HTMLCanvasElement;

  private history: EditingHistory;

  private scene: Scene;

  private skinNodeManager: SkinManager;

  private boneNodeManager: BoneManager;

  private tempGroup: Group;

  private pivotHelper: SkinPivotHelper;

  private transformControls: TransformControls;

  private setActiveIds: (ids: string[], saveRecord?: boolean) => void;

  private showPivotHelper: boolean = false;

  private enabled = false;

  private expandParents: (id: string) => void;

  /**
   * 缩放开始的数值
   * 以dragStart时的scale为标准进行增量缩放
   */
  private startScale = vec3.fromValues(1, 1, 1);

  private getCurrentNode(position: { clientX: number; clientY: number }) {
    const selected = this.dragControls.hitTest(position);

    if (!selected || (!isSkinPart(selected) && !isBoneNode(selected))) {
      return {};
    }

    const { activeIds, hierarchyData } = store.getState().animator;

    const node = hierarchyData[selected.uuid];
    if (!node) {
      return {};
    }

    if (!isSkinPartInteractive()) {
      return {
        id: node.id,
        objectId: node.id,
        skinPartIds: [],
      };
    }

    if (node.type === ProjectNodeType.Bone) {
      return {
        id: node.id,
        objectId: node.id,
        skinPartIds: node.skinId
          ? parseActiveIds([node.skinId]).activeSkinPartIds
          : [],
      };
    }

    if (activeIds.length > 1) {
      return {
        id: node.id,
        objectId: node.id,
        skinPartIds: [node.id],
      };
    }

    // 单选时
    // 选中向上溯源至与当前选中部件/部件组的同个父节点
    let parentId = getRootParentId(
      node.id,
      activeIds.length ? getBreadcrumbs(activeIds[0]) : undefined,
    );
    if (!parentId) {
      return {};
    }
    // 骨骼可交互的状态下
    // 当前没有选中或者当前选中的部件不是查找到的父节点
    // 需要查找并hover部件/部件组绑定的骨骼
    if (
      isBonesInteractive() &&
      (!activeIds.length || activeIds[0] !== parentId)
    ) {
      parentId = getBoneIdBySkinId(parentId) || parentId;
    }

    const { activeSkinPartIds: hoveredSkinPartIds } = parseActiveIds([
      parentId,
    ]);

    return {
      id: parentId,
      objectId: node.id,
      skinPartIds: hoveredSkinPartIds,
    };
  }

  private emit: <K extends keyof EventMap>(
    type: K,
    data: EventMap[K],
  ) => boolean;

  /**
   * 判断是否正在进行transform
   */
  public isSelected() {
    const selected = this.transformControls.getSelected();
    if (!selected) {
      return false;
    }
    return !!this.transformControls.currentTransformTool.getAxisToolByInteractiveObj(
      selected,
    );
  }

  constructor({
    stage,
    history,
    scene,
    skinNodeManager,
    boneNodeManager,
    tempGroup,
    setActiveIds,
    expandParents,
    emit,
  }: InitParams) {
    this.stage = stage;
    this.canvas = stage.renderer.domElement;
    this.history = history;
    this.scene = scene;
    this.skinNodeManager = skinNodeManager;
    this.boneNodeManager = boneNodeManager;
    this.tempGroup = tempGroup;
    this.setActiveIds = setActiveIds;
    this.expandParents = expandParents;
    this.emit = emit;

    this.transformControls = new TransformControls({
      regl: this.stage.regl,
      camera: this.stage.getCamera,
      domElement: this.stage.renderer.domElement,
      onDragStart: (ev) => {
        this.history.setGroup();

        // 记录拖拽开始时的state
        this.oldState = store.getState();
        this.stage.setPointerAction(PointerAction.Dragging);
        this.emit('dragStart', ev);

        if (ev.type === TransformType.Scale) {
          vec3.copy(this.startScale, this.tempGroup.scale);
        }
      },
      onDrag: this.onDragTransformControls,
      onDragEnd: (ev) => {
        const { paramPanelData } = store.getState().animator;

        let partialParamPanelData: Partial<ParamPanelData>;

        // 只更新必要的paramPanelData，这样“撤销重做”时，只处理真正变化的数据
        switch (ev.type) {
          case TransformType.Pivot:
            this.translatePivot(ev);
            partialParamPanelData = {
              pivot: serializeVec3(paramPanelData.pivot),
              position: serializeVec3(paramPanelData.position),
              worldPosition: serializeVec3(paramPanelData.worldPosition),
            };
            break;
          case TransformType.Translate:
            partialParamPanelData = {
              position: serializeVec3(paramPanelData.position),
              worldPosition: serializeVec3(paramPanelData.worldPosition),
            };
            break;
          case TransformType.Rotate:
            partialParamPanelData = {
              rotation: serializeVec3(paramPanelData.rotation),
              worldRotation: serializeVec3(paramPanelData.worldRotation),
            };
            break;
          case TransformType.Scale:
            partialParamPanelData = {
              scale: serializeVec3(paramPanelData.scale),
            };
            break;
        }

        this.emit('dragEnd', ev);
        this.stage.setPointerAction(PointerAction.Idle);

        if (partialParamPanelData) {
          // 拖拽结束后发送当前参数面板数据，与开始拖拽时记录的state比对
          this.history.saveAction({
            action: updateParamPanelData({
              data: partialParamPanelData,
            }),
            oldState: this.oldState,
          });
        }

        this.oldState = undefined;

        this.history.unsetGroup();
      },
      onAbort: () => {
        if (this.oldState) {
          this.updateByParamPanelData(this.oldState.animator.paramPanelData);

          this.oldState = undefined;
        }

        this.stage.setPointerAction(PointerAction.Idle);

        this.history.unsetGroup();
      },
    });

    this.pivotHelper = new SkinPivotHelper(
      this.stage.getCamera,
      this.stage.renderer,
      this.skinNodeManager.skin,
      this.skinNodeManager.map,
    );

    this.dragControls = new DragControls(
      () => {
        const skinNodes = Array.from(this.skinNodeManager.map.values());
        const boneNodes = Array.from(this.boneNodeManager.map.values());
        let nodes: (BoneNode | SkinNode)[] = [];
        if (isSkinPartInteractive()) {
          nodes.push(...skinNodes);
        }
        if (isBonesInteractive()) {
          nodes.push(...boneNodes);
        }
        return nodes;
      },
      this.stage.getCamera,
      this.stage.renderer.domElement,
    );
    this.dragControls.draggable = false;
    this.dragControls.recursive = false;

    this.dragControls.addListener('select', (ev) => {
      // PC只有鼠标左键响应选中
      // 移动端select事件也是ev.button === 1
      if (ev.event.button !== 0 || this.transformControls.getHovered()) {
        return;
      }

      const { id } = this.getCurrentNode(ev.event);
      if (!id) {
        this.setActiveIds([]);
        return;
      }

      this.setActiveIds([id]);

      this.expandParents(id);
    });

    this.dragControls.addListener('hoveron', (ev) => {
      const { id, objectId, skinPartIds } = this.getCurrentNode(ev.event);
      if (id) {
        store.dispatch(setHoveredId(id));
      }
      if (objectId) {
        store.dispatch(setHoveredObjectId(objectId));
      }
      if (skinPartIds) {
        store.dispatch(setHoveredSkinPartIds(skinPartIds));
      }
    });

    this.dragControls.addListener('hoveroff', (ev) => {
      if (!isSkinPart(ev.object) && !isBoneNode(ev.object)) {
        return;
      }
      store.dispatch(setHoveredId(undefined));
      store.dispatch(setHoveredObjectId(undefined));
      store.dispatch(setHoveredSkinPartIds([]));
    });

    this.history.registerActionCallback('updateParamPanelData', (value) => {
      const { paramPanelData } = store.getState().animator;

      // 对比value和state中的数据，从value中判断“有变化的属性”，从state中取“变化的值”
      const diff: Partial<ParamPanelData> = {};

      Object.keys(value.data).forEach((key) => {
        diff[key] = paramPanelData[key];
      });

      this.updateByParamPanelData(diff);
    });

    this.history.registerActionCallback(
      'updateHierarchyNodesAlpha',
      (payload) => {
        const { ids } = payload;
        const { hierarchyData } = store.getState().animator;

        ids.forEach((id) => {
          const node = hierarchyData[id];

          if (
            node.type !== ProjectNodeType.Bone &&
            node.type !== ProjectNodeType.SkinPart
          ) {
            return;
          }

          const unit =
            this.skinNodeManager.map.get(id) ||
            this.boneNodeManager.map.get(id);

          if (!unit || (!isSkinPart(unit) && !isBoneNode(unit))) {
            return;
          }

          unit.alpha = node.alpha;
        });
      },
    );
  }

  public setToolAxis(toolAxis: ToolAxis) {
    this.updateTransformControlsPos(toolAxis);
    store.dispatch(setToolAxis(toolAxis));
    const { mode, activeIds } = store.getState().animator;
    this.setTransformControlsVisible(isControllerVisible(mode, activeIds));
  }

  /**
   * 切换 部件中心点模式 / 节点旋转位移缩放模式
   */
  public switchSkinPivotMode(pivotMode: boolean) {
    const { activeIds, activeSkinPartIds, toolType, toolAxis } =
      store.getState().animator;
    if (activeIds.length > 1) {
      return;
    }
    if (pivotMode) {
      this.transformControls.switchTransformType(TransformType.Pivot);
      this.updateTransformControlsPos('world');
      // 进入中心点模式时
      // 如果当前有选中的组件，显示操作轴
      this.setTransformControlsVisible(!!activeIds[0]);
      if (this.showPivotHelper) {
        this.pivotHelper.attach(activeSkinPartIds);
        this.pivotHelper.intersectPoint(this.transformControls.position);
      }
    } else {
      this.pivotHelper.detach();
      this.switchTransformType(toolType);
      this.updateTransformControlsPos(toolAxis);
      const invisible =
        !activeIds.length ||
        (toolAxis === 'world' && toolType === ToolType.Scale);
      this.setTransformControlsVisible(!invisible);
    }
  }

  public switchTransformType(toolType: ToolType) {
    let transformType: TransformType;

    switch (toolType) {
      case ToolType.Translate:
        transformType = TransformType.Translate;
        break;
      case ToolType.Rotate:
        transformType = TransformType.Rotate;
        break;
      case ToolType.Scale:
        transformType = TransformType.Scale;
        break;
    }

    this.transformControls.switchTransformType(transformType);
  }

  public setTransformControlsVisible(visible: boolean) {
    this.transformControls.enabled = visible && this.enabled;
    this.transformControls.visible = visible && this.enabled;
  }

  public updatePivotHelper() {
    this.pivotHelper.detach();

    const { pivotMode, activeSkinPartIds } = store.getState().animator;
    if (
      pivotMode === PivotMode.SkinNode &&
      this.showPivotHelper &&
      activeSkinPartIds.length
    ) {
      this.pivotHelper.attach(activeSkinPartIds);
      this.pivotHelper.intersectPoint(this.transformControls.position);
    }
  }

  public setPivotHelperVisible(visible: boolean) {
    this.showPivotHelper = visible;
    this.updatePivotHelper();
  }

  /**
   * 通过参数面板更新选中部件的坐标
   * @param type 坐标类型为部件的世界坐标/与部件父级的相对坐标
   * @param pos 新的坐标
   * @param saveRecord 是否计入撤销重做，默认计入
   */
  public updateSkinPartsPosition(
    type: ToolAxis,
    pos: vec3,
    saveRecord: boolean = true,
  ) {
    type === 'local'
      ? this.tempGroup.setPosition(pos)
      : this.tempGroup.setPositionByWorldPosition(pos);

    this.tempGroup.updateMatrixWorld();
    const toolAxis = store.getState().animator.toolAxis;
    this.updateTransformControlsPos(toolAxis);
    this.updateParamPanelPosition(saveRecord);
  }

  /**
   * 通过参数面板更新选中部件的旋转角度
   */
  public updateSkinPartsRotation(
    type: ToolAxis,
    rotation: vec3,
    saveRecord: boolean = true,
  ) {
    if (type === 'local') {
      this.tempGroup.setQuaternion(rotation[0], rotation[1], rotation[2]);
      vec3.copy(this.tempGroup.rotateAngles, rotation);
    } else {
      quat.fromEuler(TEMP_QUAT, rotation[0], rotation[1], rotation[2]);
      this.tempGroup.setQuaternionByWorldQuaternion(TEMP_QUAT);
      getEuler(this.tempGroup.rotateAngles, this.tempGroup.quaternion);
    }

    this.tempGroup.updateMatrixWorld();
    const toolAxis = store.getState().animator.toolAxis;
    this.updateTransformControlsPos(toolAxis);
    this.updateParamPanelRotation(saveRecord);
  }

  /**
   * 更新缩放节点
   */
  public updateNodesScale(
    scale: vec3,
    saveRecord = true,
    oldState?: RootState,
  ) {
    vec3.max(this.tempGroup.scale, scale, MIN_SCALE_VEC);

    this.tempGroup.updateMatrixWorld();

    this.updateParamPanelScale(saveRecord, oldState);
  }

  /**
   * 通过参数面板更新部件或骨骼的透明度
   */
  public updateNodesAlpha(
    /**
     * alpha数值或数组，如果是数组，需要和ids相同长度
     */
    alpha: number | number[],
    ids: string[],
    saveRecord: boolean = true,
    oldState?: RootState,
  ) {
    const res = this.updateNodesAlphas({ alpha, ids });

    if (!res) {
      return;
    }

    this.history.setGroup();

    this.history.saveAction({
      action: updateHierarchyNodesAlpha({
        ids,
        alphas: res.alphas,
      }),
      oldState: oldState || this.oldState,
      saveRecord: saveRecord,
    });

    this.updateParamPanelOpacity(saveRecord);

    if (saveRecord) {
      this.oldState = undefined;
    }

    this.history.unsetGroup();
  }

  private updateNodesAlphas(params: {
    alpha: number | number[];
    ids: string[];
  }) {
    const { alpha, ids } = params;

    let getAlpha = (idx: number) => 1;

    if (Array.isArray(alpha)) {
      if (alpha.length !== ids.length) {
        console.error('Alpha length does not match ids length');
        return;
      }

      getAlpha = (idx) => alpha[idx];
    } else {
      getAlpha = () => alpha;
    }

    const alphas: number[] = [];

    ids.forEach((id, idx) => {
      const node =
        this.skinNodeManager.map.get(id) || this.boneNodeManager.map.get(id);
      if (!node || (!isSkinPart(node) && !isBoneNode(node))) {
        return;
      }

      const newAlpha = getAlpha(idx);
      node.alpha = newAlpha;
      alphas.push(newAlpha);
    });

    return { alphas };
  }

  public updateTransformControlsPos(toolAxis: ToolAxis) {
    if (toolAxis === 'local') {
      this.tempGroup.add(this.transformControls);
      vec3.negate(this.transformControls.position, this.tempGroup.pivot);
    } else {
      this.scene.add(this.transformControls);
      vec3.set(this.transformControls.pivot, 0, 0, 0);

      // 世界轴需读取组的世界坐标位置
      this.transformControls.setPosition(this.tempGroup.getWorldPivot());
    }
  }

  /**
   * 当前选中部件变化时，更新参数面板数据
   * 仅作为副作用，不计入撤销重做
   */
  public updateParamPanelData() {
    const { activeIds } = store.getState().animator;
    if (!activeIds.length) {
      store.dispatch(
        updateParamPanelData({
          data: IDENTITY_PARAM_PANEL,
        }),
      );
      return;
    }

    this.updateParamPanelPosition(false);
    this.updateParamPanelOpacity(false);
    this.updateParamPanelRotation(false);
    this.updateParamPanelScale(false);
    store.dispatch(
      updateParamPanelData({
        data: {
          pivot: serializeVec3(this.tempGroup.pivot),
          parentScaleMat3: serializeMat3(this.tempGroup.parentScaleMat3),
        },
      }),
    );
  }

  private updateParamPanelPosition(saveRecord: boolean = true) {
    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          position: serializeVec3(this.tempGroup.position),
          worldPosition: serializeVec3(this.tempGroup.getWorldPivot()),
        },
      }),
      saveRecord: saveRecord,
    });
  }

  private updateParamPanelRotation(saveRecord: boolean = true) {
    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          rotation: serializeVec3(this.tempGroup.rotateAngles),
          worldRotation: serializeVec3(this.tempGroup.worldRotateAngles),
        },
      }),
      saveRecord: saveRecord,
    });
  }

  /**
   * 获得当前选中部件/骨骼的透明度，透明度冲突时返回undefined
   */
  private getTempGroupAlpha() {
    let groupAlpha: number | undefined = undefined;
    const { activeIds, activeSkinPartIds } = store.getState().animator;

    const ids = [...getActiveBoneIds(activeIds), ...activeSkinPartIds];

    for (const id of ids) {
      const node =
        this.skinNodeManager.map.get(id) || this.boneNodeManager.map.get(id);
      if (!node || (!isSkinPart(node) && !isBoneNode(node))) {
        return;
      }

      if (groupAlpha !== undefined && groupAlpha !== node.alpha) {
        return;
      }

      groupAlpha = node.alpha;
    }
    return groupAlpha;
  }

  private updateParamPanelOpacity(saveRecord: boolean = true) {
    const groupAlpha = this.getTempGroupAlpha();
    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          opacity: groupAlpha,
        },
      }),
      saveRecord: saveRecord,
    });
  }

  private updateParamPanelScale(
    saveRecord: boolean = true,
    oldState?: RootState,
  ) {
    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          scale: serializeVec3(this.tempGroup.scale),
        },
      }),
      saveRecord,
      oldState,
    });
  }

  /**
   * 通过旋转工具旋转部件时，更新部件的旋转角度。该旋转角度只用来显示在参数面板。
   * @param toolAxis 本地坐标系/世界坐标系
   * @param axis 本次操作的轴向
   * @param diff 本次操作的角度变化量
   */
  private updateRotateAngles(toolAxis: ToolAxis, axis: number, diff: number) {
    // 当前操作部件轴时，使用updateAngle根据本次旋转的角度变化量更新
    // 当前操作世界轴时，通过四元数转部件轴欧拉角
    // 根据本次操作，更新tempGroup
    if (toolAxis === 'local') {
      let newAngle = this.tempGroup.rotateAngles[axis] + radToDegree(diff);
      if (newAngle > 180) {
        newAngle = newAngle - 360;
      } else if (newAngle <= -180) {
        newAngle = newAngle + 360;
      }
      this.tempGroup.rotateAngles[axis] = newAngle;
    } else {
      getEuler(this.tempGroup.rotateAngles, this.tempGroup.quaternion);
    }
  }

  /**
   * 根据传入的参数面板数据，更新部件属性
   */
  private updateByParamPanelData = (
    paramPanelData: Partial<ParamPanelData>,
  ) => {
    if (paramPanelData.pivot) {
      vec3.copy(this.tempGroup.pivot, paramPanelData.pivot);

      this.tempGroup.updateMatrixWorld();

      this.history.saveAction({
        action: updateParamPanelData({
          data: {
            pivot: serializeVec3(this.tempGroup.pivot),
          },
        }),
        saveRecord: false,
      });
    }
    if (paramPanelData.position) {
      this.updateSkinPartsPosition('local', paramPanelData.position, false);
    }
    if (paramPanelData.rotation) {
      this.updateSkinPartsRotation('local', paramPanelData.rotation, false);
    }
    if (paramPanelData.scale) {
      this.updateNodesScale(paramPanelData.scale, false);
    }
    if (paramPanelData.parentScaleMat3) {
      mat3.copy(this.tempGroup.parentScaleMat3, paramPanelData.parentScaleMat3);
      this.tempGroup.updateMatrixWorld();
    }

    const { toolAxis, pivotMode } = store.getState().animator;

    const newToolAxis = pivotMode === PivotMode.None ? toolAxis : 'world';

    if (newToolAxis !== toolAxis) {
      this.updateTransformControlsPos(newToolAxis);
    }
  };

  private onDragTransformControls = (ev: TransformDragEvent) => {
    switch (ev.type) {
      case TransformType.Translate:
        this.translateSkinParts(ev);
        break;
      case TransformType.Rotate:
        this.rotateSkinParts(ev);
        break;
      case TransformType.Pivot:
        this.translatePivot(ev);
        break;
      case TransformType.Scale:
        this.scaleSkinParts(ev);
        break;
    }
  };

  private translateSkinParts(ev: TransformDragEvent) {
    const pos = vec3.create();
    pos[ev.axis] = ev.currDiff;
    if (store.getState().animator.toolAxis === 'local') {
      mat3.fromMat4(TEMP_MAT3, this.tempGroup.matrix);
    } else {
      this.tempGroup.getRTSMatrix(TEMP_MAT4);
      mat3.fromMat4(TEMP_MAT3, TEMP_MAT4);
      mat3.invert(TEMP_MAT3, TEMP_MAT3);
      mat3.fromMat4(TEMP_MAT3_2, this.tempGroup.matrixWorld);
      mat3.mul(TEMP_MAT3, TEMP_MAT3_2, TEMP_MAT3);
      mat3.invert(TEMP_MAT3, TEMP_MAT3);

      this.transformControls.position[ev.axis] += ev.currDiff;
    }

    vec3.transformMat3(pos, pos, TEMP_MAT3);
    vec3.add(this.tempGroup.position, this.tempGroup.position, pos);
    this.tempGroup.updateMatrixWorld();
    this.updateParamPanelPosition(false);
  }

  private rotateSkinParts(ev: TransformDragEvent) {
    const rotateFunc = ['rotateX', 'rotateY', 'rotateZ'];
    const { toolAxis } = store.getState().animator;
    if (toolAxis === 'local') {
      quat[rotateFunc[ev.axis]](
        this.tempGroup.quaternion,
        this.tempGroup.quaternion,
        ev.currDiff,
      );
    } else {
      quat.copy(TEMP_QUAT, this.tempGroup.quaternionWorld);
      quat.invert(TEMP_QUAT, TEMP_QUAT);
      quat[rotateFunc[ev.axis]](TEMP_QUAT, TEMP_QUAT, -ev.currDiff);
      quat.invert(TEMP_QUAT, TEMP_QUAT);

      this.tempGroup.setQuaternionByWorldQuaternion(TEMP_QUAT);
    }

    this.tempGroup.updateMatrixWorld();

    this.updateRotateAngles(toolAxis, ev.axis, ev.currDiff);
    this.updateParamPanelRotation(false);
  }

  private translatePivot(ev: TransformDragEvent | TransformDragEndEvent) {
    // 借用scale做临时变量
    const shift = TEMP_SCALE;
    vec3.zero(shift);

    /**
     * 有currDiff说明是drag事件，没有则是dragEnd事件
     *
     * - 如果是drag事件，取currDiff作为偏移量
     * - 如果是dragEnd事件，通过pivotHelper（如果开了的话）计算偏移量
     */
    if ('currDiff' in ev) {
      this.transformControls.position[ev.axis] += ev.currDiff;

      shift[ev.axis] = ev.currDiff;
    } else {
      const helper = this.pivotHelper.intersectPoint(
        this.transformControls.position,
      );

      if (!helper) {
        return;
      }

      vec3.sub(shift, helper, this.transformControls.position);
      vec3.copy(this.transformControls.position, helper);
    }

    vec3.negate(shift, shift);
    mat3.fromMat4(TEMP_MAT3, this.tempGroup.matrixWorld);
    mat3.invert(TEMP_MAT3, TEMP_MAT3);
    vec3.transformMat3(shift, shift, TEMP_MAT3);
    vec3.add(this.tempGroup.pivot, this.tempGroup.pivot, shift);
    this.tempGroup.updateMatrixWorld();

    this.tempGroup.setPositionByWorldPosition(this.transformControls.position);
    this.tempGroup.updateMatrixWorld();

    this.pivotHelper.intersectPoint(this.transformControls.position);

    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          pivot: serializeVec3(this.tempGroup.pivot),
          position: serializeVec3(this.tempGroup.position),
          worldPosition: serializeVec3(this.transformControls.position),
        },
      }),
      saveRecord: false,
    });
  }

  private scaleSkinParts(ev: TransformDragEvent) {
    const scale = vec3.create();
    if (ev.axis === Axis.E) {
      vec3.set(scale, ev.currDiff, ev.currDiff, ev.currDiff);
      vec3.mul(TEMP_VEC3, this.startScale, INVERSE_FIXED_SCALE);
      vec3.mul(scale, TEMP_VEC3, scale);
    } else {
      scale[ev.axis] = ev.currDiff;
      vec3.mul(scale, this.startScale, scale);
    }

    vec3.add(TEMP_VEC3, this.tempGroup.scale, scale);
    this.updateNodesScale(TEMP_VEC3, false);
  }

  public resetScale() {
    if (!store.getState().animator.activeIds.length) {
      return;
    }
    mat3.identity(this.tempGroup.parentScaleMat3);
    vec3.copy(this.tempGroup.scale, IDENTITY_SCALE);
    this.tempGroup.updateMatrixWorld();

    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          scale: serializeVec3(this.tempGroup.scale),
          parentScaleMat3: serializeMat3(this.tempGroup.parentScaleMat3),
        },
      }),
    });
  }

  public enable() {
    if (this.enabled) {
      return;
    }

    this.enabled = true;
    this.transformControls.enabled = true;
    this.dragControls.enabled = true;
    this.canvas.addEventListener('dblclick', this.doubleClick);
  }

  public disable() {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    this.transformControls.enabled = false;
    this.dragControls.enabled = false;
    this.canvas.removeEventListener('dblclick', this.doubleClick);
  }

  public abort = () => {
    this.transformControls.abort();
  };

  private doubleClick = (ev: MouseEvent) => {
    const { activeIds, activeSkinPartIds, mode, hierarchyData } =
      store.getState().animator;

    const currentObjectId = this.getCurrentNode(ev).objectId;

    // 当前没有正在hover对象的时候什么都不做
    if (!currentObjectId) {
      return;
    }

    // 双击单个部件时，发送双击事件
    if (
      activeSkinPartIds.length === 1 &&
      activeSkinPartIds[0] === activeIds[0] &&
      mode === AnimatorMode.Setup
    ) {
      this.emit('dbClick', activeSkinPartIds[0]);
      return;
    }

    // 选中一个部件组的时候，进入双击层级穿透处理
    if (activeIds.length !== 1) {
      return;
    }

    // 如果选中的是骨骼，并且有绑定的蒙皮，双击穿透选中绑定的蒙皮
    // 如果没有绑定的蒙皮，保持选中骨骼自己
    // 动画模式下，禁用部件交互，此时选中自己
    if (hierarchyData[activeIds[0]].type === ProjectNodeType.Bone) {
      const skinId = getSkinIdByBoneId(activeIds[0]);
      if (skinId && isSkinPartInteractive()) {
        this.setActiveIds([skinId]);
        if (!isMobile()) {
          store.dispatch(setHoveredId(skinId));
        }
      }
      return;
    }

    // 查找下一层级
    const parentId = getRootParentId(currentObjectId, activeIds);
    if (!parentId) {
      return;
    }
    // 选中下一层级
    this.setActiveIds([parentId]);

    this.expandParents(parentId);

    // 处理下一层级hover的组件数据
    const { activeSkinPartIds: hoveredSkinPartIds } = parseActiveIds([
      parentId,
    ]);

    if (!isMobile()) {
      store.dispatch(setHoveredId(parentId));
      store.dispatch(setHoveredSkinPartIds(hoveredSkinPartIds));
    }
  };
}
