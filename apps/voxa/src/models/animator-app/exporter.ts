import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { equals } from 'ramda';
import type {
  ModelAnimations,
  ModelAnimation,
  ProjectAnimations,
  Sampler,
  Vec3SchemaType,
  Vec4SchemaType,
  MotionMetaData,
  ProjectNodes,
  ModelNode,
  ModelNodes,
  ProjectHitBox,
  ModelMetaData,
  ProjectModelPivot,
} from '../project/interfaces';
import type { NodeManager } from './node-manager';
import type { MeshesIdDict } from '../project/interfaces';
import type { SkinPart } from '../skin-part';

import {
  ChannelNodePathType,
  InterpolationType,
  MotionKeyframe,
  MotionNode,
  ProjectNodeType,
  HierarchyNode,
} from '../../redux/animator-slice';

import {
  serializeQuat,
  serializeVec3,
  SerializedVec3,
  serializeMat3,
} from '../../utils/math';
import {
  AnimationSchema,
  ChannelNodePath,
  ChannelSchema,
  KeyframeSchema,
  MotionNodeSchema,
  ProjectAnimationSchema,
  SamplerSchema,
  Vec3Schema,
  Vec4Schema,
  ModelNodeSchema,
  Mat3Schema,
  HitBoxSchema,
  HitBoxDataSchema,
  HitBoxMode,
} from '../project/defs';
import { store } from 'apps/voxa/src/redux/store';
import {
  everyKeyframe,
  parseSkinParts,
  getSkinIdByBoneId,
  isRootNode,
  getProjectNode,
  isSkinPart,
  everyNode,
} from './util';
import { isEmptyMotionNode } from './motion-manager/util';
import { getMeshId } from '../voxel-app/voxel-manager';
import { Box3 } from '../rendering/math/box3';
import { ROOT_ID } from '../../defs';
import { SkinNode } from './node-manager/interface';
import {
  IDENTITY_SCALE,
  IDENTITY_SCALE_MAT3,
} from '../rendering/controls/transform/def';
import { invertMat4ScaleRight, mat4SetFromMat3 } from '../rendering/utils/math';

const TEMP_VEC3 = vec3.create();
const TEMP_QUAT = quat.create();
const TEMP_MAT4 = mat4.create();
const TEMP_INVERT = mat4.create();
const TEMP_MAT3 = mat3.create();
const TEMP_BOX = new Box3();
const TEMP_POS = vec3.create();

const IDENTITY_VEC3 = vec3.create();
const IDENTITY_QUAT = quat.create();

export class Exporter {
  constructor(private nodeManager: NodeManager) {}

  public getModelBounds(
    meshesIdDict: MeshesIdDict,
    skinNodes?: SkinNode[],
  ): {
    bounds: SerializedVec3;
    boundsCenter: SerializedVec3;
    rootPartOffset: SerializedVec3;
  } {
    const { hierarchyData } = store.getState().animator;

    const expandBySkinPart = (out: Box3, skinPart: SkinPart) => {
      const data = hierarchyData[skinPart.uuid];
      if (!data || data.type !== ProjectNodeType.SkinPart) {
        return;
      }

      const { voxelId, flip } = data;
      if (!voxelId) {
        return;
      }

      const mesh = meshesIdDict[getMeshId(voxelId, flip)];
      if (!mesh) {
        return;
      }

      skinPart.updateWorldMatrix(false, false);

      const { newBounds, boundaryStart } = mesh;

      const tempBox = new Box3();
      vec3.copy(tempBox.min, [0, 0, 0]);
      vec3.copy(tempBox.max, newBounds);
      mat4.translate(TEMP_MAT4, skinPart.matrixWorld, boundaryStart);
      tempBox.applyMatrix4(TEMP_MAT4);

      out.union(tempBox);
    };

    TEMP_BOX.makeEmpty();
    (skinNodes || this.nodeManager.getAllSkinNodes()).forEach((skinNodes) => {
      if (!isSkinPart(skinNodes)) {
        return;
      }
      expandBySkinPart(TEMP_BOX, skinNodes);
    });

    if (TEMP_BOX.isEmpty()) {
      return {
        bounds: [0, 0, 0],
        boundsCenter: [0, 0, 0],
        rootPartOffset: [0, 0, 0],
      };
    }

    const bounds: SerializedVec3 = [
      TEMP_BOX.max[0] - TEMP_BOX.min[0],
      TEMP_BOX.max[1] - TEMP_BOX.min[1],
      TEMP_BOX.max[2] - TEMP_BOX.min[2],
    ];

    // 导出的多部件文件以物理模型的左下角为原点
    // 记录这个点的偏移量，用于节点导出计算
    const rootPartOffset = serializeVec3(TEMP_BOX.min);

    // 获取这个bounds的中心位置
    const boundsCenter = serializeVec3(TEMP_BOX.getCenter(TEMP_VEC3));

    return {
      bounds,
      boundsCenter,
      rootPartOffset,
    };
  }

