import { mat4, quat, vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';
import { clamp, pick } from 'ramda';
import { calcEasing, lerp } from '@box/voxa-project';
import { getStringWidth, popStringByWidth } from '@box/box-design';
import {
  InterpolationType,
  MotionKeyframe,
  setMotionNodes,
  MotionNode,
  KeyframeOffset,
  ProjectNodeType,
  Motion,
  NodeKeyframeIds,
  NodeKeyframes,
  upsertKeyframes,
  setActiveKeyframes,
  NodeDict,
  KeyframeData,
  updateHierarchyNodesAlpha,
  addMotion,
  setActiveMotionId,
  removeKeyframes,
  removeMotion,
  copyMotion,
  AnimatorMode,
} from '../../../redux/animator-slice';
import { setCurrentTime } from '../../../redux/app-slice';
import {
  everyKeyframe,
  MAX_KEYFRAME_TIME,
  timeToFrame,
  parseSkinParts,
  isSkinPart,
  MAX_MOTION_LENGTH,
  isControllerVisible,
} from '../util';
import { store } from '../../../redux/store';
import type { EditingHistory } from '../../editing-history';
import type { BoneNode } from '../../bone';
import type { IEvents } from '../../events/interface';
import { serializeMat4 } from '../../../utils/math';
import { KeyframeCaches } from './keyframe-caches';
import {
  calculateNewKeyframeTime,
  DEFAULT_INTERPOLATION,
  everyNodeKeyframe,
  getMotionBoneIds,
  isEmptyNodeDict,
  searchRelativeKeyframes,
} from './util';
import { incrementalNaming, MOTION_NAME } from '../../../utils/naming';
import { NodeManager } from '../node-manager';
import { MAX_NAME_LENGTH } from '../../../defs';
import type { VoxaProfiler } from '../../profiler';

const IDENTITY_MAT = mat4.create();

const TEMP_POS = vec3.create();
const TEMP_QUAT = quat.create();
const TEMP_SCALE = vec3.create();

type InitParams = {
  history: EditingHistory;
  events: IEvents;
  nodeManager: NodeManager;
  profiler: VoxaProfiler;
};

export type AddKeyframesParams = {
  time: number;
  motionId: string;
  nodeIds: string[];
};

type AddKeyframeParams = {
  time: number;
  motionId: string;
  bone: BoneNode;
  offset: KeyframeOffset;
};

type ChannelInterpolation = {
  /**
   * 插值方式
   */
  type: InterpolationType;
  /**
   * 插值可以接受处理的时间范围
   */
  time: [number, number];
  /**
   * 帧段的实际时长
   */
  duration: number;
  /**
   * 插值的起始位移和终点位移
   */
  positions: vec3[];
  /**
   * 插值的起始旋转和终点旋转
   */
  quaternions: quat[];
  /**
   * 插值的起始缩放和终点缩放
   */
  scales: vec3[];
  /**
   * 插值的起始透明度和终点透明度
   */
  alphas: number[];
};

type KeyframeDuplications = NodeDict<KeyframeData>;

type KeyframeClipboard = {
  duplications: KeyframeDuplications;
  minTime: number;
};

export class MotionManager {
  private history: EditingHistory;

  private events: IEvents;

  private nodeManager: NodeManager;

  private keyframeCaches: KeyframeCaches;

  /**
   * 关键帧剪贴板
   */
  private keyframeClipboard?: KeyframeClipboard;

  private profiler: VoxaProfiler;

  constructor({ history, events, nodeManager, profiler }: InitParams) {
    this.history = history;
    this.events = events;
    this.nodeManager = nodeManager;
    this.profiler = profiler;
    this.keyframeCaches = new KeyframeCaches();

    const poseByActiveMotionId = () => {
      const { app, animator } = store.getState();

      if (animator.activeMotionId) {
        this.poseAtTime(app.motionPanel.currentTime);
      } else {
        this.pose();
      }
    };

    this.history.registerActionCallback(
      'setActiveMotionId',
      poseByActiveMotionId,
    );

    this.history.registerActionCallback('removeMotion', poseByActiveMotionId);

    this.history.registerActionCallback('setCurrentTime', poseByActiveMotionId);

    this.history.registerActionCallback('upsertKeyframes', (payload) => {
      const { newNodeKeyframes } = payload;

      // 撤销重做upsert时，需要删掉原本的关键帧缓存
      Object.values(newNodeKeyframes).forEach((keyframeList) => {
        keyframeList.forEach((keyframe) => {
          keyframe && this.deleteKeyframeCache(keyframe.id);
        });
      });

      poseByActiveMotionId();
    });

    this.history.registerActionCallback(
      'removeKeyframes',
      poseByActiveMotionId,
    );

    this.history.registerActionCallback(
      'setKeyframesInterpolation',
      poseByActiveMotionId,
    );

    this.history.registerActionCallback('moveKeyframes', poseByActiveMotionId);
  }

  public checkIn() {
    const { app, animator } = store.getState();
    const { activeMotionId, motionData } = animator;
    let newAlphaBones: BoneNode[] | undefined;

    // 更新setup模式数据，切换到对应时间点的动作
    this.nodeManager.boneManager.updateSetupData();

    this.profiler.updateSkinAlphaCache(
      this.nodeManager.getAllSkinNodes().map((node) => node.uuid),
      animator.hierarchyData,
    );

    const motion = motionData.motions[activeMotionId];

    if (motion) {
      this.fillEmptyMotionNodes(motionData.motions[motion.id]);

      newAlphaBones = this.poseMotionAtTime(app.motionPanel.currentTime);
    }

    newAlphaBones && this.updateBoneSkinAlpha(newAlphaBones);
  }

  public checkOut() {
    const newAlphaBones = this.nodeManager.boneManager.pose();

    this.nodeManager.boneManager.clearSetupData();
    this.clearCaches();

    this.profiler.clearSkinAlphaCache();
    this.updateBoneSkinAlpha(newAlphaBones);
  }

  /**
   * 创建一个新的动作数据，会根据当前骨骼节点填充各个节点的第0帧
   */
  private createMotion(): Motion {
    const id = nanoid();

    const { motions } = store.getState().animator.motionData;

    const name = incrementalNaming(
      MOTION_NAME,
      Object.values(motions),
      ({ name }, newName) => newName !== name,
    );

    const nodes: Record<string, MotionNode> = {};

    for (const [, bone] of this.nodeManager.boneManager.map) {
      nodes[bone.uuid] = this.createMotionNode(bone.uuid);
    }

    return {
      id,
      name,
      nodes,
    };
  }

  /**
   * 创建一个无偏移的第0帧
   */
  private createMotionNode(nodeId: string): MotionNode {
    return {
      nodeId,
      keyframes: {
        '0': {
          id: nanoid(),
          time: 0,
          offset: { matrix: serializeMat4(IDENTITY_MAT), alpha: 0 },
          interpolation: DEFAULT_INTERPOLATION,
        },
      },
    };
  }

  /**
   * 根据当前骨骼节点，为动作中没有关键帧的节点添加第0帧
   */
  private fillEmptyMotionNodes(motion: Motion) {
    const { nodes } = motion;

    const newNodes: MotionNode[] = [];

    for (const [, bone] of this.nodeManager.boneManager.map) {
      if (!nodes[bone.uuid]) {
        newNodes.push(this.createMotionNode(bone.uuid));
      }
    }

    if (newNodes.length > 0) {
      this.history.saveAction({
        action: setMotionNodes({ motionId: motion.id, nodes: newNodes }),
      });
    }
  }

  private addMotionKeyframe(params: AddKeyframesParams) {
    const { time, motionId, nodeIds } = params;

    const { motionData, hierarchyData } = store.getState().animator;
    const { motions } = motionData;

    const motion = motions[motionId];

    if (!motion) {
      return;
    }

    this.history.setGroup();

    nodeIds.forEach((nodeId) => {
      if (
        !hierarchyData[nodeId] ||
        hierarchyData[nodeId].type !== ProjectNodeType.Bone
      ) {
        return;
      }

      const motionNode = motion.nodes[nodeId];

      const bone = this.nodeManager.boneManager.map.get(nodeId);

      if (!bone) {
        return;
      }

      const offset = this.nodeManager.boneManager.calculateOffset(bone);

      // 如果没有数据或第0帧数据
      if (!motionNode || !motionNode.keyframes['0']) {
        this.addMotionNode({
          time,
          motionId,
          bone,
          offset,
        });

        return;
      }

      this.upsertKeyframe({ motion, bone, time, offset });
    });

    this.history.unsetGroup();
  }

  private addMotionNode(params: AddKeyframeParams) {
    const { time, motionId, bone, offset } = params;

    const timeList: { time: number; offset: KeyframeOffset }[] = [
      {
        time,
        offset,
      },
    ];

    if (time !== 0) {
      timeList.unshift({
        time: 0,
        offset: {
          alpha: 0,
          matrix: serializeMat4(IDENTITY_MAT),
        },
      });
    }

    const [keyframeA, keyframeB] = timeList.map<MotionKeyframe>(
      ({ time: t, offset }) => {
        const id = nanoid();
        // 同步添加到缓存
        this.addKeyframeCache(id, bone, offset);

        return {
          id,
          time: t,
          offset,
          interpolation: DEFAULT_INTERPOLATION,
        };
      },
    );

    const keyframes: Record<string, MotionKeyframe> = {
      [keyframeA.time]: keyframeA,
    };

    if (keyframeB) {
      keyframes[keyframeB.time] = keyframeB;

      keyframeA.nextTime = keyframeB.time;
      keyframeB.prevTime = keyframeA.time;
    }

    this.history.saveAction({
      action: setMotionNodes({
        motionId,
        nodes: [
          {
            nodeId: bone.uuid,
            keyframes,
          },
        ],
      }),
    });
  }

  /**
   * 执行“添加关键帧”操作时，判断是哪种更新行为
   */
  private upsertKeyframe(params: {
    motion: Motion;
    bone: BoneNode;
    time: number;
    offset: KeyframeOffset;
  }) {
    const { motion, bone, time, offset } = params;

    const keyframes = motion.nodes[bone.uuid]?.keyframes;

    let keyframe = keyframes[time];

    if (keyframe) {
      keyframe = {
        ...keyframe,
        offset,
      };
    } else {
      keyframe = {
        id: nanoid(),
        time,
        interpolation: DEFAULT_INTERPOLATION,
        offset,
      };
    }

    this.history.saveAction({
      action: upsertKeyframes({
        motionId: motion.id,
        newNodeKeyframes: { [bone.uuid]: [keyframe] },
      }),
    });

    this.addKeyframeCache(keyframe.id, bone);
  }

  /**
   * 更新骨骼节点的透明度，并更新骨骼节点绑定的蒙皮透明度，更新store
   */
  private updateBoneSkinAlpha(bones: BoneNode[]) {
    const { hierarchyData } = store.getState().animator;

    bones.forEach((bone) => {
      const boneHierarchy = hierarchyData[bone.uuid];

      if (!boneHierarchy || boneHierarchy.type !== ProjectNodeType.Bone) {
        return;
      }

      const ids = [bone.uuid];
      const alphas = [bone.alpha];

      if (boneHierarchy.skinId) {
        parseSkinParts(ids, [boneHierarchy.skinId], (id) => {
          const skinPart = this.nodeManager.getSkinNode(id);

          if (!skinPart || !isSkinPart(skinPart)) {
            return false;
          }

          skinPart.alpha = bone.alpha;

          alphas.push(bone.alpha);

          return true;
        });
      }

      store.dispatch(updateHierarchyNodesAlpha({ ids, alphas }));
    });
  }

  /**
   * 更新骨骼节点到setup模式姿态
   */
  private pose() {
    const { activeIds } = store.getState().animator;

    this.nodeManager.clearTempGroup(activeIds);

    this.updateBoneSkinAlpha(this.nodeManager.boneManager.pose());

    this.nodeManager.makeTempGroup(activeIds);

    this.nodeManager.transform.updateParamPanelData();
  }

  /**
   * 更新骨骼节点到当前动作的指定时间点
   */
  public poseAtTime(time: number) {
    const { activeIds } = store.getState().animator;

    this.nodeManager.clearTempGroup(activeIds);

    this.updateBoneSkinAlpha(this.poseMotionAtTime(time));

    this.nodeManager.makeTempGroup(activeIds);

    this.nodeManager.transform.updateParamPanelData();
  }

  /**
   * 新增动作，并且选中新增动作。
   * 如果动作数量已达限制，则不会添加
   */
  public addMotion() {
    const { motionData } = store.getState().animator;
    const { motionIds } = motionData;

    if (motionIds.length >= MAX_MOTION_LENGTH) {
      return;
    }

    const data = this.createMotion();

    this.history.setGroup();

    this.history.saveAction({ action: addMotion(data) });

    this.selectMotion(data.id);

    this.history.unsetGroup();

    return store.getState().animator.motionData.motions[data.id];
  }
  /**
   * 选中存在的动作，重置时间为0，并更新骨骼节点姿态
   */
  public selectMotion(motionId: string) {
    const { activeMotionId, motionData } = store.getState().animator;

    const motion = motionData.motions[motionId];

    if (!motion || activeMotionId === motionId) {
      return;
    }

    this.history.setGroup();

    // 切换动作前，清空当前关键帧缓存
    this.clearCaches();

    // 选中动作时，检查是否所有骨骼节点都有第0帧，如果没有，为其创建第0帧
    this.fillEmptyMotionNodes(motion);

    this.history.saveAction({ action: setActiveMotionId(motionId) });

    this.history.saveAction({ action: setCurrentTime(0) });

    this.history.saveAction({ action: setActiveKeyframes({}) });

    this.poseAtTime(0);

    this.history.unsetGroup();
  }

  /**
   * 删除选中的关键帧
   */
  public removeActiveKeyframes() {
    const { activeMotionId, activeKeyframes } = store.getState().animator;

    if (isEmptyNodeDict(activeKeyframes)) {
      return;
    }

    this.history.setGroup();

    this.history.saveAction({
      action: removeKeyframes({
        motionId: activeMotionId,
        nodeKeyframeIds: activeKeyframes,
      }),
    });

    this.history.saveAction({
      action: setActiveKeyframes({}),
    });

    this.history.unsetGroup();

    Object.values(activeKeyframes).forEach((keyframeList) =>
      keyframeList.forEach((id) => this.deleteKeyframeCache(id)),
    );

    const { currentTime } = store.getState().app.motionPanel;

    this.poseAtTime(currentTime);
  }

  /**
   * 删除指定动作。
   * 如果指定动作是当前选中的动作，则选中列表第一个动作。
   * 如果没有任何动作，恢复到Setup姿态。
   */
  public removeMotion(motionId: string) {
    const { animator } = store.getState();

    this.history.setGroup();

    this.history.saveAction({ action: removeMotion(motionId) });

    // 如果删除的motionId是当前选中的id，切换选中，或恢复到Setup
    if (motionId === animator.activeMotionId) {
      const { motionIds: newMotionIds } = store.getState().animator.motionData;

      if (newMotionIds[0]) {
        this.selectMotion(newMotionIds[0]);
      } else {
        this.history.saveAction({ action: setActiveMotionId('') });

        this.pose();
      }
    }

    this.history.unsetGroup();
  }

  public copyMotion(sourceMotionId: string) {
    const { motions } = store.getState().animator.motionData;
    const sourceMotion = motions[sourceMotionId];

    if (!sourceMotion) {
      return;
    }

    const newMotionId = nanoid();

    // 以原动作的名字作为词根，递增命名，规则同新建动作
    let rootName = sourceMotion.name;
    let newMotionName = '';

    /**
     * 确保名字不超过长度、并且没有重名
     */
    while (true) {
      newMotionName = incrementalNaming(
        `${rootName}`,
        Object.values(motions),
        ({ name }, newName) => name !== newName,
        1,
      );

      // 检查名字是否超过长度限制
      const length = getStringWidth(newMotionName);

      if (length <= MAX_NAME_LENGTH) {
        break;
      }

      rootName = popStringByWidth(rootName, length - MAX_NAME_LENGTH);
    }

    this.history.setGroup();

    this.history.saveAction({
      action: copyMotion({
        sourceMotionId,
        newMotionId,
        newMotionName,
      }),
    });

    this.selectMotion(newMotionId);

    this.history.unsetGroup();

    return newMotionId;
  }

  /**
   * 如果当前是Motion模式，为当前动作的指定节点在当前时间打关键帧
   * - 拖拽操纵杆时，给选中的节点打关键帧
   * - 手动打关键帧时，给选中以及关联的节点打关键帧
   */
  public addKeyframe(nodeIds: string[]) {
    const { app, animator } = store.getState();

    const { mode, activeIds, activeMotionId } = animator;

    if (mode !== AnimatorMode.Motion) {
      return;
    }

    this.nodeManager.clearTempGroup(activeIds);

    this.addMotionKeyframe({
      time: app.motionPanel.currentTime,
      motionId: activeMotionId,
      nodeIds,
    });

    this.nodeManager.makeTempGroup(activeIds);
  }

  /**
   * 更新骨骼节点到当前动作的指定时间点的状态
   * @return 返回透明度发生变化的骨骼节点数组
   */
  private poseMotionAtTime(time: number): BoneNode[] {
    const { motionData, activeMotionId } = store.getState().animator;

    const motion = motionData.motions[activeMotionId];

    if (!motion) {
      return [];
    }

    const { nodes } = motion;

    const newAlphaBones: BoneNode[] = [];

    for (const [, bone] of this.nodeManager.boneManager.map) {
      const motionNode = nodes[bone.uuid];

      let newAlpha: number | undefined;

      if (!motionNode) {
        newAlpha = this.nodeManager.boneManager.poseBone(bone);

        if (newAlpha !== undefined) {
          newAlphaBones.push(bone);
        }
        continue;
      }

      const channelInterpolation = this.getChannelInterpolation(
        time,
        motionNode,
        bone,
      );

      if (!channelInterpolation) {
        continue;
      }

      const transformAlpha = this.calculateInterpolation(
        channelInterpolation,
        time,
      );

      if (transformAlpha) {
        newAlpha = this.nodeManager.boneManager.poseBoneByTransformAlpha(
          bone,
          transformAlpha,
        );

        if (newAlpha !== undefined) {
          newAlphaBones.push(bone);
        }
      }
    }

    this.nodeManager.boneManager.rootBone.updateMatrixWorld();

    return newAlphaBones;
  }

  private calculateInterpolation(
    params: ChannelInterpolation,
    currentTime: number,
  ):
    | {
        position: vec3;
        quaternion: quat;
        scale: vec3;
        alpha: number;
      }
    | undefined {
    const { type, time, duration, positions, quaternions, scales, alphas } =
      params;

    let weight: number;

    // 0 / 0 会变NaN，clamp之后还是NaN
    if (duration !== 0) {
      weight = (currentTime - time[0]) / duration;
      weight = clamp(0, 1, weight);
    } else {
      weight = 0;
    }

    // 根据插值类型计算当前插值比重
    weight = calcEasing(type, weight);

    vec3.lerp(TEMP_POS, positions[0], positions[1], weight);
    quat.slerp(TEMP_QUAT, quaternions[0], quaternions[1], weight);
    vec3.lerp(TEMP_SCALE, scales[0], scales[1], weight);
    const alpha = lerp(alphas[0], alphas[1], weight);

    return {
      position: TEMP_POS,
      quaternion: TEMP_QUAT,
      scale: TEMP_SCALE,
      alpha,
    };
  }

  /**
   * 清理缓存数据
   */
  private clearCaches() {
    this.keyframeCaches.clear();
  }

  /**
   * 删除特定关键帧的缓存
   */
  private deleteKeyframeCache(keyframeId: string) {
    this.keyframeCaches.delete(keyframeId);
  }

  /**
   * 缓存关键帧对应的绝对值数据
   */
  private addKeyframeCache = (
    keyframeId: string,
    bone: BoneNode,
    offset?: KeyframeOffset,
  ) => {
    let originAlpha = bone.alpha;
    if (offset) {
      vec3.copy(TEMP_POS, bone.position);
      quat.copy(TEMP_QUAT, bone.quaternion);
      vec3.copy(TEMP_SCALE, bone.scale);
      this.nodeManager.boneManager.poseBone(bone, offset);
    }

    const transformAlpha = this.keyframeCaches.addTransformAlpha(keyframeId, {
      position: bone.position,
      quaternion: bone.quaternion,
      scale: bone.scale,
      alpha: bone.alpha,
    });

    if (offset) {
      vec3.copy(bone.position, TEMP_POS);
      quat.copy(bone.quaternion, TEMP_QUAT);
      vec3.copy(bone.scale, TEMP_SCALE);
      bone.alpha = originAlpha;
    }

    return transformAlpha;
  };

  /**
   * 根据时间点，获取帧段的插值计算数据
   */
  private getChannelInterpolation(
    time: number,
    motionNode: MotionNode,
    bone: BoneNode,
  ): ChannelInterpolation | undefined {
    const { keyframes } = motionNode;

    let targetKeyframe: MotionKeyframe | undefined;
    let latestKeyframe: MotionKeyframe | undefined;

    everyKeyframe(0, keyframes, (keyframe) => {
      if (!keyframe.nextTime) {
        latestKeyframe = keyframe;
      }

      if (keyframe.time < time) {
        return true;
      }

      targetKeyframe = keyframe;

      return false;
    });

    if (!targetKeyframe) {
      if (!latestKeyframe) {
        return;
      }

      // 如果都没有找到，说明在最后一个关键帧之后，按最后一个关键帧来计算
      targetKeyframe = latestKeyframe;
    }

    const { prevKeyframe, nextKeyframe } = searchRelativeKeyframes(
      targetKeyframe,
      keyframes,
    );

    let list: [MotionKeyframe, MotionKeyframe];

    if (prevKeyframe) {
      list = [prevKeyframe, targetKeyframe];
    } else if (nextKeyframe) {
      list = [targetKeyframe, nextKeyframe];
    } else {
      list = [targetKeyframe, targetKeyframe];
    }

    return this.createChannelInterpolation(bone, list);
  }

  /**
   * 根据帧段、关键帧数据，创建骨骼的插值计算方法
   */
  private createChannelInterpolation(
    bone: BoneNode,
    keyframes: [MotionKeyframe, MotionKeyframe],
  ) {
    const [startKeyframe, endKeyframe] = keyframes;

    const channelInterpolation: ChannelInterpolation = {
      type: startKeyframe.interpolation,
      time: [
        startKeyframe.time,
        endKeyframe.nextTime === undefined ? Infinity : endKeyframe.time,
      ],
      duration: endKeyframe.time - startKeyframe.time,
      positions: [],
      quaternions: [],
      scales: [],
      alphas: [],
    };

    keyframes.forEach((keyframe) => {
      let transformAlpha = this.keyframeCaches.getTransformAlpha(keyframe.id);

      if (!transformAlpha) {
        transformAlpha = this.addKeyframeCache(
          keyframe.id,
          bone,
          keyframe.offset,
        );
      }

      channelInterpolation.positions.push(transformAlpha.position);
      channelInterpolation.quaternions.push(transformAlpha.quaternion);
      channelInterpolation.scales.push(transformAlpha.scale);
      channelInterpolation.alphas.push(transformAlpha.alpha);
    });

    return channelInterpolation;
  }

  /**
   * 查询当前剪贴板中的数据
   */
  public getKeyframeClipboard() {
    return this.keyframeClipboard;
  }

  /**
   * 复制关键帧到剪贴板中
   * @param motionId 动作id
   * @param nodeKeyframeIds 关键帧id字典
   */
  public updateKeyframeClipboard(
    motionId: string,
    nodeKeyframeIds: NodeKeyframeIds,
  ): KeyframeClipboard | undefined {
    const { animator } = store.getState();
    const motion = animator.motionData.motions[motionId];

    if (!motion || isEmptyNodeDict(nodeKeyframeIds)) {
      return;
    }

    const duplications: KeyframeDuplications = {};

    // 记录最小的时间，作为粘贴时的基准时间
    let minTime: number = Infinity;

    everyNodeKeyframe(motion.nodes, nodeKeyframeIds, (keyframe, nodeId) => {
      if (!duplications[nodeId]) {
        duplications[nodeId] = [];
      }

      const duplication: KeyframeData = {
        ...pick(['time', 'offset', 'interpolation'], keyframe),
      };

      minTime = Math.min(duplication.time, minTime);

      duplications[nodeId].push(duplication);

      return true;
    });

    // 如果依然是Infinity，表示没有有效的数据
    if (minTime === Infinity) {
      return;
    }

    this.keyframeClipboard = {
      duplications,
      minTime,
    };
  }

  public pasteKeyframes(motionId: string, nodeIds: string[], newFrame: number) {
    const motion = store.getState().animator.motionData.motions[motionId];

    if (!motion || !this.keyframeClipboard || nodeIds.length === 0) {
      return false;
    }

    const { duplications, minTime } = this.keyframeClipboard;

    const offsetFrames = newFrame - timeToFrame(minTime);

    const newNodeKeyframes: NodeKeyframes = {};

    const newNodeKeyframeIds: NodeKeyframeIds = {};

    const idSet = new Set(nodeIds);

    Object.keys(duplications).forEach((nodeId) => {
      if (!idSet.has(nodeId)) {
        return;
      }

      const keyframeList = duplications[nodeId];

      if (!newNodeKeyframes[nodeId]) {
        newNodeKeyframes[nodeId] = [];
        newNodeKeyframeIds[nodeId] = [];
      }

      keyframeList.forEach((data) => {
        const time = calculateNewKeyframeTime(data.time, offsetFrames);

        if (time < 0 || time > MAX_KEYFRAME_TIME) {
          return;
        }

        const keyframe: MotionKeyframe = {
          id: nanoid(),
          time,
          interpolation: data.interpolation,
          offset: data.offset,
        };

        newNodeKeyframes[nodeId].push(keyframe);
        newNodeKeyframeIds[nodeId].push(keyframe.id);
      });
    });

    if (!isEmptyNodeDict(newNodeKeyframes)) {
      this.history.setGroup();

      this.history.saveAction({
        action: upsertKeyframes({
          motionId,
          newNodeKeyframes,
        }),
      });

      this.history.saveAction({
        action: setActiveKeyframes(newNodeKeyframeIds),
      });

      this.history.unsetGroup();

      return true;
    }

    return false;
  }

  /**
   * 根据当前骨骼选中状态，更新关键帧选中数据
   */
  public updateActiveKeyframes(saveRecord?: boolean) {
    const { activeIds, relativeIds, hierarchyData, activeKeyframes } =
      store.getState().animator;

    const { boneIds } = getMotionBoneIds(activeIds, relativeIds, hierarchyData);

    const newActiveKeyframes = pick(boneIds, activeKeyframes);

    this.history.saveAction({
      action: setActiveKeyframes(newActiveKeyframes),
      saveRecord,
    });
  }
}
