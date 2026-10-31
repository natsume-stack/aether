import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';
import type { Stage } from '../../stage';
import type { Object3D } from '../../rendering/objects/object3d';
import { BoneNode } from '../../bone';
import { Skeleton } from '../../rendering/objects/skeleton';
import { Bone } from '../../rendering/objects/bone';
import { SkeletonHelper } from './skeleton-helper';
import { ProjectNode } from '../../project/interfaces';
import type { KeyframeOffset } from '../../../redux/animator-slice';
import { serializeMat3, serializeMat4 } from '../../../utils/math';
import { getEuler } from '../../rendering/math/quat';

const TEMP_MAT = mat4.create();

export class BoneManager {
  public readonly skeleton: Skeleton;
  public readonly rootBone: Bone;
  public map: Map<string, BoneNode> = new Map<string, BoneNode>();

  /**
   * 记录setup模式的骨骼节点透明度，切换到motion模式时更新
   */
  private setupAlphas: Map<string, number> = new Map();

  private helper: SkeletonHelper;

  constructor(private stage: Stage, private scene: Object3D) {
    this.skeleton = new Skeleton();
    this.rootBone = new Bone();

    this.helper = new SkeletonHelper(this.stage.regl, this.map);
    this.scene.add(this.helper);
  }

  public clear() {
    this.rootBone.clear();

    this.map.clear();
  }

  public loadBone(node: ProjectNode) {
    const bone = new BoneNode(this.stage.regl, node.id, this.stage.getCamera);

    vec3.copy(bone.pivot, node.pivot);
    vec3.copy(bone.position, node.position);
    quat.copy(bone.quaternion, node.quaternion);
    vec3.copy(bone.rotateAngles, node.euler);
    vec3.copy(bone.scale, node.scale);
    mat3.copy(bone.parentScaleMat3, node.parentScaleMat3);
    bone.alpha = node.alpha;

    return bone;
  }

  public addBone(parentId: string) {
    const newBone = new BoneNode(
      this.stage.regl,
      nanoid(),
      this.stage.getCamera,
    );

    const parent = this.map.get(parentId) || this.rootBone;
    parent.add(newBone);

    this.map.set(newBone.uuid, newBone);

    return newBone;
  }

  /**
   * 记录setup模式时的骨骼数据
   */
  public updateSetupData() {
    for (const [, bone] of this.map) {
      bone.updateMatrix();

      this.skeleton.updateInvMatrix(bone);

      this.setupAlphas.set(bone.uuid, bone.alpha);
    }
  }

  /**
   * 清理setup模式时的骨骼数据
   */
  public clearSetupData() {
    this.setupAlphas.clear();

    this.skeleton.clearMatrices();
  }

  /**
   * 通过骨骼ID获取setup数据
   * @param boneId 骨骼ID
   * @returns
   */
  public getSetupData(boneId: string) {
    const alpha = this.setupAlphas.get(boneId);
    const record = this.skeleton.getInvMatrix(boneId);
    if (alpha === undefined || !record) {
      return;
    }
    mat4.invert(TEMP_MAT, record.invMatrix);
    return {
      matrix: serializeMat4(TEMP_MAT),
      parentScaleMat3: serializeMat3(record.parentScaleMat3),
      alpha,
    };
  }

  /**
   * 更新全部骨骼到Setup姿态
   * @returns 返回透明度有变化的骨骼节点数组
   */
  public pose() {
    const newAlphaBones: BoneNode[] = [];

    for (const [, bone] of this.map) {
      if (this.poseBone(bone) !== undefined) {
        newAlphaBones.push(bone);
      }
    }

    this.rootBone.updateMatrixWorld();

    return newAlphaBones;
  }

  /**
   * 计算骨骼节点与setup对比的偏移矩阵以及alpha偏移
   */
  public calculateOffset(bone: BoneNode): KeyframeOffset {
    bone.updateMatrix();

    this.skeleton.calculateOffsetMatrix(TEMP_MAT, bone);

    let alpha = this.setupAlphas.get(bone.uuid);

    if (alpha !== undefined) {
      alpha = bone.alpha - alpha;
    } else {
      alpha = 0;
    }

    return { matrix: serializeMat4(TEMP_MAT), alpha };
  }

  /**
   * 更新骨骼节点姿态
   * - 如果传入offset，根据偏移矩阵以及alpha偏移，更新骨骼节点
   * - 如果没有传入offset，则恢复到setup的姿态
   * @returns 如果骨骼节点的透明度有变化，返回新的透明度
   */
  public poseBone(bone: BoneNode, offset?: KeyframeOffset) {
    const currentAlpha = bone.alpha;

    const setupBoneAlpha = this.setupAlphas.get(bone.uuid);

    if (!offset) {
      this.skeleton.poseByMatrix(bone);

      if (setupBoneAlpha !== undefined) {
        bone.alpha = setupBoneAlpha;
      }
    } else {
      const { matrix, alpha } = offset;

      this.skeleton.applyOffsetMatrix(bone, matrix);

      if (setupBoneAlpha !== undefined) {
        bone.alpha = setupBoneAlpha + alpha;
      }
    }

    if (currentAlpha !== bone.alpha) {
      return bone.alpha;
    }
  }

  /**
   * 根据旋转、位移、透明度的绝对值数据更新骨骼节点
   * @returns 如果透明度需要更新，返回新的透明度数值
   */
  public poseBoneByTransformAlpha(
    bone: BoneNode,
    transformAlpha: {
      position?: vec3;
      quaternion?: quat;
      scale?: vec3;
      alpha?: number;
    },
  ) {
    const { position, quaternion, scale, alpha } = transformAlpha;

    if (position) {
      vec3.copy(bone.position, position);
    }

    if (quaternion) {
      quat.copy(bone.quaternion, quaternion);

      getEuler(bone.rotateAngles, bone.quaternion);
    }

    if (scale) {
      vec3.copy(bone.scale, scale);
    }

    if (alpha !== undefined && bone.alpha !== alpha) {
      bone.alpha = alpha;
      return alpha;
    }
  }
}
