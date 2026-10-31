import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import { mat3, mat4, quat, vec3 } from 'gl-matrix';

import { Object3D } from '../../rendering/objects/object3d';
import type { Scene } from '../../rendering/objects/scene';
import type { Stage } from '../../stage';
import type { BoneNode } from '../../bone';
import type { VoxelManager } from '../../voxel-app/voxel-manager';
import type { EditingHistory } from '../../editing-history';
import { ProjectNode, VoxelDimensionType } from '../../project/interfaces';
import type { EventMap, SkinNode, UpdateData } from './interface';

import {
  HierarchyNode,
  ProjectNodeType,
  RemoveHierarchyNode,
  CopyHierarchyNode,
  HierarchyData,
  addHierarchyNode,
  moveHierarchyNodes,
  DropType,
  updateHierarchyNode,
  releaseGroupNode,
  removeHierarchyNodes,
  copyHierarchyNodes,
  FlipAxis,
  updateSkinPartNodesFlip,
  bindNodes,
  unbindNodes,
  setEditingNodeId,
  setExpandedIds,
  setAnimatorIds,
  ParamPanelData,
  updateParamPanelData,
} from '../../../redux/animator-slice';
import {
  isBoneNode,
  isSkinPart,
  resetObjTransform,
  getBreadcrumbsWithBone,
  parseActiveIds,
  makeNewGroup,
  isControllerVisible,
  getProjectNode,
  localToWorld,
  worldToLocal,
} from '../util';
import { store } from '../../../redux/store';
import { BoneManager } from './bone-manager';
import { SkinManager } from './skin-manager';
import {
  BONE_NAME,
  incrementalNaming,
  SKIN_PART_GROUP_NAME,
  SKIN_PART_NAME,
} from '../../../utils/naming';
import { Group } from '../../rendering/objects/group';
import { TransformManager } from './transform-manager';
import {
  ROOT_ID,
  ROOT_BONE_ID,
  ROOT_SKIN_ID,
  DEFAULT_SPACE_SIZE,
} from '../../../defs';
import { IDENTITY_SCALE } from '../../rendering/controls/transform/def';
import {
  SerializedVec3,
  serializeMat3,
  serializeVec3,
  voxelShapeToObjSize,
} from '../../../utils/math';
import { VoxelDimension } from '../../project/defs';

export class NodeManager extends EventEmitter {
  public skinManager: SkinManager;

  public boneManager: BoneManager;

  public transform: TransformManager;

  private removedMap: Map<string, ProjectNode> = new Map<string, ProjectNode>();
  /**
   * 部件/部件组们旋转位移改中心点时组成的临时组
   */
  private tempGroup = new Group(nanoid());

  constructor(
    private voxelManager: VoxelManager,
    private history: EditingHistory,
    private stage: Stage,
    private scene: Scene,
  ) {
    super();
    this.skinManager = new SkinManager(stage, voxelManager);
    scene.add(this.skinManager.skin);

    this.boneManager = new BoneManager(stage, scene);
    scene.add(this.boneManager.rootBone);

    this.transform = new TransformManager({
      stage: this.stage,
      history: this.history,
      scene: this.scene,
      skinNodeManager: this.skinManager,
      boneNodeManager: this.boneManager,
      tempGroup: this.tempGroup,
      setActiveIds: this.setActiveIds,
      expandParents: this.expandParents,
      emit: this.emit,
    });

    this.history.registerActionCallback('setAnimatorIds', () => {
      // store中的activeIds为撤销重做完成后，tempGroup应该包含的id
      const { activeIds, tempGroupState } = store.getState().animator;

      // 当前tempGroup中为撤销重做前的activeIds，需要清除
      this.setActiveIds(
        activeIds,
        false,
        this.getIdsInTempGroup(),
        tempGroupState,
      );
    });

    this.history.registerActionCallback(
      'releaseGroupNode',
      (payload, isForward) => {
        if (isForward) {
          const skinNode = this.skinManager.map.get(payload.id);

          if (!skinNode || isSkinPart(skinNode)) {
            return;
          }

          this.releaseObjGroup(payload.id, payload);
        } else {
          this.restoreGroup(payload);
        }
      },
    );

    this.history.registerActionCallback(
      'removeHierarchyNodes',
      (payload, isForward) => {
        if (isForward) {
          const ids: string[] = [];
          payload.forEach((item) => ids.push(item.node.id));
          this.removeNodes(ids, false, payload);
        } else {
          payload.forEach((item) => this.restoreNode(item.node.id));
        }
      },
    );

    this.history.registerActionCallback(
      'copyHierarchyNodes',
      (payload, isForward) => {
        if (isForward) {
          payload.forEach((item) => this.restoreNode(item.newNode.id));
        } else {
          const ids: string[] = [];
          const removePayload: RemoveHierarchyNode[] = [];
          payload.forEach((item) => {
            removePayload.push({
              node: item.newNode,
              children: item.newChildrenNodes || {},
            });
            ids.push(item.newNode.id);
          });
          this.removeNodes(ids, false, removePayload);
        }
      },
    );

    this.history.registerActionCallback(
      'addHierarchyNode',
      (payload, isForward) => {
        const node = payload.newNode;
        // 打组
        if (node.childrenIds?.length) {
          if (isForward) {
            this.restoreGroup(node);
          } else {
            const { activeIds } = store.getState().animator;

            this.releaseObjGroup(node.id, node);

            this.setActiveIds(activeIds, false);
          }
          return;
        }
        // 新增部件/骨骼
        if (isForward) {
          this.restoreNode(node.id);
        } else {
          const { activeIds } = store.getState().animator;
          this.removeNodes([node.id], false, [
            {
              node: node,
              children: {},
            },
          ]);
          this.setActiveIds(activeIds, false);
        }
      },
    );

    this.history.registerActionCallback(
      'moveHierarchyNodes',
      this.updateHierarchyNodes,
    );
    this.history.registerActionCallback('bindNodes', this.updateHierarchyNodes);
    this.history.registerActionCallback(
      'unbindNodes',
      this.updateHierarchyNodes,
    );

    this.history.registerActionCallback('updateSkinPartNodesFlip', ({ axis }) =>
      this.flip(axis),
    );
    this.history.registerActionCallback(
      'updateHierarchyNode',
      ({ id, data }) => {
        this.skinManager.updateSkinPart(id, data);
      },
    );
  }

