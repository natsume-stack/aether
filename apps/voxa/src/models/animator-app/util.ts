import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import {
  ProjectNodeType,
  MotionKeyframe,
  AnimatorMode,
  HierarchyNode,
  ToolType,
} from '../../redux/animator-slice';
import {
  Uint8Vec3Schema,
  Vec3Schema,
  Vec4Schema,
  NodeSchema,
  Mat3Schema,
} from '../project/defs';
import type { ProjectNode } from '../project/interfaces';
import type { Object3D } from '../rendering/objects/object3d';
import type { SkinPart } from '../skin-part';
import type { BoneNode } from '../bone';
import { store } from '../../redux/store';
import { getEuler } from '../rendering/math/quat';
import { Box3 } from '../rendering/math/box3';
import {
  serializeQuat,
  serializeVec3,
  serializeMat3,
  SerializedVec3,
} from '../../utils/math';
import { ROOT_BONE_ID, ROOT_ID, ROOT_SKIN_ID } from '../../defs';
import { AppMode, EditType } from '../../redux/app-slice';
import { invertMat4ScaleRight, mat4SetFromMat3 } from '../rendering/utils/math';
import type { SkinNode } from './node-manager/interface';

const TEMP_VEC3 = vec3.create();
const TEMP_MAT4 = mat4.create();
const TEMP_MAT3 = mat3.create();
const TEMP_MAT3_2 = mat3.create();
const TEMP_QUAT = quat.create();
const TEMP_INVERT = mat4.create();
const TEMP_BOX = new Box3();
const TEMP_POS = vec3.create();

/**
 * 设计规定的渲染顺序
 * 由于透明物体深度检测有问题 https://box3.yuque.com/staff-khn556/engine/lfsk72
 * 需要通过设置类似z-index的方式规定不同层级物体的渲染顺序
 */
export enum RenderOrder {
  /**
   * 地面的半透明网格
   */
  grid = 1,
  /**
   * 骨头节点（圆环）以及骨骼段🦴
   * 位于半透明网格的上层
   */
  bone = 2,
}

export enum ModelUnitType {
  skinPart,
  bone,
}

export function isSkinPart(object3d: Object3D): object3d is SkinPart {
  return (object3d as SkinPart).modelUnitType === ModelUnitType.skinPart;
}

export function isBoneNode(object3d: Object3D): object3d is BoneNode {
  return (object3d as BoneNode).modelUnitType === ModelUnitType.bone;
}

/**
 * 获取根目录/指定根节点下的父节点ID
 * 如果当前部件已在根目录/指定的根节点下，则返回他自己的ID
 * @param currId 当前ID
 * @param rootIds 指定的根节点ID，默认为根目录ROOT_ID
 * @returns 根目录/指定根节点下的父节点ID
 */
export function getRootParentId(currId: string, rootIds?: string[]) {
  const { hierarchyData } = store.getState().animator;

  const isAtRoot = (id: string | undefined) =>
    !id || isRootNode(id) || rootIds?.includes(id);

  let parentId: string | undefined = currId;
  while (parentId && !isAtRoot(hierarchyData[parentId].parentId)) {
    parentId = hierarchyData[parentId].parentId;
  }

  return parentId;
}

/**
 * 通过某部件/部件组的ID，获取其绑定的骨骼节点ID
 * @param skinId 部件/部件组ID
 * @returns
 */
export function getBoneIdBySkinId(skinId: string) {
  const { hierarchyData } = store.getState().animator;
  const node = hierarchyData[skinId];
  if (
    !node ||
    node.type === ProjectNodeType.Root ||
    node.type === ProjectNodeType.Bone
  ) {
    return;
  }

  return node.boneId;
}

/**
 * 这一批ID中是否有已绑定骨骼的部件/部件组
 * @param ids 一批ID
 * @returns 是/否
 */
export function hasBoundSkin(ids: string[]) {
  for (let i = 0; i < ids.length; i++) {
    const boneId = getBoneIdBySkinId(ids[i]);
    if (boneId) {
      return true;
    }
  }
  return false;
}

/**
 * 通过骨骼节点ID获取其绑定的部件/部件组ID
 * @param boneId 骨骼ID
 * @returns 部件/部件组ID
 */
export function getSkinIdByBoneId(boneId: string) {
  const { hierarchyData } = store.getState().animator;
  const node = hierarchyData[boneId];
  if (!node || node.type !== ProjectNodeType.Bone) {
    return;
  }
  return node.skinId;
}

