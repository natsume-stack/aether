import JSZip from 'jszip';
import { IKPaletteSchema, IKPalette } from '@box/schema/animation/ik-schema';
import { AvatarIKState } from '../../avatar/models/interfaces';
import type { SkinPart } from '../../avatar/models/skin-part';
import {
  NodeSchema,
  ProjectDataSchema,
  ProjectNodeType,
  Vec3Schema,
} from '../../models/project/defs';
import { DEFAULT_PROJECT } from '../../models/project/default-project';
import { ROOT_BONE_ID } from '../../defs';
import { mat4, quat, vec3 } from 'gl-matrix';
import { BODY_PART_DEFAULT_SCALE } from '@box/schema/player/player-schema';
import { BodyPartName } from '../../avatar/models/defs';
import { getEuler } from '../../models/rendering/math/quat';

const URL_API = window.URL || window.webkitURL;

function download(uri: string, fileName: string) {
  const downloadLink = document.createElement('a');
  downloadLink.href = uri;
  downloadLink.download = fileName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
}

export async function exportSkinZip(
  skinParts: Map<string, SkinPart>,
  fileName: string,
) {
  const zip = new JSZip();
  for (const [, skinPart] of skinParts) {
    const blob = skinPart.getFileData();
    zip.file(`${skinPart.name.replace(/\s/g, '_')}.sp`, blob);
  }
  const zipContent = await zip.generateAsync({ type: 'blob' });
  const uri = URL_API.createObjectURL(zipContent);
  download(uri, `${fileName}.zip`);
  URL_API.revokeObjectURL(uri);
}

export function exportSkin(skinPart: SkinPart) {
  const blob = skinPart.getFileData();
  const fileName = `${skinPart.name.replace(/\s/g, '_')}.sp`;
  download(URL_API.createObjectURL(blob), fileName);
}

export function exportIKExtension(extension: Object) {
  const fileName = 'extension.json';
  const uri = `data:text/json;charset=utf-8,${JSON.stringify(extension)}`;
  download(uri, fileName);
}

export function exportIKPalette(ikPalette: IKPalette) {
  const fileName = 'player-anim.json';
  const uri = `data:text/json;charset=utf-8,${JSON.stringify(
    IKPaletteSchema.toJSON(ikPalette),
  )}`;
  download(uri, fileName);
}

export function exportVoxaProject(
  ikState: AvatarIKState,
  skinParts: Map<string, SkinPart>,
  skinProject: typeof ProjectDataSchema.identity,
) {
  const project = ProjectDataSchema.clone(DEFAULT_PROJECT);

  const boneIds: string[] = [];

  // 遍历骨骼节点，生成对应的骨骼数据，将骨骼节点先统一放入根目录中
  // 寻找骨骼节点对应的皮肤部件，将本工具生成的皮肤偏移量和voxa工程文件生成的皮肤体素数据相结合生成皮肤节点
  // 并将皮肤数据绑定到骨骼数据上
  Object.keys(ikState.configuration).forEach((boneName) => {
    const boneNode = NodeSchema.clone(NodeSchema.identity);
    // 生成骨骼数据
    // 骨骼名字就是其ID
    boneNode.id = boneName;
    boneNode.name = boneName;
    boneNode.type = ProjectNodeType.Bone;
    boneNode.parentId = ROOT_BONE_ID;

    unpackMatrixToNode(boneNode, ikState.configuration[boneName]);

    boneIds.push(boneName);
    project.nodes[boneNode.id] = boneNode;

    // 生成皮肤数据
    const skinPart = skinParts.get(boneName);
    const skinNode = Object.values(skinProject.nodes).find(
      (node) => node.name === boneName,
    );
    if (!skinPart || !skinNode) {
      console.warn(`找不到${boneName}的皮肤节点，但问题(应该)不大`);
      return;
    }

    unpackMatrixToNode(skinNode, skinPart.matrix, true);

    // 皮肤与骨骼绑定
    skinNode.parentId = '';
    skinNode.boneId = boneNode.id;
    boneNode.skinId = skinNode.id;

    project.nodes[skinNode.id] = skinNode;
  });

  // 骨骼节点先统一放入骨骼根目录
  project.nodes[ROOT_BONE_ID].childrenIds = boneIds;

  // voxa工程文件的皮肤体素数据和画板数据直接薅走，出错不管
  project.palette = skinProject.palette;
  project.voxels = skinProject.voxels;

  // 由于IK数据已经失去了骨骼的父子关系
  // 为了在voxa中页面展示，在这里重新制造假的骨骼父子关系
  fakeBonesChain(
    project,
    [
      BodyPartName.hips,
      BodyPartName.torso,
      BodyPartName.neck,
      BodyPartName.head,
    ],
    ROOT_BONE_ID,
  );

  fakeBonesChain(
    project,
    [
      BodyPartName.hips,
      BodyPartName.leftUpperLeg,
      BodyPartName.leftLowerLeg,
      BodyPartName.leftFoot,
    ],
    ROOT_BONE_ID,
  );

  fakeBonesChain(
    project,
    [
      BodyPartName.hips,
      BodyPartName.rightUpperLeg,
      BodyPartName.rightLowerLeg,
      BodyPartName.rightFoot,
    ],
    ROOT_BONE_ID,
  );

  fakeBonesChain(
    project,
    [
      BodyPartName.leftShoulder,
      BodyPartName.leftUpperArm,
      BodyPartName.leftLowerArm,
      BodyPartName.leftHand,
    ],
    BodyPartName.neck,
  );

  fakeBonesChain(
    project,
    [
      BodyPartName.rightShoulder,
      BodyPartName.rightUpperArm,
      BodyPartName.rightLowerArm,
      BodyPartName.rightHand,
    ],
    BodyPartName.neck,
  );

  const uri = `data:text/json;charset=utf-8,${JSON.stringify(
    ProjectDataSchema.toJSON(project),
  )}`;
  download(uri, 'avatar.json');
}