  public getModelNodes(
    meshesIdDict: MeshesIdDict,
    rootPartOffset?: vec3,
    nodeId?: string,
  ) {
    const { hierarchyData } = store.getState().animator;

    const nodes: ModelNodes = [];
    const idToIndex: Record<string, number | undefined> = {};
    const hierarchies: HierarchyNode[] = [];

    everyNode(nodeId || ROOT_ID, hierarchyData, (hierarchyNode) => {
      const { parentId, type } = hierarchyNode;
      // 根节点下的部件/部件组/骨骼需要处理物理模型的偏移量
      // 使导出的部件以物理模型的左下角为原点
      const offset =
        parentId && isRootNode(parentId) ? rootPartOffset : undefined;
      this.addModelNode(
        { nodes, idToIndex, hierarchies },
        hierarchyNode,
        meshesIdDict,
        offset,
      );

      // 如果有骨骼绑定皮肤，遍历绑定的皮肤数据
      if (type === ProjectNodeType.Bone && hierarchyNode.skinId) {
        everyNode(hierarchyNode.skinId, hierarchyData, (skinNode) => {
          this.addModelNode(
            { nodes, idToIndex, hierarchies },
            skinNode,
            meshesIdDict,
          );
          return true;
        });
      }
      return true;
    });

    return { nodes, hierarchies, idToIndex };
  }

  public getModelCustomHitBox(
    boundsCenter: SerializedVec3,
  ): Pick<ModelMetaData, 'customBounds' | 'useCustomBounds'> {
    const { hitBoxMode, hitBoxParamPanelData } = store.getState().animator;

    let customBounds: Pick<ModelMetaData, 'customBounds'>['customBounds'] =
      undefined;

    if (hitBoxParamPanelData) {
      const { position, size } = hitBoxParamPanelData;
      customBounds = {
        size: serializeVec3(size),
        offset: [
          position[0] - boundsCenter[0],
          position[1] - boundsCenter[1],
          position[2] - boundsCenter[2],
        ],
      };
    }

    return {
      useCustomBounds: hitBoxMode === HitBoxMode.Custom,
      customBounds,
    };
  }

