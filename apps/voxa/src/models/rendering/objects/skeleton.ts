import { mat3, mat4, vec3 } from 'gl-matrix';
import { getEuler } from '../math/quat';
import type { Bone } from './bone';
import { invertMat4ScaleRight, mat4SetFromMat3 } from '../utils/math';

const TEMP_POS = vec3.create();
const TEMP_INVERT = mat4.create();
const TEMP_MAT = mat4.create();

type BoneRecord = {
  invMatrix: mat4;
  parentScaleMat3: mat3;
};

type BoneRecords = Record<string, BoneRecord>;

export class Skeleton {
  private boneInvMatrices: BoneRecords = {};

  private boneInvMatrixWorlds: BoneRecords = {};

  private updateInv(out: BoneRecords, id: string, mat: mat4, si: mat3) {
    if (!out[id]) {
      out[id] = {
        invMatrix: mat4.create(),
        parentScaleMat3: mat3.create(),
      };
    }

    mat4.invert(out[id].invMatrix, mat);
    mat3.copy(out[id].parentScaleMat3, si);
  }

  /**
   * 记录骨骼节点的inverse matrix
   */
  public updateInvMatrix(bone: Bone) {
    this.updateInv(
      this.boneInvMatrices,
      bone.uuid,
      bone.matrix,
      bone.parentScaleMat3,
    );
  }

  /**
   * 记录骨骼节点的inverse matrixWorld
   */
  public updateInvMatrixWorld(bone: Bone) {
    this.updateInv(
      this.boneInvMatrixWorlds,
      bone.uuid,
      bone.matrixWorld,
      bone.parentScaleMat3,
    );
  }

  /**
   * 通过uuid获取记录骨骼节点的inverse matrix 和 parentScaleMat3
   * @param uuid 节点uuid
   * @returns
   */
  public getInvMatrix(uuid: string): BoneRecord | undefined {
    return this.boneInvMatrices[uuid];
  }

  /**
   * 复原骨骼节点到记录的位置，用matrix进行计算
   */
  public poseByMatrix(bone: Bone) {
    const record = this.boneInvMatrices[bone.uuid];

    if (!record) {
      return;
    }

    mat4.invert(bone.matrix, record.invMatrix);

    this.updateBoneTransform(bone, bone.matrix, record.parentScaleMat3);
  }

  /**
   * 复原骨骼节点到记录的位置，用matrixWorld进行计算
   */
  public poseByMatrixWorld(bones: Bone[]) {
    /**
     * 有记录逆矩阵数据并更新了的骨骼节点
     */
    const updated: Bone[] = [];

    bones.forEach((bone) => {
      const recordWorld = this.boneInvMatrixWorlds[bone.uuid];

      if (!recordWorld) {
        return;
      }

      updated.push(bone);

      mat4.invert(bone.matrixWorld, recordWorld.invMatrix);
      mat3.copy(bone.parentScaleMat3, recordWorld.parentScaleMat3);
    });

    updated.forEach((bone) => {
      if (bone.parent && bone.parent.isBone()) {
        mat4.invert(bone.matrix, bone.parent.matrixWorld);
        mat4.mul(bone.matrix, bone.matrix, bone.matrixWorld);
      } else {
        mat4.copy(bone.matrix, bone.matrixWorld);
      }

      this.updateBoneTransform(bone, bone.matrix, bone.parentScaleMat3);
    });
  }

  private updateBoneTransform(bone: Bone, matrix: mat4, parentScaleMat3: mat3) {
    mat3.copy(bone.parentScaleMat3, parentScaleMat3);

    mat4SetFromMat3(TEMP_INVERT, bone.parentScaleMat3);
    mat4.invert(TEMP_INVERT, TEMP_INVERT);
    mat4.mul(TEMP_MAT, TEMP_INVERT, matrix);

    mat4.getScaling(bone.scale, TEMP_MAT);
    invertMat4ScaleRight(TEMP_MAT, TEMP_MAT, bone.scale);

    mat4.getRotation(bone.quaternion, TEMP_MAT);
    getEuler(bone.rotateAngles, bone.quaternion);

    bone.getTransformedPivot(TEMP_POS);
    mat4.getTranslation(bone.position, TEMP_MAT);
    vec3.sub(bone.position, bone.position, TEMP_POS);
  }

  public calculateOffsetMatrix(out: mat4, bone: Bone) {
    const record = this.boneInvMatrices[bone.uuid];

    if (!record) {
      mat4.identity(out);
      return;
    }

    mat4.mul(out, record.invMatrix, bone.matrix);
  }

  public calculateOffsetMatrixWorld(out: mat4, bone: Bone) {
    const recordWorld = this.boneInvMatrixWorlds[bone.uuid];

    if (!recordWorld) {
      mat4.identity(out);
      return;
    }

    mat4.mul(out, recordWorld.invMatrix, bone.matrixWorld);
  }

  public applyOffsetMatrix(bone: Bone, offsetMatrix: mat4) {
    const record = this.boneInvMatrices[bone.uuid];

    if (!record) {
      return;
    }

    mat4.invert(TEMP_MAT, record.invMatrix);

    mat4.mul(TEMP_MAT, TEMP_MAT, offsetMatrix);

    this.updateBoneTransform(bone, TEMP_MAT, record.parentScaleMat3);
  }

  public clearMatrices() {
    this.boneInvMatrices = {};
    this.boneInvMatrixWorlds = {};
  }
}