/**
 * ID中是否包含 没有绑定部件/部件组 的骨骼节点
 */
export function hasBoneWithoutSkin(ids: string[]) {
  const { hierarchyData } = store.getState().animator;
  for (let i = 0; i < ids.length; i++) {
    const node = hierarchyData[ids[i]];
    if (node.type === ProjectNodeType.Bone && !node.skinId) {
      return true;
    }
  }
  return false;
}

/**
 * 获取当前节点的面包屑路径
 * 就是父节点集合
 * 不含root/root skin/root bone
 * @param id 当前节点ID
 * @returns 面包屑路径
 */
export function getBreadcrumbs(id: string) {
  const { hierarchyData } = store.getState().animator;
  const breadcrumbs: string[] = [];

  let parentId = hierarchyData[id].parentId;
  while (parentId && !isRootNode(parentId)) {
    breadcrumbs.push(parentId);
    parentId = hierarchyData[parentId].parentId;
  }

  return breadcrumbs;
}

export function parseSkinParts(
  out: string[],
  ids: string[],
  condition?: (id: string) => boolean,
) {
  const { hierarchyData } = store.getState().animator;

  ids.forEach((id) => {
    const node = hierarchyData[id];
    if (node && node.childrenIds) {
      parseSkinParts(out, node.childrenIds, condition);
      return;
    }
    if (node.type === ProjectNodeType.SkinPart) {
      condition ? condition(id) && out.push(id) : out.push(id);
    }
  });
}

/**
 * 解析骨骼的子节点，获得relativeIds和relativeSkinPartIds
 */
function parseRelative(
  out: { relativeIds: string[]; relativeSkinPartIds: string[] },
  childrenIds: string[],
  isActive: (id: string) => boolean,
) {
  const { relativeIds, relativeSkinPartIds } = out;
  const { hierarchyData } = store.getState().animator;
  childrenIds.forEach((id) => {
    const node = hierarchyData[id];
    // 排除已选中的骨骼
    if (!node || node.type !== ProjectNodeType.Bone || isActive(id)) {
      return;
    }
    // 子骨骼是关联节点
    relativeIds.push(id);
    if (node.skinId && !isActive(node.skinId)) {
      // 解析关联骨骼绑定的部件
      parseSkinParts(relativeSkinPartIds, [node.skinId], (id) => !isActive(id));
    }
    // 骨骼的所有子骨骼都是关联状态
    if (node.childrenIds) {
      parseRelative(
        { relativeIds, relativeSkinPartIds },
        node.childrenIds,
        isActive,
      );
    }
  });
}

export const parseActiveIds = (ids: string[]) => {
  const { hierarchyData } = store.getState().animator;

  const activeSkinPartIds: string[] = [];
  const relativeIds: string[] = [];
  const relativeSkinPartIds: string[] = [];

  const parsedSkinPartIds = new Set<string>();

  // 先解析activeSkinPartIds
  const boneIds: string[] = [];
  ids.forEach((id) => {
    const node = hierarchyData[id];
    if (!node) {
      return;
    }

    /**
     * - 非骨骼节点，作为activeSkinPartIds解析入口
     * - 骨骼节点，取绑定的皮肤作为activeSkinPartIds
     */
    let parseEntryId: string | undefined;

    if (node.type !== ProjectNodeType.Bone) {
      parseEntryId = node.id;
    } else {
      boneIds.push(id);

      parseEntryId = node.skinId;
    }

    if (!parseEntryId || parsedSkinPartIds.has(parseEntryId)) {
      return;
    }

    parsedSkinPartIds.add(parseEntryId);

    parseSkinParts(activeSkinPartIds, [parseEntryId]);
  });

  // 最后解析已选中骨骼的relativeIds，relativeSkinPartIds
  boneIds.forEach((boneId) => {
    const node = hierarchyData[boneId];
    if (!node || node.type !== ProjectNodeType.Bone) {
      return;
    }
    parseRelative(
      { relativeIds, relativeSkinPartIds },
      node.childrenIds,
      (id) => ids.includes(id) || activeSkinPartIds.includes(id),
    );
  });

  return {
    activeSkinPartIds,
    relativeIds,
    relativeSkinPartIds,
  };
};