  /**
   * 添加模型文件节点数据
   * @param out 输出的模型文件节点相关数据
   * @param hierarchyNode store的节点数据
   * @param meshesIdDict 查询mesh索引值的字典
   * @param offset 偏移量。根目录下的子节点会传入偏移量
   * @returns
   */
  private addModelNode(
    out: {
      nodes: ModelNodes;
      idToIndex: Record<string, number | undefined>;
      hierarchies: HierarchyNode[];
    },
    hierarchyNode: HierarchyNode,
    meshesIdDict: MeshesIdDict,
    offset?: vec3,
  ) {
    const { nodes, idToIndex, hierarchies } = out;
    const currIdx = nodes.length;
    const modelNode = this.getModelNode(hierarchyNode, meshesIdDict, offset);
    if (!modelNode) {
      return;
    }
    nodes.push(modelNode);
    idToIndex[hierarchyNode.id] = currIdx;
    hierarchies.push(hierarchyNode);

    // 查找父节点/绑定的骨骼节点，并更新父节点/绑定的骨骼节点的children
    const parentOrBoneId = this.getParentOrBoneId(hierarchyNode);
    const parentIndex = parentOrBoneId ? idToIndex[parentOrBoneId] : undefined;
    if (parentIndex !== undefined && nodes[parentIndex]) {
      const parent = nodes[parentIndex];

      parent.children.push(currIdx);
    }
  }
  /**
   * 优先获取父节点，如果没有父节点的话再获取绑定的骨骼节点
   * @param node 节点
   * @returns
   */
  private getParentOrBoneId(node: HierarchyNode) {
    if (node.parentId) {
      return node.parentId;
    }

    if (
      node.type === ProjectNodeType.SkinPart ||
      node.type === ProjectNodeType.Group
    ) {
      return node.boneId;
    }
  }

  /**
   * 生成单一的模型文件节点，不包含children数据
   * @param hierarchyNode 列表节点数据
   * @param meshesIdDict mesh的id与索引的字典
   * @param 偏移量。根目录下的子节点会传入偏移量
   */
  private getModelNode(
    hierarchyNode: HierarchyNode,
    meshesIdDict: MeshesIdDict,
    offset?: vec3,
  ): ModelNode | undefined {
    // 构造根目录节点数据
    if (isRootNode(hierarchyNode.id)) {
      const modelNode = ModelNodeSchema.clone(ModelNodeSchema.identity);
      modelNode.rotation = Vec4Schema.fromJSON([0, 0, 0, 1]);
      vec3.copy(modelNode.scale, IDENTITY_SCALE);
      mat3.copy(modelNode.parentScaleMat3, IDENTITY_SCALE_MAT3);

      modelNode.children = [];
      return modelNode;
    }

    const node =
      hierarchyNode.type === ProjectNodeType.Bone
        ? this.nodeManager.getBoneNode(hierarchyNode.id)
        : this.nodeManager.getSkinNode(hierarchyNode.id);

    if (!node) {
      return;
    }

    const modelNode = ModelNodeSchema.clone(ModelNodeSchema.identity);

    vec3.copy(modelNode.scale, node.scale);

    // 处理中心点的偏移量
    node.getTransformedPivot(TEMP_POS);
    vec3.add(TEMP_POS, TEMP_POS, node.position);

    if (offset) {
      mat3.invert(TEMP_MAT3, node.parentScaleMat3);
      vec3.transformMat3(TEMP_VEC3, offset, TEMP_MAT3);
      vec3.sub(TEMP_POS, TEMP_POS, TEMP_VEC3);
    }

    modelNode.translation = Vec3Schema.fromJSON(serializeVec3(TEMP_POS));

    modelNode.rotation = Vec4Schema.fromJSON(serializeQuat(node.quaternion));

    modelNode.parentScaleMat3 = Mat3Schema.fromJSON(
      serializeMat3(node.parentScaleMat3),
    );

    if (
      hierarchyNode.type === ProjectNodeType.Bone ||
      hierarchyNode.type === ProjectNodeType.SkinPart
    ) {
      modelNode.alpha = hierarchyNode.alpha;
    }

    if (
      hierarchyNode.type === ProjectNodeType.SkinPart &&
      hierarchyNode.voxelId
    ) {
      const mesh =
        meshesIdDict[getMeshId(hierarchyNode.voxelId, hierarchyNode.flip)];

      if (mesh !== undefined) {
        modelNode.mesh = mesh.index;
      }
    }

    return modelNode;
  }

