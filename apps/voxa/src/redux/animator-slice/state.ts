import type {
  ChannelNodePath as ChannelNodePathType,
  ProjectInterpolationType as InterpolationType,
  ProjectNodeType as NodeType,
} from '@box/voxa-project';
import {
  ProjectInterpolationType,
  ChannelNodePath,
  ProjectNodeType,
  HitBoxMode,
} from '../../models/project/defs';
import type {
  SerializedMat3,
  SerializedMat4,
  SerializedVec3,
} from '../../utils/math';

export {
  ProjectInterpolationType,
  ChannelNodePathType,
  ChannelNodePath,
  InterpolationType,
  ProjectNodeType,
  NodeType,
  HitBoxMode,
};

export enum AnimatorMode {
  /**
   * 编辑原始模型
   */
  Setup = 'setup',
  /**
   * 编辑动画
   */
  Motion = 'motion',
  /**
   * 编辑物理碰撞框
   */
  HitBox = 'hitBox',
}

export enum PivotMode {
  /**
   * 未开启
   */
  None,
  /**
   * 部件/部件组
   */
  SkinNode,
  /**
   * 整个模型
   */
  Model,
}

export type AnimatorState = {
  /**
   * 动画编辑器当前编辑模式
   */
  mode: AnimatorMode;

  /**
   * 物理碰撞框模式
   */
  hitBoxMode: HitBoxMode;

  /**
   * 当前选中的节点ID
   * 可能是：蒙皮部件ID，部件组ID，骨骼ID
   */
  activeIds: string[];

  /**
   * 根据当前选中的节点ID
   * 解析出来的当前选中的部件ID
   * 其中ID全部都是蒙皮部件ID
   */
  activeSkinPartIds: string[];

  /**
   * 当前为关联状态的节点ID
   */
  relativeIds: string[];

  /**
   * 根据当前的关联节点ID解析出的全部部件ID
   */
  relativeSkinPartIds: string[];

  /**
   * tempGroup的状态记录，用于多选的撤销重做
   * 理论上跟参数面板数据paramPanelData时刻保持一致的
   * 只是会跟随setAnimatorIds action一起被撤销数据
   *
   * 不直接用paramPanelData是因为：参数面板的撤销重做有额外的副作用需处理，比如摄像机位置改变，业务上并不一致
   */
  tempGroupState: ParamPanelData;

  /**
   * 当前hover的部件/部件组/骨骼ID
   * id可以使蒙皮部件ID，也可以是组ID，也可以是骨骼ID
   */
  hoveredId?: string;

  /**
   * 当前鼠标真实hover中的部件/骨骼ID
   * id为部件/骨骼ID
   */
  hoveredObjectId?: string;

  /**
   * 根据当前hover的部件/部件组ID
   * 解析出来的当前hover的部件ID
   * 其中ID全部都是蒙皮部件ID
   */
  hoveredSkinPartIds: string[];

  /**
   * 列表中当前展开的节点ID
   */
  expandedIds: string[];

  /**
   * 工具类型
   * 分为：移动工具，旋转工具
   */
  toolType: ToolType;

  /**
   * 工具轴
   * 分为：世界轴，部件轴
   */
  toolAxis: ToolAxis;

  /**
   * 新增部件模式
   * 分为：3D，2D。新增的2D部件默认为xy平面
   */
  addType: AddType;

  /**
   * 部件中心点（锚点）模式
   */
  pivotMode: PivotMode;

  /**
   * 网格是否可见
   */
  gridVisible: boolean;

  /**
   * 部件盒子是否可见
   */
  boxesVisible: boolean;

  /**
   * 骨骼是否可见
   */
  skeletonVisible: boolean;

  /**
   * 是否显示发光效果
   */
  emissive: boolean;

  /**
   * 模型框是否可见
   */
  modelBoxVisible: boolean;

  /**
   * 部件层级列表数据
   */
  hierarchyData: { [id: string]: HierarchyNode };

  /**
   * 参数面板数据
   */
  paramPanelData: ParamPanelData;

  /**
   * 当前选中的动作
   */
  activeMotionId: string;

  /**
   * 动作数据
   */
  motionData: MotionData;

  /**
   * 正在编辑名称的节点ID
   */
  editingNodeId?: string;

  /**
   * 选中的关键帧数据集合
   * 各个节点的选中数据分别记录，记录关键帧的时间点
   */
  activeKeyframes: NodeKeyframeIds;

  /**
   * 物理编辑框的参数面板数据
   */
  hitBoxParamPanelData?: HitBoxParamPanelData;
  /**
   * 模型的轴心（锚点）
   */
  modelPivot: SerializedVec3;
};

export enum ToolType {
  Translate,
  Rotate,
  Scale,
}

export type HierarchyData = Record<string, HierarchyNode>;

export type ToolAxis = 'world' | 'local';
export type AddType = 'object3d' | 'object2d';
export enum FlipAxis {
  X,
  Y,
  Z,
}

export type DropType = 'top' | 'bottom' | 'box';

export interface UpdateNodeData {
  name: string;
  voxelId: string;
}

export interface AddHierarchyNode {
  idx: number;
  newNode: HierarchyNode;
}

export interface MoveHierarchyNodes {
  moveIds: string[];
  dropTargetId: string;
  dropType: DropType;
}

export interface CopyHierarchyNode {
  newNode: HierarchyNode;
  sourceNodeId: string;
  newChildrenNodes?: { [id: string]: HierarchyNode };
}

