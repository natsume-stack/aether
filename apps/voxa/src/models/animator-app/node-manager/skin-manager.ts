import { nanoid } from 'nanoid';
import { mat3, quat, vec3 } from 'gl-matrix';

import { FlipAxis, ProjectNodeType } from '../../../redux/animator-slice';
import { ProjectNode } from '../../project/interfaces';
import { Object3D } from '../../rendering/objects/object3d';
import { SkinPart } from '../../skin-part';
import type { Stage } from '../../stage';
import type { VoxelManager } from '../../voxel-app/voxel-manager';
import { store } from '../../../redux/store';
import { DEFAULT_SPACE_SIZE } from '../../../defs';
import { makeNewGroup, resetObjTransform, isSkinPart } from '../util';
import { Group } from '../../rendering/objects/group';
import { SkinNode, UpdateData } from './interface';
import { voxelShapeToObjSize } from 'apps/voxa/src/utils/math';

export class SkinManager {
  public readonly skin: Object3D;

  public map: Map<string, SkinNode> = new Map<string, SkinNode>();

  constructor(private stage: Stage, private voxelManager: VoxelManager) {
    this.skin = new Object3D();
  }

  public clear() {
    this.skin.clear();

    this.map.clear();
  }

  public loadSkinPart(node: ProjectNode) {
    const size = vec3.create();
    vec3.copy(size, DEFAULT_SPACE_SIZE);
    let rawMeshBuffer: Uint16Array | undefined;

    if (node.voxelId) {
      const voxel = this.voxelManager.map.get(node.voxelId);

      if (voxel) {
        vec3.copy(
          size,
          voxelShapeToObjSize(voxel.voxelView.shape, voxel.dimension),
        );

        const [x, y, z] = node.flip;
        const res = this.voxelManager.getVoxelMesh(node.voxelId, [x, y, z]);

        rawMeshBuffer = res?.rawMeshBuffer;
      }
    }

    const skinPart = new SkinPart(
      this.stage.regl,
      node.id,
      size,
      rawMeshBuffer,
    );
    vec3.copy(skinPart.pivot, node.pivot);
    vec3.copy(skinPart.position, node.position);
    quat.copy(skinPart.quaternion, node.quaternion);
    vec3.copy(skinPart.rotateAngles, node.euler);
    vec3.copy(skinPart.scale, node.scale);
    mat3.copy(skinPart.parentScaleMat3, node.parentScaleMat3);
    skinPart.alpha = node.alpha;

    return skinPart;
  }

  public loadGroup(node: ProjectNode) {
    const group = new Group(node.id);

    vec3.copy(group.pivot, node.pivot);
    vec3.copy(group.position, node.position);
    quat.copy(group.quaternion, node.quaternion);
    vec3.copy(group.rotateAngles, node.euler);
    vec3.copy(group.scale, node.scale);
    mat3.copy(group.parentScaleMat3, node.parentScaleMat3);

    return group;
  }

  public addSkinPart(parentId: string, size = DEFAULT_SPACE_SIZE) {
    const parent = this.map.get(parentId) || this.skin;
    const newId = nanoid();

    const newSkin = new SkinPart(this.stage.regl, newId, size);
    vec3.set(newSkin.pivot, -size[0] / 2, -size[1] / 2, -size[2] / 2);
    this.map.set(newId, newSkin);
    parent.add(newSkin);
    newSkin.updateMatrixWorld();
    newSkin.setPositionByWorldPosition([0, size[1] / 2, 0]);
    return newSkin;
  }

  public updateSkinPart(id: string, data: Partial<UpdateData>) {
    const { hierarchyData } = store.getState().animator;

    const node = hierarchyData[id];
    const skinNode = this.map.get(id);
    if (
      !node ||
      !skinNode ||
      !isSkinPart(skinNode) ||
      node.type !== ProjectNodeType.SkinPart
    ) {
      return;
    }

    if (
      data.size &&
      !vec3.equals(data.size, skinNode.skinPartBox.geometry.size)
    ) {
      skinNode.updateSize(data.size);
    }

    if (data.voxelId) {
      const newRawMeshBuffer = this.voxelManager.getVoxelMesh(
        data.voxelId,
        node.flip,
      )?.rawMeshBuffer;

      newRawMeshBuffer && skinNode.skinPartMesh.updateBuffer(newRawMeshBuffer);
    }
  }

  public addGroup(childrenIds: string[], parentId: string) {
    const newGroup = new Group(nanoid());

    this.map.set(newGroup.uuid, newGroup);

    makeNewGroup(newGroup, childrenIds, (id) => this.map.get(id));

    newGroup.updateWorldMatrix(false, false);

    const parent = this.map.get(parentId) || this.skin;

    resetObjTransform(parent.matrixWorld, newGroup);

    parent.add(newGroup);

    return newGroup;
  }

  public flipSkinPart(id: string, axis: FlipAxis) {
    const { hierarchyData } = store.getState().animator;
    const node = hierarchyData[id];
    const skinNode = this.map.get(id);
    // 只有部件才能翻转
    if (
      !node ||
      !skinNode ||
      !isSkinPart(skinNode) ||
      node.type !== ProjectNodeType.SkinPart
    ) {
      return;
    }

    // 首先处理体素的翻转
    if (node.voxelId) {
      const res = this.voxelManager.getVoxelMesh(node.voxelId, node.flip);

      res && skinNode.skinPartMesh.updateBuffer(res.rawMeshBuffer);
    }

    // 接下来处理翻转带来的副作用。
    // 中心点，位置，旋转的偏移

    // 翻转修改每个部件的位置和旋转
    const newPos = vec3.create();
    const newQuat = quat.create();

    // 获取当前部件中心点位置的世界坐标
    vec3.copy(newPos, skinNode.getWorldPivot());

    // 翻转位置
    newPos[axis] = -newPos[axis];

    // 将当前部件世界旋转数值翻转
    const getNewEuler = (eulerIndex: number) => {
      return axis === eulerIndex
        ? skinNode.worldRotateAngles[eulerIndex]
        : 360 - skinNode.worldRotateAngles[eulerIndex];
    };
    quat.fromEuler(newQuat, getNewEuler(0), getNewEuler(1), getNewEuler(2));

    // 将世界坐标转为部件坐标，并赋值

    // 必须先设置pos后设置quat
    // 因为quat会影响setPositionByWorldPosition计算结果，而pos不会影响setQuaternionByWorldQuaternion的计算结果
    // 如果先设置quat后设置pos，就需要在设置quat后调用updateMatrixWorld，再设置pos。有点没必要，保证顺序即可
    skinNode.setPositionByWorldPosition(newPos);
    skinNode.setQuaternionByWorldQuaternion(newQuat);

    // 翻转部件的中心点
    const shift = vec3.create();
    vec3.scale(shift, skinNode.skinPartBox.geometry.size, -0.5);
    skinNode.pivot[axis] = 2 * shift[axis] - skinNode.pivot[axis];

    skinNode.updateMatrixWorld();
  }
}