  /**
   * 获取存储的工程节点数据
   * @returns
   */
  public getProjectNodes(): ProjectNodes {
    const nodes: ProjectNodes = {};

    const { hierarchyData } = store.getState().animator;

    Object.keys(hierarchyData).forEach((id) => {
      const node = hierarchyData[id];
      if (!node) {
        return;
      }
      const projectNode = getProjectNode(node, (id) =>
        this.nodeManager.getModelUnit(id),
      );
      if (!projectNode) {
        return;
      }

      nodes[id] = projectNode;
    });

    return nodes;
  }

  /**
   * 获取模型文件的动画数据
   * @param nodes 模型节点数据
   * @param idToIndex 模型ID对应索引值的字典
   * @returns
   */
  public getModelAnimations(
    idToIndex: Record<string, number | undefined>,
    rootPartOffset: vec3,
  ): {
    animations: ModelAnimations;
    motionList: MotionMetaData[];
  } {
    this.nodeManager.boneManager.updateSetupData();

    const animations: ModelAnimations = [];
    const motionList: MotionMetaData[] = [];

    const { motionIds, motions } = store.getState().animator.motionData;
    motionIds.forEach((id) => {
      const motion = motions[id];
      if (!motion) {
        return;
      }
      const modelAnimation = AnimationSchema.alloc();
      modelAnimation.id = motion.id;
      modelAnimation.name = motion.name;
      modelAnimation.channels = [];
      modelAnimation.samplers = [];

      let duration = 0;

      Object.keys(motion.nodes).forEach((nodeId) => {
        const motionNode = motion.nodes[nodeId];

        if (!motionNode || isEmptyMotionNode(motionNode, false)) {
          return;
        }

        const nodeIdx = idToIndex[nodeId];
        if (nodeIdx === undefined) {
          return;
        }

        // 根节点下的骨骼需要处理物理模型的偏移量
        // 使导出的部件以物理模型的左下角为原点
        const offset = this.shouldApplyOffset(nodeId)
          ? rootPartOffset
          : undefined;

        const TSamplers: Sampler[] = [];
        const RSamplers: Sampler[] = [];
        const ASamplers: Sampler[] = [];
        const SSamplers: Sampler[] = [];

        everyKeyframe(0, motionNode.keyframes, (frame) => {
          if (frame.nextTime === undefined) {
            duration = Math.max(duration, frame.time);
          }
          this.addSamplers(
            { TSamplers, RSamplers, ASamplers, SSamplers },
            nodeId,
            motionNode.keyframes,
            frame,
            offset,
          );
          return true;
        });
        this.addChannelsAndSamplers(
          modelAnimation,
          nodeIdx,
          TSamplers,
          ChannelNodePath.Translation,
        );
        this.addChannelsAndSamplers(
          modelAnimation,
          nodeIdx,
          RSamplers,
          ChannelNodePath.Rotation,
        );
        this.addChannelsAndSamplers(
          modelAnimation,
          nodeIdx,
          SSamplers,
          ChannelNodePath.Scale,
        );

        // 透明度效果作用于部件本身，动画数据只记录在骨骼绑定的部件中
        const skinId = getSkinIdByBoneId(nodeId);
        if (!skinId) {
          return;
        }
        const skinPartIds: string[] = [];
        parseSkinParts(skinPartIds, [skinId]);
        skinPartIds.forEach((id) => {
          const idx = idToIndex[id];
          if (idx === undefined) {
            return;
          }
          this.addChannelsAndSamplers(
            modelAnimation,
            idx,
            ASamplers,
            ChannelNodePath.Alpha,
          );
        });
      });

      animations.push(modelAnimation);
      motionList.push({
        id: motion.id,
        name: motion.name,
        duration,
      });
    });

    this.nodeManager.boneManager.clearSetupData();

    return {
      animations,
      motionList,
    };
  }