export interface RemoveHierarchyNode {
  node: HierarchyNode;
  children: { [id: string]: HierarchyNode };
}

export interface ParamPanelData {
  /**
   * 当前选中部件的轴心，不显示在参数面板，供撤销重做使用。
   */
  pivot: SerializedVec3;
  /**
   * 当前选中部件的体素透明度。
   */
  opacity: number;
  /**
   * 当前选中部件相对于父级的坐标
   */
  position: SerializedVec3;
  /**
   * 当前选中部件在世界坐标系中的坐标
   */
  worldPosition: SerializedVec3;
  /**
   * 当前选中部件的旋转角度
   */
  rotation: SerializedVec3;
  /**
   * 当前选中部件相对于世界坐标系的欧拉角旋转
   */
  worldRotation: SerializedVec3;
  /**
   * 缩放
   */
  scale: SerializedVec3;
  /**
   * 当前选中部件的世界轴缩放，不显示在参数面板，供撤销重做使用
   */
  parentScaleMat3: SerializedMat3;
}

export interface HitBoxParamPanelData {
  /**
   * 物理碰撞框位置
   */
  position: SerializedVec3;
  /**
   * 物理碰撞框尺寸
   */
  size: SerializedVec3;
}

export type HierarchyNode =
  | RootHierarchyNode
  | GroupHierarchyNode
  | BoneHierarchyNode
  | SkinPartHierarchyNode;

interface BaseHierarchyNode {
  /**
   * 当前节点ID
   */
  id: string;
  /**
   * 当前节点类型
   */
  type: NodeType;
  /**
   * 当前节点名字
   */
  name: string;
  /**
   * 父节点ID
   * 如无父节点则为根节点/绑定了骨骼的部件节点
   */
  parentId?: string;
  /**
   * 子节点ID
   * 如无子节点，则为部件节点
   */
  childrenIds?: string[];
}

export interface RootHierarchyNode extends BaseHierarchyNode {
  type: NodeType.Root;
  childrenIds: string[];
}

export interface GroupHierarchyNode extends BaseHierarchyNode {
  type: NodeType.Group;
  childrenIds: string[];
  /**
   * 部件组绑定的骨骼id。
   */
  boneId?: string;
}

export interface BoneHierarchyNode extends BaseHierarchyNode {
  type: NodeType.Bone;
  parentId: string;
  childrenIds: string[];
  /**
   * 骨骼绑定的部件/部件组id。
   */
  skinId?: string;
  /**
   * 透明度。
   */
  alpha: number;
}

export interface SkinPartHierarchyNode extends BaseHierarchyNode {
  type: NodeType.SkinPart;
  /**
   * 部件/部件组绑定的骨骼id。
   */
  boneId?: string;
  /**
   * 部件对应的体素ID
   * 默认作品中的部件节点可能没有体素ID
   */
  voxelId?: string;
  /**
   * 部件的翻转信息。
   */
  flip: SerializedVec3;
  /**
   * 部件透明度。
   * 根结点、组节点没有透明度。
   */
  alpha: number;
}

/**
 * 动画
 */
export type MotionData = {
  /**
   * 动作id数组，用于确定排列顺序
   */
  motionIds: string[];
  /**
   * 动作的数据
   */
  motions: Record<string, Motion>;
};

/**
 * 一个动作的动画数据
 * 由多个节点的动画组成
 */
export interface Motion {
  id: string;
  name: string;
  /**
   * 动作节点
   * id为骨骼节点的id
   */
  nodes: Record<string, MotionNode>;
}

/**
 * 关键帧信息
 * 包含时间、节点的TRA
 */
export interface MotionKeyframe extends KeyframeData {
  /**
   * id不是索引，用于确认是相同的item
   */
  id: string;
  /**
   * 指向上一个关键帧
   */
  prevTime?: number;
  /**
   * 指向下一个关键帧
   */
  nextTime?: number;
}

/**
 * 关键帧的数据部分
 */
export type KeyframeData = {
  time: number;
  interpolation: InterpolationType;
  offset: KeyframeOffset;
};

export type KeyframeOffset = {
  /**
   * 透明度偏移
   */
  alpha: number;
  /**
   * 旋转位移矩阵偏移
   */
  matrix: SerializedMat4;
};

export type MotionNode = {
  /**
   * 节点Id
   */
  nodeId: string;
  /**
   * 关键帧数据字典，以关键帧的时间点为key。
   * 首个关键帧索引必定是'0'
   */
  keyframes: Record<string, MotionKeyframe>;
};

/**
 * 动作节点字典
 */
export type MotionNodes = Record<string, MotionNode>;

/**
 * 关键帧字典
 */
export type MotionKeyframes = Record<string, MotionKeyframe>;

/**
 * 增加动作
 */
export type AddMotionData = {
  id: string;
  name: string;
};

export type SetMotionNodesData = {
  motionId: string;
  nodes: MotionNode[];
};

/**
 * 以节点id为key，以T的数组为value的字典结构
 */
export type NodeDict<T> = Record<string, T[]>;

/**
 * 以nodeId为key，关键帧id数组为value的字典。
 * 记录选中的关键帧等场景会使用这个数据结构。
 */
export type NodeKeyframeIds = NodeDict<string>;

/**
 * 以nodeId为key，关键帧数组为value的字典。
 * 记录选中的关键帧等场景会使用这个数据结构。
 */
export type NodeKeyframes = NodeDict<MotionKeyframe>;