export function getActiveBoneIds(activeIds: string[]) {
  const { hierarchyData } = store.getState().animator;
  const activeBoneIds: string[] = [];
  activeIds.forEach((id) => {
    if (hierarchyData[id].type === ProjectNodeType.Bone) {
      activeBoneIds.push(id);
    }
  });
  return activeBoneIds;
}

/**
 * 从指定节点开始往下遍历。深度优先。
 * @param nodeId 遍历的起点
 * @param callback 针对节点执行的操作。该操作返回值用于判断是否继续遍历。
 */
export function everyNode<T extends { id: string; childrenIds?: string[] }>(
  nodeId: string,
  sourceData: { [id: string]: T },
  callback: (nodeData: T) => boolean,
) {
  const list: string[] = [nodeId];

  while (list.length > 0) {
    const curNodeId = list.shift();

    const nodeData = curNodeId ? sourceData[curNodeId] : undefined;

    if (!nodeData) {
      continue;
    }

    const toContinue = callback(nodeData);

    if (!toContinue) {
      break;
    }

    if (!nodeData.childrenIds || nodeData.childrenIds.length === 0) {
      continue;
    }

    /**
     * 因为是unshift，所以反向遍历存入childId。
     */
    for (let i = nodeData.childrenIds.length - 1; i >= 0; i--) {
      const childId = nodeData.childrenIds[i];

      list.unshift(childId);
    }
  }
}

/**
 * 根据新插入的父级matrix数据
 * 保持子组件世界坐标位置不变
 * 重新设置子组件的相对坐标
 * @param parentMatrix 父级matrix
 * @param child 任意子组件
 */
export function resetObjTransform(parentMatrix: mat4, child: Object3D) {
  mat4.invert(TEMP_INVERT, parentMatrix);
  mat4.mul(TEMP_MAT4, TEMP_INVERT, child.matrixWorld);
  setObjFromMatrix(child, mat4.clone(TEMP_MAT4));

  // 处理欧拉角数值
  getEuler(child.rotateAngles, child.quaternion);
}

/**
 * 从Box3的expandByObject改编而来，专门给makeNewGroup使用
 * 由于makeNewGroup在计算newGroup的local position的时候需要刨除newGroup本身的matrix影响
 * 所以计算最小立方体的时候需要刨除newGroup matrixWorld的影响
 * 跟原版方法只差了一个：applyMatrix4前需要mul一个invertMatrix
 * @param box3
 * @param obj
 * @param invertMatrix
 */
function expandByObjectMulInvertMatrix(
  box3: Box3,
  obj: Object3D,
  invertMatrix: mat4,
) {
  obj.updateWorldMatrix(false, false);

  const geometry = obj.geometry;

  if (geometry) {
    if (!geometry.boundingBox) {
      geometry.boundingBox = geometry.computeBoundingBox();
    }
    const tempBox = new Box3();
    tempBox.copy(geometry.boundingBox);
    mat4.mul(TEMP_MAT4, invertMatrix, obj.matrixWorld);
    tempBox.applyMatrix4(TEMP_MAT4);

    box3.union(tempBox);
  }

  const children = obj.children;

  for (let i = 0, l = children.length; i < l; i++) {
    expandByObjectMulInvertMatrix(box3, children[i], invertMatrix);
  }
}

const INVERT_MAT4 = mat4.create();
export function makeNewGroup(
  newGroup: Object3D,
  childrenIds: string[],
  getObj: (id: string) => Object3D | undefined,
) {
  TEMP_BOX.makeEmpty();
  newGroup.updateMatrixWorld();
  mat4.invert(INVERT_MAT4, newGroup.matrixWorld);
  childrenIds.forEach((id) => {
    const obj = getObj(id);
    if (!obj) {
      return;
    }
    expandByObjectMulInvertMatrix(TEMP_BOX, obj, INVERT_MAT4);
  });

  TEMP_BOX.getCenter(TEMP_VEC3);
  vec3.add(newGroup.position, newGroup.position, TEMP_VEC3);
  newGroup.updateMatrixWorld();

  childrenIds.forEach((id) => {
    const obj = getObj(id);
    if (!obj) {
      return;
    }

    mat4.invert(TEMP_INVERT, newGroup.matrixWorld);
    mat4.mul(TEMP_MAT4, TEMP_INVERT, obj.matrixWorld);
    setObjFromMatrix(obj, mat4.clone(TEMP_MAT4));

    newGroup.add(obj);
  });
}
/**
 * 默认obj.scale和obj.pivot不改动
 * 通过输入的matrix来设置obj的parentScaleMat3，quaternion，position
 * 仅用于打组解组功能
 * @param obj object3D
 * @param matrix mat4
 */