  private shouldApplyOffset(nodeId: string) {
    const { hierarchyData } = store.getState().animator;
    const node = hierarchyData[nodeId];
    if (!node) {
      return false;
    }
    return !!node.parentId && isRootNode(node.parentId);
  }

  private addSamplers(
    out: {
      TSamplers: Sampler[];
      RSamplers: Sampler[];
      ASamplers: Sampler[];
      SSamplers: Sampler[];
    },
    nodeId: string,
    keyframes: MotionNode['keyframes'],
    frame: MotionKeyframe,
    offset?: vec3,
  ) {
    const value = this.getSamplerValue(nodeId, frame, offset);
    if (!value) {
      return;
    }

    const interpolation = this.getInterpolation(keyframes, frame);

    this.addSampler(out.TSamplers, ChannelNodePath.Translation, interpolation, {
      time: frame.time,
      value: value.translation,
    });

    this.addSampler(out.RSamplers, ChannelNodePath.Rotation, interpolation, {
      time: frame.time,
      value: value.rotation,
    });

    this.addSampler(out.ASamplers, ChannelNodePath.Alpha, interpolation, {
      time: frame.time,
      value: value.alpha,
    });

    this.addSampler(out.SSamplers, ChannelNodePath.Scale, interpolation, {
      time: frame.time,
      value: value.scale,
    });
  }

  private getSamplerValue(
    nodeId: string,
    frame: MotionKeyframe,
    offset?: vec3,
  ) {
    // keyframes记录的都是偏移量，需要加上所有节点的setup值
    const setupData = this.nodeManager.boneManager.getSetupData(nodeId);
    if (!setupData) {
      return;
    }
    mat4SetFromMat3(TEMP_INVERT, setupData.parentScaleMat3);
    mat4.invert(TEMP_INVERT, TEMP_INVERT);
    mat4.mul(TEMP_MAT4, TEMP_INVERT, setupData.matrix);

    mat4.mul(TEMP_MAT4, TEMP_MAT4, frame.offset.matrix);
    const alpha = setupData.alpha + frame.offset.alpha;
    mat4.getTranslation(TEMP_VEC3, TEMP_MAT4);

    if (offset) {
      mat3.invert(TEMP_MAT3, setupData.parentScaleMat3);
      vec3.transformMat3(TEMP_POS, offset, TEMP_MAT3);
      vec3.sub(TEMP_VEC3, TEMP_VEC3, TEMP_POS);
    }

    mat4.getScaling(TEMP_POS, TEMP_MAT4);
    invertMat4ScaleRight(TEMP_MAT4, TEMP_MAT4, TEMP_POS);
    mat4.getRotation(TEMP_QUAT, TEMP_MAT4);

    return {
      translation: Vec3Schema.fromJSON(serializeVec3(TEMP_VEC3)),
      rotation: Vec4Schema.fromJSON(serializeQuat(TEMP_QUAT)),
      alpha,
      scale: Vec3Schema.fromJSON(serializeVec3(TEMP_POS)),
    };
  }

