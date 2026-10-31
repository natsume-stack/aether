import { mat4, quat, vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';
import type {
  ProjectAnimations,
  ProjectNodes,
  ProjectNode,
  ProjectHitBox,
  Vec3SchemaType,
} from '../project/interfaces';
import type { NodeManager } from './node-manager';

import {
  loadMotions,
  Motion,
  MotionKeyframe,
  MotionKeyframes,
  MotionNode,
  HierarchyData,
  loadHierarchyNodes,
  ProjectNodeType,
  HierarchyNode,
  addNewHierarchyNodes,
  prependMotions,
  RemoveHierarchyNode,
  setHitBoxMode,
  updateHitBoxParamPanelData,
  updateModelPivot,
} from '../../redux/animator-slice';

import { store } from '../../redux/store';
import { serializeMat4, serializeVec3 } from '../../utils/math';
import { everyNode, GetDefaultBounds } from './util';
import { ROOT_ID } from '../../defs';
import { IDENTITY_SCALE } from '../rendering/controls/transform/def';
import type { EditingHistory } from '../editing-history';
import { Scene } from '../rendering/objects/scene';
import { Vec3Schema } from '../project/defs';

const TEMP_MAT = mat4.create();
const IDENTITY_VEC3 = vec3.create();
const IDENTITY_QUAT = quat.create();

export class Loader {
  constructor(
    private nodeManager: NodeManager,
    private history: EditingHistory,
    private scene: Scene,
    private getDefaultBounds: GetDefaultBounds,
  ) {
    this.history.registerActionCallback(
      'addNewHierarchyNodes',
      (payload, isForward) => {
        if (!isForward) {
          const removePayload: RemoveHierarchyNode[] = [];

          Object.values(payload).forEach((node) => {
            removePayload.push({
              node,
              children: {},
            });
          });

          this.nodeManager.removeNodes(
            Object.keys(payload),
            false,
            removePayload,
          );

          return;
        }

        Object.keys(payload).forEach((nodeId) =>
          this.nodeManager.restoreNode(nodeId),
        );
      },
    );
  }

  /**
   * 批量加载新的工程节点数据
   */
  public addNewNodesData(nodes: ProjectNode[], saveRecord: boolean) {
    const newHierarchyNodes = this.addNewNodes(nodes);

    this.history.saveAction({
      action: addNewHierarchyNodes(newHierarchyNodes),
      saveRecord,
    });
  }

  /**
   * 批量增加新的节点
   * @param nodeList 工程节点数组
   * @returns 新的节点的store数据
   */
  private addNewNodes(nodeList: ProjectNode[]) {
    const newHierarchyData: HierarchyData = {};

    nodeList.forEach((node) => {
      this.loadNode(newHierarchyData, node);
    });

    return newHierarchyData;
  }
  /**
   * 根据工程节点数据加载部件/部件组/骨骼
   * @param nodes 工程节点数据
   */
  public loadNodesData(nodes: ProjectNodes) {
    const nodeData: HierarchyData = {};
    this.loadNodes(nodeData, nodes);
    store.dispatch(loadHierarchyNodes(nodeData));
  }

  /**
   * 通过工程节点数据加载舞台，并生成store节点数据
   * @param out 输出的store节点数据
   * @param nodes 工程节点数据
   */
  private loadNodes(out: HierarchyData, nodes: ProjectNodes) {
    everyNode(ROOT_ID, nodes, (node) => {
      this.loadNode(out, node);
      // 加载骨骼绑定的蒙皮
      if (node.type === ProjectNodeType.Bone && node.skinId) {
        everyNode(node.skinId, nodes, (skinNode) => {
          this.loadNode(out, skinNode);
          return true;
        });
      }
      return true;
    });
  }

  private loadNode(out: HierarchyData, node: ProjectNode) {
    const storeNode = this.getStoreNode(node);
    if (!storeNode) {
      return;
    }
    out[storeNode.id] = storeNode;
    const currObj = this.nodeManager.loadObj(node);
    const parent = this.nodeManager.getParentOrBoneByNodeId(node.id, out);
    if (!parent || !currObj) {
      return;
    }

    parent.add(currObj);
    this.nodeManager.setModelUnit(currObj);
  }

  private getStoreNode(projectNode: ProjectNode): HierarchyNode | undefined {
    const { id, type, name, childrenIds } = projectNode;
    if (type === ProjectNodeType.Root) {
      return {
        id,
        type,
        name,
        childrenIds,
      };
    }

    if (type === ProjectNodeType.Bone) {
      const { parentId, skinId, alpha } = projectNode;
      return {
        id,
        type,
        name,
        parentId,
        childrenIds,
        skinId: skinId || undefined,
        alpha,
      };
    }

    if (type === ProjectNodeType.Group) {
      const { parentId, boneId } = projectNode;
      return {
        id,
        type,
        name,
        childrenIds,
        parentId: parentId || undefined,
        boneId: boneId || undefined,
      };
    }

    if (type === ProjectNodeType.SkinPart) {
      const { parentId, boneId, voxelId, alpha, flip } = projectNode;
      const [x, y, z] = flip;

      return {
        id,
        type,
        name,
        alpha,
        flip: [x, y, z],
        parentId: parentId || undefined,
        boneId: boneId || undefined,
        voxelId: voxelId || undefined,
      };
    }
  }

  private parseMotions(animations: ProjectAnimations) {
    const motions: Record<string, Motion> = {};
    const motionIds: string[] = [];

    const { hierarchyData } = store.getState().animator;

    animations.forEach(({ id, name, nodes }) => {
      const motion: Motion = {
        id,
        name,
        nodes: {},
      };

      Object.values(nodes).forEach(({ nodeId, keyframeList }) => {
        // 如果节点不存在于当前节点树，不需要解析
        if (!hierarchyData[nodeId]) {
          return;
        }

        const motionNode: MotionNode = {
          nodeId,
          keyframes: {},
        };

        motionNode.keyframes = keyframeList.reduce<MotionKeyframes>(
          (newKeyframes, { time, interpolation, offset }, idx) => {
            const translation = offset.translation
              ? offset.translation
              : IDENTITY_VEC3;
            const rotation = offset.rotation ? offset.rotation : IDENTITY_QUAT;
            const scale = offset.scale ? offset.scale : IDENTITY_SCALE;

            mat4.fromRotationTranslationScale(
              TEMP_MAT,
              rotation,
              translation,
              scale,
            );

            const newKeyframe: MotionKeyframe = {
              id: nanoid(),
              time: Number(time),
              interpolation,
              offset: {
                matrix: serializeMat4(TEMP_MAT),
                alpha: offset.alpha !== undefined ? offset.alpha : 0,
              },
            };

            const prevItem = keyframeList[idx - 1];
            const nextItem = keyframeList[idx + 1];

            if (prevItem) {
              newKeyframe.prevTime = Number(prevItem.time);
            }
            if (nextItem) {
              newKeyframe.nextTime = Number(nextItem.time);
            }

            newKeyframes[newKeyframe.time] = newKeyframe;

            return newKeyframes;
          },
          {},
        );

        motion.nodes[nodeId] = motionNode;
      });

      motions[id] = motion;

      motionIds.push(id);
    });

    return { motionIds, motions };
  }

  /**
   * 加载工程动画，并全量设置动画数据
   * @param animations 工程动画数组
   *
   */
  public loadMotions(animations: ProjectAnimations) {
    const motionData = this.parseMotions(animations);

    store.dispatch(loadMotions(motionData));
  }

  /**
   * 加载模型物理碰撞框数据
   * @param hitBox 物理碰撞框数据
   */
  public loadHitBoxData(hitBox: ProjectHitBox) {
    store.dispatch(setHitBoxMode(hitBox.mode));

    if (!hitBox.customBox) {
      store.dispatch(updateHitBoxParamPanelData({ data: undefined }));
    } else {
      store.dispatch(
        updateHitBoxParamPanelData({
          data: {
            position: serializeVec3(hitBox.customBox.position),
            size: serializeVec3(hitBox.customBox.size),
          },
        }),
      );
    }
  }

  public loadModelPivot(modelPivot: Vec3SchemaType) {
    store.dispatch(updateModelPivot(serializeVec3(modelPivot)));
  }

  public calculateModelPivot(): Vec3SchemaType {
    this.scene.updateMatrixWorld();

    return Vec3Schema.fromJSON(this.getDefaultBounds().boundsCenter);
  }

  /**
   * 在已有动画之前新增工程动画
   * @param animations 工程动画数组
   */
  public prependMotions(animations: ProjectAnimations) {
    const motionData = this.parseMotions(animations);

    this.history.saveAction({ action: prependMotions(motionData) });
  }
}