function setObjFromMatrix(obj: Object3D, matrix: mat4) {
  /**
   * obj.parentScaleMat3 x obj.getRTSMatrix = matrix;
   * 先计算出obj.RSMat3
   *
   * 通过obj.RSMat3计算出obj.parentScaleMat3
   * 通过obj.parentScaleMat3计算出obj.getRTSMatrix
   * 通过obj.getRTSMatrix给obj.quaternion，obj.position赋值
   */

  // 拆解parentScaleMat3

  // 生成「世界quat x 本部件scale」，这个数据 TEMP_MAT3 即为 obj.RSMat3
  invertMat4ScaleRight(TEMP_MAT4, matrix, obj.scale);
  mat4.getRotation(TEMP_QUAT, TEMP_MAT4);
  mat3.fromQuat(TEMP_MAT3, TEMP_QUAT);
  mat3.mul(
    TEMP_MAT3,
    TEMP_MAT3,
    mat3.fromValues(obj.scale[0], 0, 0, 0, obj.scale[1], 0, 0, 0, obj.scale[2]),
  );

  // obj.parentScaleMat3 x obj.getRTSMatrix = matrix
  // obj.parentScaleMat3 = mat3Matrix x invert obj.RSMat3;
  mat3.invert(TEMP_MAT3, TEMP_MAT3);
  mat3.fromMat4(TEMP_MAT3_2, matrix);
  mat3.mul(obj.parentScaleMat3, TEMP_MAT3_2, TEMP_MAT3);

  // obj.parentScaleMat3 x obj.getRTSMatrix = matrix;
  // obj.getRTSMatrix = invert obj.parentScaleMat3 x matrix;
  // TEMP_MAT4 即为 obj.getRTSMatrix
  mat4SetFromMat3(TEMP_INVERT, obj.parentScaleMat3);
  mat4.invert(TEMP_INVERT, TEMP_INVERT);
  mat4.mul(TEMP_MAT4, TEMP_INVERT, matrix);

  // 拆解RTS
  mat4.getScaling(obj.scale, TEMP_MAT4);
  invertMat4ScaleRight(TEMP_MAT4, TEMP_MAT4, obj.scale);

  mat4.getRotation(obj.quaternion, TEMP_MAT4);

  // 处理中心点带来的位置偏移
  obj.getTransformedPivot(TEMP_VEC3);

  mat4.getTranslation(obj.position, TEMP_MAT4);
  vec3.sub(obj.position, obj.position, TEMP_VEC3);
}

/**
 * 每秒能设置的最多的关键帧数量
 */
export const KEYFRAME_PER_SEC = 24;

/**
 * 关键帧的时间间隔
 */
export const KEYFRAME_STEP = 1 / KEYFRAME_PER_SEC;

/**
 * 关键帧的最大时间点（单位秒）
 */
export const MAX_KEYFRAME_TIME = 60;

/**
 * 时间转换成帧。
 * @param time 时间，以秒为单位
 */
export function timeToFrame(time: number): number {
  return Math.round(time / KEYFRAME_STEP);
}

/**
 * 帧数转换为时间
 */
export function frameToTime(frame: number): number {
  return frame * KEYFRAME_STEP;
}

export function everyKeyframe(
  time: number,
  dict: Record<string, MotionKeyframe>,
  callback: (motionItem: MotionKeyframe) => boolean,
  /**
   * 是否反向（沿着prevTime）遍历
   * @default false
   */
  reverse: boolean = false,
): boolean {
  let item = dict[time];

  const pickTime = reverse
    ? (item: MotionKeyframe) => item.prevTime
    : (item: MotionKeyframe) => item.nextTime;

  while (item) {
    const newTime = pickTime(item);

    if (!callback(item) || newTime === undefined) {
      return false;
    }

    item = dict[newTime];
  }

  return true;
}

/**
 * 获得指定节点的所有子孙节点。
 * 返回的id数组不包括节点自身。
 */