  /**
   * 获取工程文件动画数据
   * @returns
   */
  public getProjectAnimations(): ProjectAnimations {
    const projectAnimations: ProjectAnimations = [];
    const { motionIds, motions } = store.getState().animator.motionData;
    motionIds.forEach((id) => {
      const motion = motions[id];
      if (!motion) {
        return;
      }
      const projectAnimation = ProjectAnimationSchema.alloc();

      projectAnimation.id = id;
      projectAnimation.name = motion.name;
      projectAnimation.nodes = {};

      Object.keys(motion.nodes).forEach((nodeId) => {
        const node = motion.nodes[nodeId];

        if (!node || isEmptyMotionNode(node, true)) {
          return;
        }

        const projectMotionNode = MotionNodeSchema.alloc();

        projectMotionNode.nodeId = nodeId;

        projectAnimation.nodes[nodeId] = projectMotionNode;

        everyKeyframe(0, node.keyframes, ({ time, offset, interpolation }) => {
          const projectKeyframe = KeyframeSchema.alloc();

          projectKeyframe.time = time.toString();

          projectKeyframe.interpolation = interpolation;

          let translation: Vec3SchemaType | undefined;
          let rotation: Vec4SchemaType | undefined;
          let scale: Vec3SchemaType | undefined;

          mat4.getTranslation(TEMP_VEC3, offset.matrix);
          if (!vec3.exactEquals(TEMP_VEC3, IDENTITY_VEC3)) {
            const [tx, ty, tz] = TEMP_VEC3;

            translation = Vec3Schema.fromJSON([tx, ty, tz]);
          }

          mat4.getScaling(TEMP_VEC3, offset.matrix);
          if (!vec3.exactEquals(TEMP_VEC3, IDENTITY_SCALE)) {
            const [sx, sy, sz] = TEMP_VEC3;

            scale = Vec3Schema.fromJSON([sx, sy, sz]);
          }

          invertMat4ScaleRight(TEMP_MAT4, offset.matrix, TEMP_VEC3);
          mat4.getRotation(TEMP_QUAT, TEMP_MAT4);
          if (!quat.exactEquals(TEMP_QUAT, IDENTITY_QUAT)) {
            const [qx, qy, qz, qw] = TEMP_QUAT;

            rotation = Vec4Schema.fromJSON([qx, qy, qz, qw]);
          }

          projectKeyframe.offset = {
            translation,
            rotation,
            scale,
            alpha: offset.alpha !== 0 ? offset.alpha : undefined,
          };

          projectMotionNode.keyframeList.push(projectKeyframe);

          return true;
        });
      });

      projectAnimations.push(projectAnimation);
    });

    return projectAnimations;
  }

  /**
   * 根据关键帧数据读取当前动作节点这个帧段的补帧类型
   * 如果当前时间节点获取不到帧段数据，说明有可能当前在最后一帧，读取前一帧的补帧类型
   * 如果前一帧也没有帧段数据，则有可能有且仅有一帧关键帧，返回默认线性补帧即可
   * @param motionNode 当前动作节点数据，包含关键帧和帧段数据
   * @param frame 当前关键帧
   * @returns 补帧类型
   */
  private getInterpolation(
    keyframes: MotionNode['keyframes'],
    frame: MotionKeyframe,
  ) {
    // 最后一个关键帧，需要判断前一个帧段，取前面的关键帧的补帧类型
    if (
      frame.nextTime === undefined &&
      frame.prevTime !== undefined &&
      keyframes[frame.prevTime]
    ) {
      return keyframes[frame.prevTime].interpolation;
    } else {
      return frame.interpolation;
    }
  }

  private createModelChannel(
    nodeIdx: number,
    samplerIdx: number,
    channelPath: ChannelNodePathType,
  ) {
    const channel = ChannelSchema.alloc();
    channel.target.node = nodeIdx;
    channel.target.path = channelPath;
    channel.sampler = samplerIdx;
    return channel;
  }

  private createSampler(
    channelPath: ChannelNodePathType,
    interpolation: InterpolationType,
  ) {
    const sampler = SamplerSchema.alloc();
    sampler.input = [];
    sampler.output.type = channelPath;
    sampler.output.data = [];
    sampler.interpolation = interpolation;
    return sampler;
  }

  /**
   * 设置同一种补帧方式中的sampler数据
   * @param out 输出sampler
   * @param time 时间节点
   * @param value 数值。可能是alpha，translation or rotation
   * @returns
   */
  private setSampler(out: Sampler, time: number, value: number | Float32Array) {
    const { input, output } = out;
    if (!input.length) {
      input.push(time);
      output.data.push(value as never);
      return;
    }

    // 检查前面两帧的数据，如果当前帧以及前面两帧的数据完全相同，则去掉中间的数据
    const prev1 = output.data[output.data.length - 1];
    const prev2 = output.data[output.data.length - 2];
    if (
      prev1 !== undefined &&
      prev2 !== undefined &&
      equals(prev1, value) &&
      equals(prev2, value)
    ) {
      input.pop();
      output.data.pop();
    }

    input.push(time);
    output.data.push(value as never);
  }

