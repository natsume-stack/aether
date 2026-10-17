import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { ROOT_BONE_NAME, ROOT_NAME, ROOT_SKIN_NAME } from '../../utils/naming';
import { ROOT_ID, ROOT_BONE_ID, ROOT_SKIN_ID } from '../../defs';
import {
  AddHierarchyNode,
  AnimatorMode,
  AnimatorState,
  CopyHierarchyNode,
  FlipAxis,
  HierarchyNode,
  ProjectNodeType,
  MoveHierarchyNodes,
  ParamPanelData,
  RemoveHierarchyNode,
  ToolAxis,
  ToolType,
  UpdateNodeData,
  HierarchyData,
  AddType,
  HitBoxMode,
  HitBoxParamPanelData,
  PivotMode,
} from './state';
import {
  addMotionReducer,
  loadMotionsReducer,
  moveMotionReducer,
  setActiveKeyframesReducer,
  setActiveMotionIdReducer,
  setMotionNodesReducer,
  setKeyframesInterpolationReducer,
  moveKeyframesReducer,
  removeKeyframesReducer,
  upsertKeyframesReducer,
  removeMotionReducer,
  copyMotionReducer,
  renameMotionReducer,
  removeMotionsNodesReducer,
  prependMotionsReducer,
} from './motion-reducers';

export * from './state';

