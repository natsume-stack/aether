import { mat3, quat, vec3 } from 'gl-matrix';
import type { Regl, Texture2D } from '@box/regl';
import type { Object3D } from '../../models/rendering/objects/object3d';
import type {
  ModelMesh,
  ModelMeshes,
  ModelNode,
  ModelNodes,
  MeshTexture,
} from '../interfaces';
import { unpackMeshData, unpackTextureData } from '@box/mesher';
import { Group } from '../../models/rendering/objects/group';
import { GLTexture, SkinPartMesh } from '../skin-part-mesh';

const UNPACK_TEXTURE_CHANNELS = [24, 16, 8, 0];

type LoaderParams = {
  regl: Regl;
};

export class Loader {
  private regl: Regl;

  constructor(params: LoaderParams) {
    const { regl } = params;

    this.regl = regl;
  }

  public loadTexture(meshTexture: MeshTexture): GLTexture {
    const { data, width } = meshTexture;

    const height = data.length / width;

    const textureData = unpackTextureData(meshTexture, UNPACK_TEXTURE_CHANNELS);

    return {
      texture: this.regl.texture({
        data: textureData,
        width,
        height,
        wrap: 'clamp',
      }),
      data: textureData,
      height,
      width,
    };
  }

  public loadNodes(data: {
    nodes: ModelNodes;
    meshes: ModelMeshes;
    glTexture: GLTexture;
    parent: Object3D;
  }) {
    const { nodes, meshes, glTexture, parent } = data;

    const uvDataType = getUvDataType(glTexture.texture);

    this.loadNode({
      idx: 0,
      meshes,
      nodes,
      glTexture,
      uvDataType,
      parent,
    });
  }

  private loadNode(params: {
    idx: number;
    meshes: ModelMeshes;
    glTexture: GLTexture;
    nodes: ModelNodes;
    parent: Object3D;
    uvDataType: Uint16ArrayConstructor | Uint8ArrayConstructor;
  }) {
    const { idx, nodes, meshes, glTexture, uvDataType, parent } = params;

    const node = nodes[idx];

    if (node.mesh > -1 && meshes[node.mesh]) {
      const skinPart = this.loadSkinPart({
        node,
        meshData: meshes[node.mesh],
        glTexture,
        uvDataType,
      });

      parent.add(skinPart);

      return;
    }

    if (node.children.length > 0) {
      const group = this.loadGroup(node);

      parent.add(group);

      node.children.forEach((childIdx) => {
        this.loadNode({
          idx: childIdx,
          nodes,
          meshes,
          glTexture,
          uvDataType,
          parent: group,
        });
      });
    }
  }

  private loadSkinPart(params: {
    node: ModelNode;
    meshData: ModelMesh;
    glTexture: GLTexture;
    uvDataType: Uint16ArrayConstructor | Uint8ArrayConstructor;
  }) {
    const { node, meshData, glTexture, uvDataType } = params;

    const unpack = unpackMeshData(meshData, Uint8Array, uvDataType);

    const skinPart = new SkinPartMesh(this.regl, {
      renderData: { mesh: unpack, glTexture },
    });

    vec3.copy(skinPart.position, node.translation);
    quat.copy(skinPart.quaternion, node.rotation);
    vec3.copy(skinPart.scale, node.scale);
    mat3.copy(skinPart.parentScaleMat3, node.parentScaleMat3);
    skinPart.alpha = node.alpha;

    return skinPart;
  }

  private loadGroup(node: ModelNode) {
    const group = new Group();

    vec3.copy(group.position, node.translation);
    quat.copy(group.quaternion, node.rotation);
    vec3.copy(group.scale, node.scale);
    mat3.copy(group.parentScaleMat3, node.parentScaleMat3);

    return group;
  }
}

/**
 * 用于确定texture数组类型
 */
function getUvDataType(texture: Texture2D) {
  const { width, height } = texture;

  return Math.max(width, height) > 255 ? Uint16Array : Uint8Array;
}