  public addListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ) {
    return super.addListener(type, listener);
  }

  public removeListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ) {
    return super.removeListener(type, listener);
  }

  public emit = <K extends keyof EventMap>(type: K, data: EventMap[K]) => {
    return super.emit(type, data);
  };

  private getIdsInTempGroup() {
    const idsInGroup: string[] = [];
    this.tempGroup.children.forEach((child) => {
      this.isModelUnit(child) && idsInGroup.push(child.uuid);
    });
    return idsInGroup;
  }

  /**
   * 当store中的组件层级结构改变时，更新舞台中的组件层级结构
   */
  private updateHierarchyNodes = () => {
    const { activeIds, tempGroupState } = store.getState().animator;
    this.clearTempGroup(activeIds, true);
    this.makeTempGroup(activeIds, tempGroupState);
    this.transform.updateParamPanelData();
  };

  /**
   * 当前obj是否是部件/部件组/骨头
   * 也就是一个模型单元
   * @param obj 入参obj
   * @returns
   */
  private isModelUnit(obj: Object3D) {
    return isSkinPart(obj) || obj.isGroup() || isBoneNode(obj);
  }

  public getModelUnit = (id: string) => {
    return this.skinManager.map.get(id) || this.boneManager.map.get(id);
  };

  /**
   * 根据ID获取部件/部件组
   * @param id id
   * @returns 部件/部件组
   */
  public getSkinNode(id: string) {
    return this.skinManager.map.get(id);
  }

  /**
   * 根据ID获取骨骼
   */
  public getBoneNode(id: string) {
    return this.boneManager.map.get(id);
  }

  /**
   * 获取全部的部件/部件组
   * @returns 全部的部件/部件组
   */
  public getAllSkinNodes() {
    return Array.from(this.skinManager.map.values());
  }

  /**
   * 获取全部骨骼节点
   * @returns 全部骨骼节点
   */
  public getAllBoneNodes() {
    return Array.from(this.boneManager.map.values());
  }

  public clear() {
    this.removedMap.clear();
    this.boneManager.clear();
    this.skinManager.clear();
  }

  private removeModelUnit = (id: string) => {
    this.skinManager.map.delete(id) || this.boneManager.map.delete(id);
  };

  public setModelUnit = (obj: SkinNode | BoneNode) => {
    isBoneNode(obj)
      ? this.boneManager.map.set(obj.uuid, obj)
      : this.skinManager.map.set(obj.uuid, obj);
  };

  public loadObj(node: ProjectNode) {
    if (node.id === ROOT_BONE_ID || node.id === ROOT_SKIN_ID) {
      return;
    }
    switch (node.type) {
      case ProjectNodeType.SkinPart:
        return this.skinManager.loadSkinPart(node);
      case ProjectNodeType.Group:
        return this.skinManager.loadGroup(node);
      case ProjectNodeType.Bone:
        return this.boneManager.loadBone(node);
      default:
        return;
    }
  }

  /**
   * 设置选中的部件/部件组/骨骼id
   * @param ids 新选中的id
   * @param saveRecord 是否需要计入撤销重做，默认计入。
   * @param curActiveIds 需要取消选中的id。默认从store中获取当前的activeIds。
   * @param tempGroupState tempGroup自带的RTS状态设置，在撤销重做中需要使用，默认不传
   */
  public setActiveIds = (
    ids: string[],
    saveRecord: boolean = true,
    curActiveIds?: string[],
    tempGroupState?: ParamPanelData,
  ) => {
    const activeIds = curActiveIds || store.getState().animator.activeIds;
    this.clearTempGroup(activeIds);

    const { activeSkinPartIds, relativeIds, relativeSkinPartIds } =
      parseActiveIds(ids);

    // 选中长度为0，代表当前无选中部件
    // 需要隐藏移动工具
    if (!ids.length) {
      this.transform.setTransformControlsVisible(false);
    } else {
      this.makeTempGroup(ids, tempGroupState);
    }

    this.history.setGroup();

    this.history.saveAction({
      action: setAnimatorIds({
        activeIds: ids,
        relativeIds,
        activeSkinPartIds,
        relativeSkinPartIds,
        tempGroupState: {
          pivot: serializeVec3(this.tempGroup.pivot),
          position: serializeVec3(this.tempGroup.position),
          rotation: serializeVec3(this.tempGroup.rotateAngles),
          scale: serializeVec3(this.tempGroup.scale),
          parentScaleMat3: serializeMat3(this.tempGroup.parentScaleMat3),
        },
      }),
      saveRecord,
    });

    this.transform.updateParamPanelData();
    this.transform.updatePivotHelper();

    this.emit('select', { ids, saveRecord });

    this.history.unsetGroup();
  };

  /**
   * 多选/单选新成临时组到tempGroup中
   * @param ids 选中的id
   * @param tempGroupState 临时组自带的数据，默认没有自带数据，不传。
   * @returns
   */
  public makeTempGroup = (ids: string[], tempGroupState?: ParamPanelData) => {
    if (!ids.length) {
      return;
    }

    // 当只选中一个部件/部件组时
    // 需要将当前部件/部件组的中心点，旋转、缩放信息赋予tempGroup
    if (ids.length === 1) {
      const target = this.getModelUnit(ids[0]);
      if (!target) {
        return;
      }
      // 不管目标部件/部件组他爸爸是谁
      // 把tempGroup悄无声息的塞进去
      target.parent?.add(this.tempGroup);
      this.tempGroup.add(target);

      vec3.copy(this.tempGroup.pivot, target.pivot);
      vec3.copy(this.tempGroup.position, target.position);
      quat.copy(this.tempGroup.quaternion, target.quaternion);
      vec3.copy(this.tempGroup.rotateAngles, target.rotateAngles);
      vec3.copy(this.tempGroup.scale, target.scale);
      mat3.copy(this.tempGroup.parentScaleMat3, target.parentScaleMat3);

      vec3.set(target.pivot, 0, 0, 0);
      vec3.set(target.position, 0, 0, 0);
      quat.identity(target.quaternion);
      vec3.copy(target.scale, IDENTITY_SCALE);
      mat3.identity(target.parentScaleMat3);
      this.scene.updateMatrixWorld();
    } else {
      if (tempGroupState) {
        vec3.copy(this.tempGroup.pivot, tempGroupState.pivot);
        this.tempGroup.setPosition(tempGroupState.position);
        this.tempGroup.setQuaternion(
          tempGroupState.rotation[0],
          tempGroupState.rotation[1],
          tempGroupState.rotation[2],
        );
        vec3.copy(this.tempGroup.rotateAngles, tempGroupState.rotation);
        vec3.copy(this.tempGroup.scale, tempGroupState.scale);
        mat3.copy(
          this.tempGroup.parentScaleMat3,
          tempGroupState.parentScaleMat3,
        );
        this.tempGroup.updateMatrixWorld();
      }
      // 当前多选时
      // 无部件中心点和旋转信息
      // 需要计算多选部件组成的最小外界立方体的中心点
      // 作为tempGroup的中心
      makeNewGroup(this.tempGroup, ids, (id) => this.getModelUnit(id));
      this.scene.add(this.tempGroup);
    }

    this.tempGroup.updateMatrixWorld();
    const { toolAxis, pivotMode, mode } = store.getState().animator;
    const controllerVisible = isControllerVisible(mode, ids);
    this.transform.setTransformControlsVisible(controllerVisible);
    this.transform.updateTransformControlsPos(pivotMode ? 'world' : toolAxis);
  };

  /**
   * 清空临时组内所有部件/移动轴
   * 将临时组内部件释放
   * 并且保持部件世界坐标不变，重新赋值本地坐标
   *
   * 当组内只有一个部件/部件轴时，默认会直接把临时组的位置旋转信息复制回去
   * 可设置强行重新计算部件/部件组的位置旋转信息
   * @param activeIds 组内的部件/部件组ID
   * @param forceReset 是否强行重置释放部件的位置，默认为否。一般用于移动至其他组内后，部件轴的数据会有变动
   */
  public clearTempGroup = (activeIds: string[], forceReset = false) => {
    // 移除临时组
    this.tempGroup.parent?.remove(this.tempGroup);

    const clonedChildren = this.tempGroup.children.slice();
    // 之前选中只有一个部件/部件组时
    // 需要将临时组中的中心点和旋转记录赋予部件/部件组
    const onePartInGroup = activeIds.length === 1;

    // 释放临时组中的部件/部件组
    clonedChildren.forEach((child) => {
      if (!this.isModelUnit(child)) {
        // 非部件/部件组/骨骼，可能是移动轴，移除即可
        this.tempGroup.remove(child);
        return;
      }

      const parent = this.getParentOrBoneByNodeId(child.uuid);
      if (!parent) {
        return;
      }

      if (onePartInGroup) {
        vec3.copy(child.pivot, this.tempGroup.pivot);
        vec3.copy(child.scale, this.tempGroup.scale);
      }

      if (onePartInGroup && !forceReset) {
        vec3.copy(child.position, this.tempGroup.position);
        quat.copy(child.quaternion, this.tempGroup.quaternion);
        vec3.copy(child.rotateAngles, this.tempGroup.rotateAngles);
        mat3.copy(child.parentScaleMat3, this.tempGroup.parentScaleMat3);
      } else {
        resetObjTransform(parent.matrixWorld, child);
      }

      parent.add(child);
    });

    // 清空临时组数据
    vec3.set(this.tempGroup.position, 0, 0, 0);
    vec3.set(this.tempGroup.pivot, 0, 0, 0);
    vec3.copy(this.tempGroup.scale, IDENTITY_SCALE);
    quat.identity(this.tempGroup.quaternion);
    vec3.set(this.tempGroup.rotateAngles, 0, 0, 0);
    mat3.identity(this.tempGroup.parentScaleMat3);

    this.scene.updateMatrixWorld();
  };

  /**
   * 新建骨骼并插入选中骨骼的下方（作为第一个子骨骼）
   * @param selectedId
   * @returns
   */
  public addBone(selectedId?: string) {
    const { activeIds, expandedIds } = store.getState().animator;

    this.history.setGroup();
    this.clearTempGroup(activeIds, false);

    const parentId = selectedId || ROOT_BONE_ID;
    const newBone = this.boneManager.addBone(parentId);

    const newName = incrementalNaming(
      BONE_NAME,
      Object.values(store.getState().animator.hierarchyData),
      (val, newName) => {
        return val.name !== newName;
      },
    );

    this.history.saveAction({
      action: addHierarchyNode({
        idx: 0,
        newNode: {
          id: newBone.uuid,
          type: ProjectNodeType.Bone,
          name: newName,
          parentId: parentId,
          childrenIds: [],
          alpha: 1,
        },
      }),
    });
    this.setActiveIds([newBone.uuid]);
    this.setEditingNodeId(newBone.uuid);
    // 添加子骨骼后自动展开所有父骨骼
    if (selectedId && !expandedIds.includes(selectedId)) {
      this.expandParents(newBone.uuid);
    }
    this.history.unsetGroup();
    return newBone;
  }

  /**
   * 新建部件并插入在选中部件/部件组的上方，新建部件的位置在模型空间中心
   */
  public addSkinPart(
    params: {
      /**
       * 选中的部件/部件组id
       */
      selectedId?: string;
      /**
       * 添加后是否更新选中
       * @default true
       */
      toSetActive?: boolean;
      /**
       * 添加后是否激活重命名
       * @default true
       */
      toRename?: boolean;
      /**
       * 新增部件渲染维度
       * @default VoxelDimension.XYZ
       */
      dimension?: VoxelDimensionType;
    } = {},
  ) {
    const {
      selectedId,
      toSetActive = true,
      toRename = true,
      dimension = VoxelDimension.XYZ,
    } = params;

    const { hierarchyData, activeIds } = store.getState().animator;

    this.history.setGroup();
    this.clearTempGroup(activeIds, false);

    let parentId = ROOT_SKIN_ID;
    let index = 0;

    if (selectedId !== undefined) {
      parentId = hierarchyData[selectedId].parentId || ROOT_SKIN_ID;
      index = hierarchyData[parentId]?.childrenIds?.indexOf(selectedId) || 0;
    }

    const size = voxelShapeToObjSize(DEFAULT_SPACE_SIZE, dimension);

    const newSkin = this.skinManager.addSkinPart(parentId, size);

    const newName = incrementalNaming(
      SKIN_PART_NAME,
      Object.values(store.getState().animator.hierarchyData),
      (val, newName) => {
        return val.name !== newName;
      },
    );

    const voxelId = nanoid();
    // 如果新增2D实体，需要同步添加voxel数据，将dimension记录至voxel数据中
    if (dimension !== VoxelDimension.XYZ) {
      this.voxelManager.loadModel(voxelId, size);
    }

    this.history.saveAction({
      action: addHierarchyNode({
        idx: index,
        newNode: {
          id: newSkin.uuid,
          type: ProjectNodeType.SkinPart,
          voxelId,
          name: newName,
          parentId: parentId,
          flip: [0, 0, 0],
          alpha: 1,
        },
      }),
    });

    toSetActive && this.setActiveIds([newSkin.uuid]);

    toRename && this.setEditingNodeId(newSkin.uuid);

    this.history.unsetGroup();
    return newSkin;
  }

  public updateSkinPart(
    id: string,
    data: Partial<UpdateData>,
    saveRecord = true,
  ) {
    this.skinManager.updateSkinPart(id, data);

    this.history.saveAction({
      action: updateHierarchyNode({
        id,
        data,
      }),
      saveRecord: saveRecord,
    });
  }

  public addGroup(childrenIds: string[]) {
    this.history.setGroup();
    this.setActiveIds([]);

    const { idx, parentNode } = this.searchFirstNode(childrenIds, ROOT_ID);

    const newGroup = this.skinManager.addGroup(childrenIds, parentNode.id);

    const newName = incrementalNaming(
      SKIN_PART_GROUP_NAME,
      Object.values(store.getState().animator.hierarchyData),
      (val, newName) => val.name !== newName,
    );

    this.history.saveAction({
      action: addHierarchyNode({
        idx,
        newNode: {
          id: newGroup.uuid,
          type: ProjectNodeType.Group,
          name: newName,
          parentId: parentNode.id,
          childrenIds: childrenIds,
        },
      }),
    });

    this.setActiveIds([newGroup.uuid]);
    this.setEditingNodeId(newGroup.uuid);
    this.history.unsetGroup();
    return newGroup;
  }

  public setEditingNodeId(id?: string) {
    store.dispatch(setEditingNodeId(id));
  }

  /**
   * 展开指定节点的所有父级
   */
  public expandParents(id: string) {
    const { expandedIds } = store.getState().animator;

    const breadcrumbs = getBreadcrumbsWithBone(id);
    const unexpandedIds: string[] = [];
    breadcrumbs.forEach((id) => {
      if (!expandedIds.includes(id)) {
        unexpandedIds.push(id);
      }
    });

    this.history.saveAction({
      action: setExpandedIds([...unexpandedIds, ...expandedIds]),
    });
  }

  public releaseGroup(id: string) {
    const { hierarchyData } = store.getState().animator;
    const skinNode = this.skinManager.map.get(id);
    const node = hierarchyData[id];
    const originChildrenIds = node.childrenIds;
    if (!skinNode || isSkinPart(skinNode) || !originChildrenIds) {
      return;
    }

    this.history.setGroup();

    this.setActiveIds([]);

    this.releaseObjGroup(id, node);

    this.history.saveAction({
      action: releaseGroupNode(node),
    });

    this.setActiveIds(originChildrenIds);

    this.history.unsetGroup();
  }

  public moveActiveSkinNodes(dropTargetId: string, dropType: DropType) {
    const { hierarchyData, activeIds, activeSkinPartIds } =
      store.getState().animator;
    const targetNode = hierarchyData[dropTargetId];
    if (
      targetNode.type === ProjectNodeType.Bone &&
      (activeIds.length !== 1 || dropType !== 'box')
    ) {
      return;
    }

    const unbindBones: string[] = [];
    let activeIdsDirty = false;

    // 检查要移动的组件，有绑定到骨骼上的需要先解绑
    for (let i = 0; i < activeIds.length; i++) {
      const node = hierarchyData[activeIds[i]];

      // 此方法不允许移动骨骼，遇到骨骼直接return
      if (
        node.type !== ProjectNodeType.SkinPart &&
        node.type !== ProjectNodeType.Group
      ) {
        return;
      }

      if (node.boneId) {
        unbindBones.push(node.boneId);
      }
    }

    // 检查移动目标，如果移动目标是骨骼且有绑定部件
    // 先解绑移动目标的部件
    if (
      targetNode.type === ProjectNodeType.Bone &&
      targetNode.skinId &&
      targetNode.skinId !== activeIds[0]
    ) {
      unbindBones.push(dropTargetId);
      // 移动目标解绑后，会选中移动目标之前绑定的部件
      // 此时activeIds数据已脏，需要重新选中解绑之前的activeIds
      activeIdsDirty = true;
    }

    this.history.setGroup();

    // 先解绑
    this.unbindNodes(unbindBones, true);
    activeIdsDirty && this.setActiveIds(activeIds);

    // 如果drop目标是骨骼，进行绑定骨骼操作
    // 否则移动部件/部件组位置
    if (targetNode.type === ProjectNodeType.Bone) {
      this.bindNode(dropTargetId, activeIds[0], activeSkinPartIds);
    } else {
      this.moveNodes(dropTargetId, dropType, activeIds);
    }

    this.history.unsetGroup();
  }

  /**
   * 解绑
   * @param ids 可以是骨骼/部件/部件组id
   * @param saveRecord 是否保存撤销重做记录
   */
  public unbindNodes(ids: string[], saveRecord: boolean) {
    if (!ids.length) {
      return;
    }
    const { hierarchyData, tempGroupState } = store.getState().animator;

    this.history.setGroup();
    const boneIds: string[] = [];
    const activeSkinIds: string[] = [];
    ids.forEach((id) => {
      const node = hierarchyData[id];
      if (!node || node.type === ProjectNodeType.Root) {
        return;
      }
      if (node.type === ProjectNodeType.Bone) {
        if (!node.skinId) {
          return;
        }
        boneIds.push(id);
        activeSkinIds.push(node.skinId);
        return;
      }
      if (!node.boneId) {
        return;
      }
      boneIds.push(node.boneId);
      activeSkinIds.push(id);
    });
    this.setActiveIds(activeSkinIds, saveRecord);
    this.history.saveAction({
      action: unbindNodes(boneIds),
      saveRecord,
    });
    this.history.unsetGroup();

    this.clearTempGroup(activeSkinIds, true);
    this.makeTempGroup(activeSkinIds, tempGroupState);
    this.transform.updateParamPanelData();
  }

  /**
   * 将部件/部件组绑定到骨骼上
   * @param boneId 骨骼ID
   * @param skinId 部件/部件组Id
   * @param skinPartIds 通过skinId解析出的skinPartIds
   * @returns
   */
  private bindNode(boneId: string, skinId: string, skinPartIds: string[]) {
    const boneNode = store.getState().animator.hierarchyData[boneId];
    if (!boneNode || boneNode.type !== ProjectNodeType.Bone) {
      return;
    }
    this.history.setGroup();
    this.history.saveAction({
      action: bindNodes({
        skinId,
        boneId,
      }),
    });
    this.updateHierarchyNodes();
    // 清空部件/部件组原本的位置旋转信息
    // 并且批量设置透明度信息
    this.transform.updateSkinPartsPosition('local', [0, 0, 0]);
    this.transform.updateSkinPartsRotation('local', [0, 0, 0]);
    this.transform.updateNodesScale(IDENTITY_SCALE);
    this.transform.updateNodesAlpha(boneNode.alpha, skinPartIds);
    this.history.unsetGroup();
  }

  public moveActiveBones(dropTargetId: string, dropType: DropType) {
    const { hierarchyData, activeIds } = store.getState().animator;

    for (let i = 0; i < activeIds.length; i++) {
      const node = hierarchyData[activeIds[i]];
      if (node.type !== ProjectNodeType.Bone) {
        return;
      }
    }

    this.moveNodes(dropTargetId, dropType, activeIds);
  }

  private moveNodes(
    dropTargetId: string,
    dropType: DropType,
    moveIds: string[],
  ) {
    this.history.setGroup();
    const { expandedIds } = store.getState().animator;
    this.history.saveAction({
      action: moveHierarchyNodes({
        moveIds,
        dropTargetId,
        dropType,
      }),
    });

    if (dropType === 'box' && !expandedIds.includes(dropTargetId)) {
      this.history.saveAction({
        action: setExpandedIds([...expandedIds, dropTargetId]),
      });
    }

    this.updateHierarchyNodes();
    this.history.unsetGroup();
  }

  /**
   * 复制部件/部件组/骨骼
   * @param ids 部件/部件组/骨骼ID。默认为activeIds
   */
  public copyNodes(ids?: string[]) {
    const { activeIds, hierarchyData } = store.getState().animator;
    const sourceIds = ids || activeIds;

    // 过滤出已经绑定骨骼的蒙皮
    // 复制已经绑定骨骼的蒙皮时，需要先解绑蒙皮，复制，然后再把原本的蒙皮绑定回去
    const reBind: { [boneId: string]: string } = {};
    for (let i = 0; i < sourceIds.length; i++) {
      const node = hierarchyData[sourceIds[i]];
      if (
        (node.type === ProjectNodeType.SkinPart ||
          node.type === ProjectNodeType.Group) &&
        node.boneId
      ) {
        reBind[node.boneId] = node.id;
      }
    }
    this.history.setGroup();
    // 先解绑
    this.unbindNodes(Object.keys(reBind), true);

    // 复制
    this.setActiveIds([]);
    const { copyNodes, newIds } = this.copyObjNodes(sourceIds);

    this.history.saveAction({
      action: copyHierarchyNodes(copyNodes),
    });

    // 将刚刚解绑的蒙皮绑定回去
    Object.keys(reBind).forEach((boneId) => {
      const skinId = reBind[boneId];
      this.setActiveIds([skinId]);
      const { activeSkinPartIds } = store.getState().animator;
      this.bindNode(boneId, skinId, activeSkinPartIds);
    });

    this.setActiveIds(newIds);
    if (newIds.length === 1) {
      this.setEditingNodeId(newIds[0]);
    }
    this.history.unsetGroup();
  }

  /**
   * 移除部件/部件组/骨骼
   * @param ids 部件/部件组/骨骼ID
   * @param saveRecord
   * @param payload
   */
  public removeNodes = (
    ids: string[],
    saveRecord: boolean = true,
    payload?: RemoveHierarchyNode[],
  ) => {
    this.history.setGroup();

    const parsedPayload =
      payload &&
      payload.reduce((nodes, removeNode) => {
        Object.assign(nodes, { [removeNode.node.id]: removeNode.node });
        Object.assign(nodes, removeNode.children);
        return nodes;
      }, {});

    const sourceNodes =
      parsedPayload || store.getState().animator.hierarchyData;

    // 如果删除已经绑定骨骼的部件/部件组，先解绑
    const unbindBones: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const node = sourceNodes[ids[i]];
      if (
        node.type === ProjectNodeType.Group ||
        node.type === ProjectNodeType.SkinPart
      ) {
        node.boneId && unbindBones.push(node.boneId);
      }
    }
    this.unbindNodes(unbindBones, saveRecord);

    this.setActiveIds([], saveRecord);
    const removeNodes = this.removeObjNodes(
      ids,
      parsedPayload || store.getState().animator.hierarchyData,
    );

    this.history.saveAction({
      action: removeHierarchyNodes(removeNodes),
      saveRecord,
    });

    if (saveRecord) {
      this.emit('remove', { nodes: removeNodes, saveRecord });
    }

    this.history.unsetGroup();
  };

  public flipSkinParts(axis: FlipAxis) {
    const { activeSkinPartIds } = store.getState().animator;
    this.history.saveAction({
      action: updateSkinPartNodesFlip({
        ids: activeSkinPartIds,
        axis,
      }),
    });

    this.flip(axis);
  }

  private flip(axis: FlipAxis) {
    const { activeSkinPartIds, activeIds, toolAxis } =
      store.getState().animator;

    // 以tempGroup的部件轴为单位进行翻转
    // 需要将tempGroup翻转前的位置和旋转记录下来
    // 将tempGroup数据清空后，按照世界轴的方式翻转内部各个组件
    // 翻转结束后将之前记录的位置和旋转设置回去
    const prevPos = this.tempGroup.getWorldPivot();
    const prevQuat = quat.clone(this.tempGroup.quaternionWorld);
    this.tempGroup.setPositionByWorldPosition([0, 0, 0]);
    this.tempGroup.setQuaternionByWorldQuaternion([0, 0, 0, 1]);
    this.tempGroup.updateMatrixWorld();

    // 释放临时组内部件
    this.clearTempGroup(activeIds);

    // 翻转每个部件
    activeSkinPartIds.forEach((id) => this.skinManager.flipSkinPart(id, axis));

    // 重新集合临时组
    this.makeTempGroup(activeIds);

    // 将翻转前的tempGroup数据设置回去
    this.tempGroup.setPositionByWorldPosition(prevPos);
    this.tempGroup.setQuaternionByWorldQuaternion(prevQuat);
    this.tempGroup.updateMatrixWorld();
    this.transform.updateTransformControlsPos(toolAxis);
  }

  /**
   * 通过node id 获取父节点或者绑定的骨骼实例
   * 皮肤部件绑定骨骼在舞台渲染中为父子关系，而在node数据中不为父子关系
   * 部件/部件组绑定到骨骼后，parentId为undefined，绑定骨骼ID在boneId中
   * 当查询一个部件/部件组在舞台渲染中的父节点时，parentId为undefined的时候需要再去从boneId中取查询骨骼实例
   * @param id
   * @returns
   */
  public getParentOrBoneByNodeId(id: string, sourceData?: HierarchyData) {
    const { hierarchyData } = store.getState().animator;
    const node = (sourceData || hierarchyData)[id];
    if (node.type === ProjectNodeType.Root) {
      return;
    }

    // 骨骼节点正常查询parentID
    if (node.type === ProjectNodeType.Bone) {
      return node.parentId
        ? this.boneManager.map.get(node.parentId) || this.boneManager.rootBone
        : this.boneManager.rootBone;
    }

    // 查询一个部件/部件组时，parentId为undefined的时候再去从boneId中取查询绑定的骨骼实例
    if (node.parentId) {
      return this.skinManager.map.get(node.parentId) || this.skinManager.skin;
    }
    // 部件/部件组不可能绑定到根骨骼中，直接从map信息查询
    if (node.boneId) {
      return this.boneManager.map.get(node.boneId);
    }
  }

  private removeObjNodes(
    ids: string[],
    sourceNodes: { [id: string]: HierarchyNode },
  ) {
    const removeNodes: RemoveHierarchyNode[] = [];

    ids.forEach((id) => {
      const obj = this.getModelUnit(id);
      if (!obj) {
        return;
      }
      const removeNode: RemoveHierarchyNode = {
        node: sourceNodes[id],
        children: {},
      };
      obj.parent?.remove(obj);

      let children = obj.children;

      while (children.length) {
        const newChildren: Object3D[] = [];
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const node = sourceNodes[child.uuid];
          // child可能是一些纯视觉组件
          if (!node) {
            continue;
          }
          const projectNode = getProjectNode(node, this.getModelUnit);
          projectNode && this.removedMap.set(node.id, projectNode);

          removeNode.children[child.uuid] = node;
          newChildren.push(...child.children);

          if (node.type === ProjectNodeType.SkinPart && node.voxelId) {
            this.voxelManager.removeVoxel(node.voxelId);
          }
          this.removeModelUnit(node.id);
        }

        children = newChildren;
      }

      const projectNode = getProjectNode(removeNode.node, this.getModelUnit);
      projectNode && this.removedMap.set(id, projectNode);
      removeNodes.push(removeNode);

      if (
        removeNode.node.type === ProjectNodeType.SkinPart &&
        removeNode.node.voxelId
      ) {
        this.voxelManager.removeVoxel(removeNode.node.voxelId);
      }
      this.removeModelUnit(removeNode.node.id);
    });

    return removeNodes;
  }

  /**
   * 舞台解组操作
   * @param id 组的id
   * @param node 节点的数据
   */
  private releaseObjGroup(id: string, node: HierarchyNode) {
    const skinNode = this.skinManager.map.get(id);

    if (!skinNode || isSkinPart(skinNode)) {
      return;
    }

    const clonedChildren = skinNode.children.slice();
    const parent = skinNode.parent || this.skinManager.skin;

    clonedChildren.forEach((child) => {
      if (!isSkinPart(child) && !child.isGroup()) {
        return;
      }
      resetObjTransform(parent.matrixWorld, child);
      parent.add(child);
    });

    parent.remove(skinNode);

    const projectNode = getProjectNode(node, this.getModelUnit);
    projectNode && this.removedMap.set(id, projectNode);
    this.skinManager.map.delete(id);
  }

  /**
   * 复制部件/部件组/骨骼
   * @param sourceIds 原本的部件/部件组/骨骼ID
   */
  private copyObjNodes(sourceIds: string[]) {
    const copyNodes: CopyHierarchyNode[] = [];
    const newIds: string[] = [];

    sourceIds.forEach((id) => {
      const obj = this.getModelUnit(id);
      if (!obj) {
        return;
      }
      const { newObj, copyNode } = this.copyObjNode(obj);

      this.getParentOrBoneByNodeId(id)?.add(newObj);
      this.setModelUnit(newObj);

      copyNodes.push(copyNode);
      newIds.push(copyNode.newNode.id);
    });

    return {
      copyNodes,
      newIds,
    };
  }

  /**
   * 根据源数据source复制新的组件
   * @param source 源数据
   * @param parentId 父节点ID，可以是部件组/骨骼。如果父节点也是新复制的就需要传，不传则默认与源数据父节点一致
   * @param boneId 绑定的骨骼节点ID。不传默认与源数据绑定的骨骼节点一致
   * @returns
   */
  private copyObjNode(source: Object3D, parentId?: string, boneId?: string) {
    const { hierarchyData } = store.getState().animator;
    const sourceNode = hierarchyData[source.uuid];
    const newObj = source.clone(false);
    const newNode = Object.assign({}, sourceNode);
    newNode.id = newObj.uuid;

    if (parentId) {
      newNode.parentId = parentId;
    }

    if (
      boneId &&
      (newNode.type === ProjectNodeType.SkinPart ||
        newNode.type === ProjectNodeType.Group)
    ) {
      newNode.boneId = boneId;
    }

    if (
      newNode.type === ProjectNodeType.SkinPart &&
      sourceNode.type === ProjectNodeType.SkinPart &&
      sourceNode.voxelId
    ) {
      newNode.voxelId = this.voxelManager.cloneModel(sourceNode.voxelId)?.id;
    }

    const copyNode: CopyHierarchyNode = {
      newNode,
      sourceNodeId: sourceNode.id,
    };
    const newChildrenNodes: HierarchyData = {};

    // 处理children
    if (sourceNode.childrenIds) {
      // childrenIds都需要设置复制出来的新ID，先清空
      copyNode.newNode.childrenIds = [];
      // 继续复制children
      sourceNode.childrenIds.forEach((childId) => {
        const newChildId = this.setAndCopyObj(
          newChildrenNodes,
          childId,
          newObj,
        );
        if (!newChildId) {
          return;
        }
        copyNode.newNode.childrenIds?.push(newChildId);
      });
    }

    // 处理骨骼绑定的蒙皮
    if (
      copyNode.newNode.type === ProjectNodeType.Bone &&
      copyNode.newNode.skinId
    ) {
      const newSkinId = this.setAndCopyObj(
        newChildrenNodes,
        copyNode.newNode.skinId,
        newObj,
        true,
      );
      copyNode.newNode.skinId = newSkinId;
    }

    copyNode.newChildrenNodes = newChildrenNodes;

    return {
      newObj,
      copyNode,
    };
  }

  /**
   * 根据输入的sourceId，复制此组件，并将复制出来的组件设置到指定的parent组件中去
   * 目前仅在copyNode方法内使用
   * @param out 输出复制出来的新的node数据，包含自身和其children数据
   * @param sourceId 来源ID
   * @param parent 指定的parent组件，可能是部件组/骨骼
   * @param isBoneId parent组件是否是皮肤绑定的骨骼ID
   * @returns
   */
  private setAndCopyObj(
    out: HierarchyData,
    sourceId: string,
    parent: Object3D,
    isBoneId?: boolean,
  ) {
    const sourceObj = this.getModelUnit(sourceId);
    if (!sourceObj) {
      return;
    }

    // 子组件/骨骼绑定的蒙皮复制时需要重新设置parentId/boneId
    const { newObj, copyNode } = this.copyObjNode(
      sourceObj,
      isBoneId ? undefined : parent.uuid,
      isBoneId ? parent.uuid : undefined,
    );
    const newId = copyNode.newNode.id;
    // 设置map数据
    this.setModelUnit(newObj);
    // 设置obj3d的父子关系
    parent.add(newObj);

    // 合并子组件信息
    out[newId] = copyNode.newNode;
    Object.assign(out, copyNode.newChildrenNodes);

    return newId;
  }

  /**
   * 恢复组节点，重新添加子节点
   * @param node 需要恢复的组节点
   */
  private restoreGroup(node: HierarchyNode) {
    const projectNode = this.removedMap.get(node.id);
    if (!projectNode || !node.parentId || !node.childrenIds) {
      return;
    }
    const group = this.skinManager.loadGroup(projectNode);
    const parent = this.getParentOrBoneByNodeId(node.parentId);
    parent?.add(group);
    group.updateMatrixWorld();

    node.childrenIds.forEach((childId) => {
      const child = this.skinManager.map.get(childId);
      if (!child) {
        return;
      }
      resetObjTransform(group.matrixWorld, child);
      group.add(child);
    });

    this.removedMap.delete(node.id);
    this.skinManager.map.set(node.id, group);
  }

  /**
   * 恢复已删除的节点，用于处理新增/删除节点的“撤销重做”副作用
   * @param id 要恢复的节点id
   */
  public restoreNode(id: string) {
    const parent = this.getParentOrBoneByNodeId(id);
    if (!parent) {
      return;
    }
    this.reloadNode(parent, [id]);
    parent.updateMatrixWorld();
  }

  private reloadNode = (parent: Object3D, childrenIds: string[]) => {
    childrenIds.forEach((childId) => {
      const node = this.removedMap.get(childId);
      if (!node) {
        return;
      }
      node.voxelId && this.voxelManager.restoreModel(node.voxelId);

      const obj = this.loadObj(node);
      if (!obj) {
        return;
      }
      parent.add(obj);
      this.removedMap.delete(childId);
      this.setModelUnit(obj);

      // 骨骼绑定的部件/部件组也需要作为childId丢进去加载
      const children = [...node.childrenIds];
      node.skinId && children.push(node.skinId);
      this.reloadNode(obj, children);
    });
  };

  /**
   * 查找id数组中，在节点列表层级最高，且排序最前的节点。
   */
  private searchFirstNode(
    ids: string[],
    entry: string,
  ): {
    idx: number;
    node: HierarchyNode;
    parentNode: HierarchyNode;
  } {
    const list: string[] = [entry];

    const { hierarchyData } = store.getState().animator;

    let firstId: string | undefined;

    while (list.length) {
      const id = list.shift();

      if (!id) {
        break;
      }

      if (ids.includes(id)) {
        firstId = id;
        break;
      }

      const node = hierarchyData[id];

      if (!node || !node.childrenIds) {
        continue;
      }

      list.push(...node.childrenIds);
    }

    let idx = 0;
    let node: HierarchyNode;
    let parentNode: HierarchyNode | undefined;

    firstId = firstId ? firstId : ids[0];

    node = hierarchyData[firstId];

    if (node.parentId) {
      parentNode = hierarchyData[node.parentId];

      const childIdx =
        hierarchyData[node.parentId].childrenIds?.indexOf(firstId) || 0;

      idx = Math.max(childIdx, 0);
    }

    parentNode = parentNode ? parentNode : hierarchyData[ROOT_ID];

    return {
      idx,
      node,
      parentNode,
    };
  }

  /**
   * 重置部件/部件组的中心点
   * - 如果是部件组，根据组内的所有子孙后代的部件尺寸构成的包围盒计算
   * - 如果是部件，根据自身的部件尺寸计算
   */
  public resetSkinNodePivot() {
    const { hierarchyData, activeIds } = store.getState().animator;

    if (activeIds.length === 0 || activeIds.length > 1) {
      return;
    }

    const [nodeId] = activeIds;

    const node = hierarchyData[nodeId];
    const skinNode = this.getSkinNode(nodeId);

    if (
      !node ||
      (node.type !== ProjectNodeType.SkinPart &&
        node.type !== ProjectNodeType.Group) ||
      !skinNode
    ) {
      return;
    }

    const newPivot: SerializedVec3 = [0, 0, 0];
    const newWorldPos: SerializedVec3 = [0, 0, 0];

    // 如果是部件，直接根据自身的体素尺寸计算
    if (node.type === ProjectNodeType.SkinPart) {
      if (isSkinPart(skinNode)) {
        vec3.scale(newPivot, skinNode.skinPartBox.geometry.size, -0.5);
      }

      // 计算出新锚点的世界坐标位置
      localToWorld(newWorldPos, this.tempGroup, newPivot);

      vec3.copy(this.tempGroup.pivot, newPivot);

      this.tempGroup.updateMatrixWorld();

      this.tempGroup.setPositionByWorldPosition(newWorldPos);

      this.tempGroup.updateMatrixWorld();
    } else {
      // 如果是部件组，以部件组的children来计算，先清理当前选中
      this.clearTempGroup(activeIds);

      // 通过tempGroup的特性，拿到children构成的中心点
      this.makeTempGroup(node.childrenIds);

      vec3.copy(newWorldPos, this.tempGroup.getWorldPivot());

      // 反推回部件的本地坐标
      worldToLocal(newPivot, skinNode, newWorldPos);

      vec3.copy(skinNode.pivot, newPivot);

      skinNode.updateMatrixWorld();

      skinNode.setPositionByWorldPosition(newWorldPos);

      skinNode.updateMatrixWorld();

      this.clearTempGroup(node.childrenIds);

      this.makeTempGroup(activeIds);
    }

    this.transform.updateTransformControlsPos('world');
    this.transform.updatePivotHelper();

    this.history.saveAction({
      action: updateParamPanelData({
        data: {
          pivot: newPivot,
          position: serializeVec3(this.tempGroup.position),
          worldPosition: newWorldPos,
        },
      }),
    });
  }
}