export function getNodeDescendants(nodeId: string) {
  const { hierarchyData } = store.getState().animator;
  const descendants: string[] = [];
  everyNode(nodeId, hierarchyData, ({ id }) => {
    descendants.push(id);

    return true;
  });
  descendants.shift();
  return descendants;
}

/**
 * 获取节点的面包屑路径，包含父节点绑定的骨骼（如果有）的面包屑路径
 */
export function getBreadcrumbsWithBone(id: string) {
  const { hierarchyData } = store.getState().animator;

  const breadcrumbs = getBreadcrumbs(id);

  const topParentId = breadcrumbs[breadcrumbs.length - 1] || id;
  const topParent = hierarchyData[topParentId];
  if (
    (topParent.type === ProjectNodeType.Group ||
      topParent.type === ProjectNodeType.SkinPart) &&
    topParent.boneId
  ) {
    breadcrumbs.push(...getBreadcrumbs(topParent.boneId));
  }

  return breadcrumbs;
}

/**
 * 获得当前选中的节点中，位于列表最上方的节点ID
 */
export function getTopSelectedId() {
  const { activeIds, hierarchyData } = store.getState().animator;
  let topId: string | undefined;
  everyNode(ROOT_ID, hierarchyData, ({ id }) => {
    if (activeIds.includes(id)) {
      topId = id;
      return false;
    }
    return true;
  });
  return topId;
}

export function isRootNode(id: string) {
  // TODO: 没明白为啥root skin和root bone的type不是Root？
  // 如果要修改的话需要改下数据迁移
  return [ROOT_ID, ROOT_SKIN_ID, ROOT_BONE_ID].includes(id);
}

// 动作数量有限制
export const MAX_MOTION_LENGTH = 100;

export function isControllerVisible(mode: AnimatorMode, activeIds: string[]) {
  if (!activeIds.length) {
    return false;
  }

  const { motionPanel } = store.getState().app;

  const { toolAxis, toolType } = store.getState().animator;

  /**
   * - 世界轴下不显示缩放轴
   * - 动画模式下多选时，也不显示缩放轴
   */
  if (
    toolType === ToolType.Scale &&
    (toolAxis === 'world' ||
      (mode === AnimatorMode.Motion && activeIds.length > 1))
  ) {
    return false;
  }

  return !motionPanel.playing;
}

/**
 * 通过store的node数据和舞台组件object3D构造project数据
 * @param node store数据
 * @param getObj 通过id获取obj的方法
 * @returns
 */
export function getProjectNode(
  node: HierarchyNode,
  getObj: (id: string) => Object3D | undefined,
): ProjectNode | undefined {
  const { id, name, childrenIds, parentId } = node;
  if (isRootNode(id)) {
    return getRootProjectNode(node);
  }

  const obj = getObj(id);

  if (!obj) {
    return;
  }

  const partNode = NodeSchema.clone(NodeSchema.identity);

  partNode.quaternion = Vec4Schema.fromJSON(serializeQuat(obj.quaternion));
  partNode.position = Vec3Schema.fromJSON(serializeVec3(obj.position));
  partNode.pivot = Vec3Schema.fromJSON(serializeVec3(obj.pivot));
  partNode.euler = Vec3Schema.fromJSON(serializeVec3(obj.rotateAngles));
  partNode.scale = Vec3Schema.fromJSON(serializeVec3(obj.scale));
  partNode.parentScaleMat3 = Mat3Schema.fromJSON(
    serializeMat3(obj.parentScaleMat3),
  );

  partNode.id = id;
  partNode.name = name;
  partNode.type = node.type;
  partNode.alpha =
    node.type === ProjectNodeType.Bone || node.type === ProjectNodeType.SkinPart
      ? node.alpha
      : 1;

  if (node.type === ProjectNodeType.SkinPart) {
    // 不记录undefined数据
    if (node.voxelId) {
      partNode.voxelId = node.voxelId;
    }
    partNode.flip = Uint8Vec3Schema.fromJSON(node.flip);
  }

  if (
    (node.type === ProjectNodeType.SkinPart ||
      node.type === ProjectNodeType.Group) &&
    node.boneId
  ) {
    partNode.boneId = node.boneId;
  }

  if (node.type === ProjectNodeType.Bone && node.skinId) {
    partNode.skinId = node.skinId;
  }

  if (parentId) {
    partNode.parentId = parentId;
  }

  if (childrenIds) {
    partNode.childrenIds = childrenIds;
  }

  return partNode;
}