const INV_QUAT = quat.create();
function unpackMatrixToNode(
  out: typeof NodeSchema.identity,
  matrix: mat4,
  isSkin = false,
) {
  out.pivot = Vec3Schema.fromJSON([0, 0, 0]);
  mat4.getRotation(out.quaternion, matrix);
  mat4.getTranslation(out.position, matrix);
  // 与美术规定皮肤有默认缩放值，是所有的皮肤统一的缩放值
  // 而在voxa中没有缩放这个概念，因此在这里把骨骼和皮肤的位置统一按照缩放值放大回去
  vec3.scale(out.position, out.position, 1 / BODY_PART_DEFAULT_SCALE);
  getEuler(out.euler, out.quaternion);

  // 如果是皮肤文件，将position转为pivot存储
  if (isSkin) {
    quat.invert(INV_QUAT, out.quaternion);
    vec3.transformQuat(out.pivot, out.position, INV_QUAT);
    out.position = Vec3Schema.fromJSON([0, 0, 0]);
  }
}

const TEMP = mat4.create();
const PARENT_MATRIX = mat4.create();
const INVERT_PARENT_MATRIX = mat4.create();
/**
 * 做骨骼节点之间假的父子关系
 * @param out 输出修改过后的数据
 * @param boneNames 按照数组顺序依次成为父子关系。比如，boneNames[0]是父亲，boneNames[1]是儿子，boneNames[2]是孙子...
 * @param parentId parentId是整条链的新父亲，是爷爷
 */
function fakeBonesChain(
  out: typeof ProjectDataSchema.identity,
  boneNames: string[],
  parentId: string,
) {
  const { nodes } = out;
  const root = nodes[ROOT_BONE_ID];
  let parent = nodes[parentId];

  // 计算第一个bone父节点的worldMatrix，遍历父节点的父节点矩阵相乘即可
  let curr = parent;
  mat4.fromRotationTranslation(PARENT_MATRIX, curr.quaternion, curr.position);
  mat4.invert(INVERT_PARENT_MATRIX, PARENT_MATRIX);
  while (curr.parentId) {
    const currParent = nodes[curr.parentId];
    mat4.fromRotationTranslation(
      TEMP,
      currParent.quaternion,
      currParent.position,
    );

    mat4.mul(PARENT_MATRIX, TEMP, PARENT_MATRIX);
    mat4.invert(INVERT_PARENT_MATRIX, PARENT_MATRIX);
    curr = currParent;
  }

  // 遍历骨骼链，重组父子关系
  for (let i = 0; i < boneNames.length; i++) {
    const boneName = boneNames[i];
    const bone = nodes[boneName];
    mat4.fromRotationTranslation(TEMP, bone.quaternion, bone.position);

    mat4.copy(PARENT_MATRIX, TEMP);

    mat4.mul(TEMP, INVERT_PARENT_MATRIX, TEMP);
    mat4.getRotation(bone.quaternion, TEMP);
    mat4.getTranslation(bone.position, TEMP);

    mat4.invert(INVERT_PARENT_MATRIX, PARENT_MATRIX);

    // 解除原本根目录下的父子关系
    root.childrenIds.splice(root.childrenIds.indexOf(boneName), 1);
    // 生成新的父子关系
    parent.childrenIds.push(boneName);
    bone.parentId = parent.id;

    parent = bone;
  }
}