  /**
   * 添加同一条关键帧数据的sampler数据
   * 遇到不同的补帧类型自动切断
   * @param out 输出sampler数组
   * @param channelPath 通道类型。位移/旋转/透明度
   * @param interpolation 补帧类型
   * @param data 关键帧数据
   * @returns
   */
  private addSampler(
    out: Sampler[],
    channelPath: ChannelNodePathType,
    interpolation: InterpolationType,
    data: {
      time: number;
      value: number | Float32Array;
    },
  ) {
    if (!out.length) {
      const newSampler = this.createSampler(channelPath, interpolation);
      this.setSampler(newSampler, data.time, data.value);
      out.push(newSampler);
      return;
    }

    const prevSampler = out[out.length - 1];
    this.setSampler(prevSampler, data.time, data.value);

    if (prevSampler.interpolation === interpolation) {
      return;
    }

    const newSampler = this.createSampler(channelPath, interpolation);
    this.setSampler(newSampler, data.time, data.value);
    out.push(newSampler);
  }

  private addChannelsAndSamplers(
    out: ModelAnimation,
    nodeIdx: number,
    samplers: Sampler[],
    channelPath: ChannelNodePathType,
  ) {
    samplers.forEach((sampler) => {
      const samplerIdx = out.samplers.length;
      out.channels.push(
        this.createModelChannel(nodeIdx, samplerIdx, channelPath),
      );
      out.samplers.push(sampler);
    });
  }

  /**
   * 通过骨骼ID解析当前骨骼数据
   * 获取其绑定的部件/部件组ID，以及所有部件相关的体素ID，节点实例
   * @param boneId 骨骼ID
   * @returns
   */
  public parseBone(boneId: string) {
    const skinId = getSkinIdByBoneId(boneId);
    if (!skinId) {
      return;
    }
    const { hierarchyData } = store.getState().animator;
    const voxelIds: string[] = [];
    const skinNodes: SkinNode[] = [];
    everyNode(skinId, hierarchyData, (data) => {
      if (data.type === ProjectNodeType.SkinPart && data.voxelId) {
        voxelIds.push(data.voxelId);
      }
      const skinNode = this.nodeManager.getSkinNode(data.id);
      skinNode && skinNodes.push(skinNode);
      return true;
    });

    return {
      voxelIds,
      skinNodes,
      skinId,
    };
  }

  public getProjectHitBox(): ProjectHitBox {
    const hitBox = HitBoxSchema.clone(HitBoxSchema.identity);

    const { hitBoxMode, hitBoxParamPanelData } = store.getState().animator;
    hitBox.mode = hitBoxMode;

    if (hitBoxParamPanelData) {
      hitBox.customBox = HitBoxDataSchema.clone(HitBoxDataSchema.identity);
      hitBox.customBox.position = Vec3Schema.fromJSON(
        hitBoxParamPanelData.position,
      );
      hitBox.customBox.size = Vec3Schema.fromJSON(hitBoxParamPanelData.size);
    }

    return hitBox;
  }

  public getProjectModelPivot(): ProjectModelPivot {
    return Vec3Schema.fromJSON(store.getState().animator.modelPivot);
  }

  /**
   * 计算“外观框中心（boundsCenter）”相对于“锚点（modelPivot）”的距离
   */
  public getModelRenderBoxOffset(spec: {
    boundsCenter: vec3;
    modelPivot: vec3;
  }): SerializedVec3 {
    vec3.sub(TEMP_VEC3, spec.boundsCenter, spec.modelPivot);

    return serializeVec3(TEMP_VEC3);
  }
}