/**
 * 通过store的node数据构造根节点的project数据
 * @param node node数据
 * @returns
 */
function getRootProjectNode(node: HierarchyNode) {
  const { id, name, childrenIds } = node;

  if (id === ROOT_ID) {
    const root = NodeSchema.clone(NodeSchema.identity);
    root.id = id;
    root.name = name;
    root.type = ProjectNodeType.Root;
    root.childrenIds = childrenIds || [];

    return root;
  }

  if (id === ROOT_SKIN_ID) {
    const rootSkin = NodeSchema.clone(NodeSchema.identity);
    rootSkin.id = id;
    rootSkin.name = name;
    rootSkin.type = ProjectNodeType.Group;
    rootSkin.parentId = ROOT_ID;
    rootSkin.childrenIds = childrenIds || [];

    return rootSkin;
  }

  if (id === ROOT_BONE_ID) {
    const rootBone = NodeSchema.clone(NodeSchema.identity);
    rootBone.id = id;
    rootBone.name = name;
    rootBone.type = ProjectNodeType.Bone;
    rootBone.parentId = ROOT_ID;
    rootBone.childrenIds = childrenIds || [];

    return rootBone;
  }
}

/**
 * 获取当前骨骼是否是可交互的
 * 产品规定：
 * 1. 普通编辑模式下的中心点模式，骨骼不可交互
 * 2. 定向创作之皮肤编辑模式，骨骼不可交互
 * 3. 物理编辑模式，骨骼不可交互
 * @returns 骨骼是否可交互
 */
export function isBonesInteractive() {
  const { app, animator } = store.getState();
  return (
    app.editType !== EditType.Skin &&
    !animator.pivotMode &&
    animator.mode !== AnimatorMode.HitBox
  );
}
/**
 * 获取当前部件是否是可交互的
 * 产品规定：
 * 编辑模式可交互，动画模式和物理编辑模式都不可交互
 * @returns 部件是否可交互
 */
export function isSkinPartInteractive() {
  return store.getState().animator.mode === AnimatorMode.Setup;
}

export function filterNotInteractiveNode(ids: string[]) {
  const { hierarchyData, mode } = store.getState().animator;

  if (mode === AnimatorMode.HitBox) {
    return [];
  }

  return ids.filter((id) => {
    const node = hierarchyData[id];

    if (
      node.type === ProjectNodeType.SkinPart ||
      node.type === ProjectNodeType.Group
    ) {
      return isSkinPartInteractive();
    }

    if (node.type === ProjectNodeType.Bone) {
      return isBonesInteractive();
    }

    return true;
  });
}

/**
 * 模型是否发光
 * @returns 是否发光
 */
export function isSkinPartEmissive() {
  // 在体素模式/物理模式中，模型不发光
  const { app, animator } = store.getState();
  if (app.mode === AppMode.Voxel || animator.mode === AnimatorMode.HitBox) {
    return false;
  }

  return animator.emissive;
}

export type GetDefaultBounds = (skinNodes?: SkinNode[]) => {
  bounds: SerializedVec3;
  boundsCenter: SerializedVec3;
  rootPartOffset: SerializedVec3;
};

/**
 * 本地坐标转换到世界坐标
 * @param out 输出结果
 * @param obj 3d物体
 * @param localPos 本地坐标
 */
export function localToWorld(out: vec3, obj: Object3D, localPos: vec3) {
  // 计算中心点偏移量
  mat3.fromMat4(TEMP_MAT3, obj.matrixWorld);
  vec3.transformMat3(out, localPos, TEMP_MAT3);

  // 获取世界坐标位置，减去中心点偏移量
  mat4.getTranslation(TEMP_POS, obj.matrixWorld);
  vec3.sub(out, TEMP_POS, out);

  return out;
}

/**
 * 世界坐标位置转换到本地坐标
 * @param out 输出结果
 * @param obj 3d物体
 * @param worldPos 世界坐标
 */
export function worldToLocal(out: vec3, obj: Object3D, worldPos: vec3) {
  mat4.getTranslation(TEMP_POS, obj.matrixWorld);
  mat3.fromMat4(TEMP_MAT3, obj.matrixWorld);

  vec3.sub(out, TEMP_POS, worldPos);

  mat3.invert(TEMP_MAT3, TEMP_MAT3);
  vec3.transformMat3(out, out, TEMP_MAT3);

  return out;
}