export const IDENTITY_PARAM_PANEL: ParamPanelData = {
  pivot: [0, 0, 0],
  opacity: 1,
  position: [0, 0, 0],
  worldPosition: [0, 0, 0],
  rotation: [0, 0, 0],
  worldRotation: [0, 0, 0],
  scale: [1, 1, 1],
  parentScaleMat3: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

const initialState: AnimatorState = {
  mode: AnimatorMode.Setup,
  hitBoxMode: HitBoxMode.Default,
  activeIds: [],
  tempGroupState: IDENTITY_PARAM_PANEL,
  hoveredSkinPartIds: [],
  activeSkinPartIds: [],
  relativeIds: [],
  relativeSkinPartIds: [],
  expandedIds: [ROOT_BONE_ID, ROOT_SKIN_ID],
  toolType: ToolType.Translate,
  toolAxis: 'world',
  addType: 'object3d',
  pivotMode: PivotMode.None,
  gridVisible: true,
  boxesVisible: true,
  skeletonVisible: true,
  emissive: true,
  modelBoxVisible: true,
  hierarchyData: {
    [ROOT_ID]: {
      id: ROOT_ID,
      type: ProjectNodeType.Root,
      name: ROOT_NAME,
      childrenIds: [ROOT_BONE_ID, ROOT_SKIN_ID],
    },
    [ROOT_BONE_ID]: {
      id: ROOT_BONE_ID,
      type: ProjectNodeType.Bone,
      name: ROOT_BONE_NAME,
      parentId: ROOT_ID,
      childrenIds: [],
      alpha: 1,
    },
    [ROOT_SKIN_ID]: {
      id: ROOT_SKIN_ID,
      type: ProjectNodeType.Group,
      name: ROOT_SKIN_NAME,
      parentId: ROOT_ID,
      childrenIds: [],
    },
  },
  paramPanelData: IDENTITY_PARAM_PANEL,
  activeMotionId: '',
  motionData: {
    motions: {},
    motionIds: [],
  },
  activeKeyframes: {},
  modelPivot: [0, 0, 0],
};

/**
 * 检查targetId是否是nodeId的child
 * @param hierarchyData 数据查询表
 * @param nodeId 被检查的ID
 * @param targetId 目标ID
 * @returns
 */
const checkTargetIsChild = (
  hierarchyData: { [id: string]: HierarchyNode },
  nodeId: string,
  targetId: string,
) => {
  const node = hierarchyData[nodeId];
  if (!node || !node.childrenIds || !node.childrenIds.length) {
    return false;
  }

  for (const childId of node.childrenIds) {
    if (childId === targetId) {
      return true;
    }
    if (checkTargetIsChild(hierarchyData, childId, targetId)) {
      return true;
    }
  }
};

export const ANIMATOR_SLICE_NAME = 'animator';

/**
 * 判断节点是否合法（不是孤立节点，挂到节点树上不会被展示）
 * 合法节点有这么几种情况：
 * - 节点有父节点，且父节点存在
 * - 节点是部件/部件组，无父节点，但有绑定的骨骼，且该骨骼存在
 */
function isValidHierarchyNode(
  node: HierarchyNode,
  hierarchies: HierarchyData,
): boolean {
  if (node.parentId && hierarchies[node.parentId]) {
    return true;
  }

  if (
    node.type === ProjectNodeType.SkinPart ||
    node.type === ProjectNodeType.Group
  ) {
    return !!node.boneId && !!hierarchies[node.boneId];
  }

  return false;
}

export const animatorSlice = createSlice({
  name: ANIMATOR_SLICE_NAME,
  initialState,
  reducers: {
    setAnimatorState(state, action: PayloadAction<AnimatorState>) {
      Object.assign(state, action.payload);
    },
    setAnimatorIds(
      state,
      action: PayloadAction<{
        activeIds: string[];
        relativeIds: string[];
        activeSkinPartIds: string[];
        relativeSkinPartIds: string[];
        tempGroupState: Partial<ParamPanelData>;
      }>,
    ) {
      const {
        activeIds,
        relativeIds,
        activeSkinPartIds,
        relativeSkinPartIds,
        tempGroupState,
      } = action.payload;

      state.activeIds = activeIds;
      state.relativeIds = relativeIds;
      state.activeSkinPartIds = activeSkinPartIds;
      state.relativeSkinPartIds = relativeSkinPartIds;

      Object.assign(state.tempGroupState, tempGroupState);
    },
    setHoveredId(state, action: PayloadAction<string | undefined>) {
      state.hoveredId = action.payload;
    },
    setHoveredObjectId(state, action: PayloadAction<string | undefined>) {
      state.hoveredObjectId = action.payload;
    },
    setHoveredSkinPartIds(state, action: PayloadAction<string[]>) {
      state.hoveredSkinPartIds = action.payload;
    },
    setExpandedIds(state, action: PayloadAction<string[]>) {
      state.expandedIds = action.payload;
    },
    setToolType(state, action: PayloadAction<ToolType>) {
      state.toolType = action.payload;
    },
    setToolAxis(state, action: PayloadAction<ToolAxis>) {
      state.toolAxis = action.payload;
    },
    setAddType(state, action: PayloadAction<AddType>) {
      state.addType = action.payload;
    },
    setPivotMode(state, action: PayloadAction<PivotMode>) {
      state.pivotMode = action.payload;
    },
    setGridVisible(state, action: PayloadAction<boolean>) {
      state.gridVisible = action.payload;
    },
    setBoxesVisible(state, action: PayloadAction<boolean>) {
      state.boxesVisible = action.payload;
    },
    setSkeletonVisible(state, action: PayloadAction<boolean>) {
      state.skeletonVisible = action.payload;
    },
    setEmissive(state, action: PayloadAction<boolean>) {
      state.emissive = action.payload;
    },
    setModelBoxVisible(state, action: PayloadAction<boolean>) {
      state.modelBoxVisible = action.payload;
    },
    addHierarchyNode(state, action: PayloadAction<AddHierarchyNode>) {
      const { idx, newNode } = action.payload;

      state.hierarchyData[newNode.id] = newNode;

      // 处理children
      const childrenIds = newNode.childrenIds;
      if (childrenIds) {
        childrenIds.forEach((id) => {
          const child = state.hierarchyData[id];
          if (!child) {
            return;
          }
          // disconnect
          if (child.parentId) {
            const parent = state.hierarchyData[child.parentId];
            parent?.childrenIds?.splice(
              parent.childrenIds.indexOf(child.id),
              1,
            );
          }

          child.parentId = newNode.id;
        });
      }

      // 处理parent
      if (!newNode.parentId) {
        return;
      }
      const parent = state.hierarchyData[newNode.parentId];

      parent?.childrenIds?.splice(idx, 0, newNode.id);
    },
    /**
     * 导入新的部件/部件组/骨骼
     */
    addNewHierarchyNodes(state, action: PayloadAction<HierarchyData>) {
      const { hierarchyData } = state;

      Object.values(action.payload).forEach((node) => {
        if (!isValidHierarchyNode(node, hierarchyData)) {
          return;
        }

        hierarchyData[node.id] = node;

        if (node.parentId && hierarchyData[node.parentId]) {
          const parent = hierarchyData[node.parentId];

          if (!parent.childrenIds) {
            parent.childrenIds = [];
          }

          parent.childrenIds.unshift(node.id);
        }
      });
    },
    releaseGroupNode(state, action: PayloadAction<HierarchyNode>) {
      const node = state.hierarchyData[action.payload.id];
      if (!node || node.type !== ProjectNodeType.Group) {
        return;
      }

      if (node.parentId) {
        const parent = state.hierarchyData[node.parentId];
        // disconnect
        parent?.childrenIds?.splice(
          parent.childrenIds.indexOf(node.id),
          1,
          ...node.childrenIds,
        );
      }

      node.childrenIds.forEach((childId) => {
        state.hierarchyData[childId].parentId = node.parentId;
      });

      delete state.hierarchyData[action.payload.id];
    },
    copyHierarchyNodes(state, action: PayloadAction<CopyHierarchyNode[]>) {
      action.payload.forEach((copyNode) => {
        const { newNode, sourceNodeId, newChildrenNodes } = copyNode;
        if (state.hierarchyData[newNode.id]) {
          return;
        }
        state.hierarchyData[newNode.id] = newNode;

        // 插入parent的childrenIds
        // 插在原节点的上方或根皮肤节点下
        if (newNode.parentId) {
          const parent = state.hierarchyData[newNode.parentId];
          parent?.childrenIds?.splice(
            parent.childrenIds.indexOf(sourceNodeId),
            0,
            newNode.id,
          );
        } else {
          const parent = state.hierarchyData[ROOT_SKIN_ID];
          parent?.childrenIds?.splice(0, 0, newNode.id);
        }

        if (newChildrenNodes) {
          Object.assign(state.hierarchyData, newChildrenNodes);
        }
      });
    },
    moveHierarchyNodes(state, action: PayloadAction<MoveHierarchyNodes>) {
      const { moveIds, dropTargetId, dropType } = action.payload;

      for (let i = 0; i < moveIds.length; i++) {
        if (
          moveIds[i] === dropTargetId ||
          checkTargetIsChild(state.hierarchyData, moveIds[i], dropTargetId)
        ) {
          return;
        }
      }

      const parentId =
        dropType === 'box'
          ? dropTargetId
          : state.hierarchyData[dropTargetId].parentId;

      if (!parentId) {
        return;
      }

      moveIds.forEach((id) => {
        const target = state.hierarchyData[id];
        if (!target) {
          return;
        }
        // disconnect
        if (target.parentId) {
          const parent = state.hierarchyData[target.parentId];
          parent?.childrenIds?.splice(parent.childrenIds.indexOf(target.id), 1);
        }

        target.parentId = parentId;
      });

      const getDropIndex = () => {
        const index = Math.max(
          0,
          state.hierarchyData[parentId].childrenIds?.indexOf(dropTargetId) || 0,
        );
        return dropType === 'bottom' ? index + 1 : index;
      };

      state.hierarchyData[parentId].childrenIds?.splice(
        getDropIndex(),
        0,
        ...moveIds,
      );
    },
    removeHierarchyNodes(state, action: PayloadAction<RemoveHierarchyNode[]>) {
      const collapseIds: string[] = [];
      action.payload.forEach((item) => {
        const { node, children } = item;
        if (!state.hierarchyData[node.id]) {
          return;
        }

        // disconnect
        if (node.parentId) {
          const parent = state.hierarchyData[node.parentId];
          parent?.childrenIds?.splice(parent.childrenIds.indexOf(node.id), 1);
          if (
            parent.type === ProjectNodeType.Bone &&
            !parent.childrenIds?.length &&
            parent.id !== ROOT_BONE_ID
          ) {
            collapseIds.push(parent.id);
          }
        }

        Object.keys(children).forEach((childId) => {
          delete state.hierarchyData[childId];
        });

        delete state.hierarchyData[node.id];
      });
      collapseIds.forEach((id) => {
        state.expandedIds.splice(state.expandedIds.indexOf(id), 1);
      });
    },
    clearHierarchyNodes(state) {
      state.hierarchyData = { ...initialState.hierarchyData };
    },
    updateHierarchyNode(
      state,
      action: PayloadAction<{
        id: string;
        data: Partial<UpdateNodeData>;
      }>,
    ) {
      const { id, data } = action.payload;
      const node = state.hierarchyData[id];
      if (!node) {
        return;
      }
      if (data.name) {
        node.name = data.name;
      }

      if (node.type === ProjectNodeType.SkinPart && data.voxelId) {
        node.voxelId = data.voxelId;
      }
    },
    updateSkinPartNodesFlip(
      state,
      action: PayloadAction<{
        ids: string[];
        axis: FlipAxis;
      }>,
    ) {
      const { ids, axis } = action.payload;

      ids.forEach((id) => {
        const node = state.hierarchyData[id];
        if (!node || node.type !== ProjectNodeType.SkinPart) {
          return;
        }
        node.flip = node.flip || [0, 0, 0];
        node.flip[axis] = node.flip[axis] ? 0 : 1;
      });
    },
    updateHierarchyNodesAlpha(
      state,
      action: PayloadAction<{
        ids: string[];
        alphas: number[];
      }>,
    ) {
      const { ids, alphas } = action.payload;

      if (ids.length !== alphas.length) {
        return;
      }

      ids.forEach((id, idx) => {
        const node = state.hierarchyData[id];
        if (
          !node ||
          (node.type !== ProjectNodeType.SkinPart &&
            node.type !== ProjectNodeType.Bone)
        ) {
          return;
        }
        node.alpha = alphas[idx];
      });
    },
    loadHierarchyNodes(
      state,
      action: PayloadAction<{ [id: string]: HierarchyNode }>,
    ) {
      state.hierarchyData = action.payload;
    },
    updateParamPanelData(
      state,
      action: PayloadAction<{ data: Partial<ParamPanelData> }>,
    ) {
      Object.assign(state.paramPanelData, action.payload.data);
      Object.assign(state.tempGroupState, action.payload.data);
    },
    setAnimatorMode(state, action: PayloadAction<AnimatorMode>) {
      state.mode = action.payload;
    },
    setHitBoxMode(state, action: PayloadAction<HitBoxMode>) {
      state.hitBoxMode = action.payload;
    },
    bindNodes(
      state,
      action: PayloadAction<{ skinId: string; boneId: string }>,
    ) {
      const { skinId, boneId } = action.payload;
      const skinNode = state.hierarchyData[skinId];
      const boneNode = state.hierarchyData[boneId];
      if (
        !skinNode ||
        !boneNode ||
        (skinNode.type !== ProjectNodeType.SkinPart &&
          skinNode.type !== ProjectNodeType.Group) ||
        boneNode.type !== ProjectNodeType.Bone
      ) {
        return;
      }

      if (skinNode.parentId) {
        const parent = state.hierarchyData[skinNode.parentId];
        parent?.childrenIds?.splice(parent.childrenIds.indexOf(skinNode.id), 1);
      }

      if (boneNode.skinId) {
        const attachedNode = state.hierarchyData[boneNode.skinId];
        if (
          attachedNode.type === ProjectNodeType.SkinPart ||
          attachedNode.type === ProjectNodeType.Group
        ) {
          const newParent = state.hierarchyData[ROOT_SKIN_ID];
          attachedNode.parentId = newParent.id;
          attachedNode.boneId = undefined;
          newParent.childrenIds?.unshift(attachedNode.id);
        }
      }

      skinNode.parentId = undefined;
      skinNode.boneId = boneId;
      boneNode.skinId = skinId;
    },
    unbindNodes(state, action: PayloadAction<string[]>) {
      const ids = action.payload;
      ids.forEach((boneId) => {
        const boneNode = state.hierarchyData[boneId];
        if (!boneNode || boneNode.type !== ProjectNodeType.Bone) {
          return;
        }

        const skinNode =
          boneNode.skinId && state.hierarchyData[boneNode.skinId];
        if (
          !skinNode ||
          (skinNode.type !== ProjectNodeType.SkinPart &&
            skinNode.type !== ProjectNodeType.Group)
        ) {
          return;
        }

        boneNode.skinId = undefined;
        const rootSkin = state.hierarchyData[ROOT_SKIN_ID];
        skinNode.parentId = rootSkin.id;
        skinNode.boneId = undefined;
        rootSkin.childrenIds?.unshift(skinNode.id);
      });
    },
    renameHierarchyNode(
      state,
      action: PayloadAction<{ id: string; newName: string }>,
    ) {
      const { id, newName } = action.payload;
      const node = state.hierarchyData[id];
      if (!node) {
        return;
      }
      node.name = newName;
    },
    setEditingNodeId(state, action: PayloadAction<string | undefined>) {
      state.editingNodeId = action.payload;
    },
    updateHitBoxParamPanelData(
      state,
      action: PayloadAction<{ data?: Partial<HitBoxParamPanelData> }>,
    ) {
      if (!action.payload.data) {
        state.hitBoxParamPanelData = undefined;
        return;
      }

      if (!state.hitBoxParamPanelData) {
        state.hitBoxParamPanelData = {
          position: [0, 0, 0],
          size: [0, 0, 0],
        };
      }

      Object.assign(state.hitBoxParamPanelData, action.payload.data);
    },
    updateModelPivot(
      state,
      action: PayloadAction<AnimatorState['modelPivot']>,
    ) {
      state.modelPivot = action.payload;
    },
    loadMotions: loadMotionsReducer,
    setActiveMotionId: setActiveMotionIdReducer,
    addMotion: addMotionReducer,
    prependMotions: prependMotionsReducer,
    setMotionNodes: setMotionNodesReducer,
    moveMotion: moveMotionReducer,
    setActiveKeyframes: setActiveKeyframesReducer,
    setKeyframesInterpolation: setKeyframesInterpolationReducer,
    moveKeyframes: moveKeyframesReducer,
    removeKeyframes: removeKeyframesReducer,
    upsertKeyframes: upsertKeyframesReducer,
    removeMotion: removeMotionReducer,
    copyMotion: copyMotionReducer,
    renameMotion: renameMotionReducer,
    removeMotionsNodes: removeMotionsNodesReducer,
  },
});

export const {
  setAnimatorState,
  setAnimatorIds,
  setHoveredId,
  setHoveredObjectId,
  setHoveredSkinPartIds,
  setExpandedIds,
  setToolType,
  setToolAxis,
  setAddType,
  setPivotMode,
  setGridVisible,
  setBoxesVisible,
  setSkeletonVisible,
  setEmissive,
  setModelBoxVisible,
  addHierarchyNode,
  addNewHierarchyNodes,
  removeHierarchyNodes,
  releaseGroupNode,
  copyHierarchyNodes,
  moveHierarchyNodes,
  updateHierarchyNode,
  updateSkinPartNodesFlip,
  updateHierarchyNodesAlpha,
  clearHierarchyNodes,
  loadHierarchyNodes,
  updateParamPanelData,
  setAnimatorMode,
  setHitBoxMode,
  bindNodes,
  unbindNodes,
  renameHierarchyNode,
  setEditingNodeId,
  updateHitBoxParamPanelData,
  updateModelPivot,
  loadMotions,
  setActiveMotionId,
  addMotion,
  prependMotions,
  setMotionNodes,
  moveMotion,
  setActiveKeyframes,
  setKeyframesInterpolation,
  moveKeyframes,
  removeKeyframes,
  upsertKeyframes,
  removeMotion,
  copyMotion,
  renameMotion,
  removeMotionsNodes,
} = animatorSlice.actions;

export type AnimatorSlice = typeof animatorSlice.actions;

export type AnimatorActions = ReturnType<AnimatorSlice[keyof AnimatorSlice]>;
