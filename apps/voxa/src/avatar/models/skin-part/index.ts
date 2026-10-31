import { mat4, vec3 } from 'gl-matrix';
import { Regl, Texture2D } from '@box/regl';
import { unpackTextureData, unpackMeshData } from '@box/mesher';
import { MeshTextureSchema, MeshDataSchema } from '@box/mesher/schema';
import { MuReadStream, MuWriteStream } from '@box/mudb/stream';
import { PlayerSkinPartSchema } from '@box/schema/mesh/skin-schema';
import { BodyPart } from '@box/schema/player/player-schema';
import type { BodyPartName } from '../defs';
import { Object3D } from '../../../models/rendering/objects/object3d';
import { Box3 } from '../../../models/rendering/math/box3';

import { SkinPartMesh } from '../../../common/skin-part-mesh';

export interface ISkinPartOptions {
  name: keyof typeof BodyPartName;
  regl: Regl;
}

const UNPACK_TEXTURE_CHANNELS = [24, 16, 8, 0];

export interface MeshData {
  mesh: typeof MeshDataSchema.identity;
  texture: typeof MeshTextureSchema.identity;
}

export class SkinPart extends Object3D {
  public voxelBox = new Box3();
  public name: keyof typeof BodyPartName;

  private skinPartMesh: SkinPartMesh;
  private regl: Regl;
  private meshData?: MeshData;

  constructor(opt: ISkinPartOptions) {
    super();
    this.name = opt.name;
    this.regl = opt.regl;

    this.skinPartMesh = new SkinPartMesh(opt.regl, { lightType: 'front' });
    this.add(this.skinPartMesh);
  }

  public makeEmpty() {
    this.meshData = undefined;
    this.voxelBox.makeEmpty();
    this.resetMatrix();
    this.skinPartMesh.update();
  }

  public updateByMeshData(meshData: MeshData, bindMat?: mat4) {
    this.makeEmpty();
    if (!meshData.mesh.length) {
      return;
    }
    this.meshData = meshData;
    const { unpack, glTexture } = this.unpackMeshes(this.meshData);
    this.skinPartMesh.update({
      mesh: unpack,
      glTexture,
    });
    if (bindMat) {
      this.setMatrixByBind(bindMat);
    }
  }

  public updateByFileData(fileData: Uint8Array) {
    this.makeEmpty();
    const stream = new MuReadStream(fileData);
    const schema = PlayerSkinPartSchema.patch(
      PlayerSkinPartSchema.identity,
      stream,
    );
    if (!schema.mesh.length) {
      return;
    }
    this.meshData = {
      mesh: schema.mesh,
      texture: schema.texture,
    };
    const { unpack, glTexture } = this.unpackMeshes(this.meshData);
    this.skinPartMesh.update({
      mesh: unpack,
      glTexture,
    });

    this.setMatrixByBind(schema.bindMat);
  }

  private resetMatrix() {
    this.setPosition(0, 0, 0);
    this.setQuaternion(0, 0, 0);
    vec3.set(this.pivot, 0, 0, 0);
    vec3.set(this.scale, 1, 1, 1);
  }

  private setMatrixByBind(bindMat: mat4) {
    mat4.getScaling(this.scale, bindMat);
    // 任意一个轴向的缩放值为0时，说明当前此部件不显示
    // 不需要再计算RT值，直接清零返回
    // 如果往下计算 mat4.getRotation 方法会喜提NaN，导致后续渲染数据有问题
    if (!this.scale[0] || !this.scale[1] || !this.scale[2]) {
      return;
    }
    mat4.getTranslation(this.position, bindMat);
    mat4.getRotation(this.quaternion, bindMat);
  }

  private unpackMeshes(meshesData: MeshData) {
    const { data, width } = meshesData.texture;

    const height = data.length / width;
    const textureData = unpackTextureData(
      meshesData.texture,
      UNPACK_TEXTURE_CHANNELS,
    );
    const texture2D = this.regl.texture({
      data: textureData,
      width,
      height,
      wrap: 'clamp',
    });

    const uvDataType = this.getUvDataType(texture2D);
    const unpack = unpackMeshData(meshesData.mesh, Uint8Array, uvDataType);

    vec3.set(this.voxelBox.min, unpack.lox, unpack.loy, unpack.loz);
    vec3.set(this.voxelBox.max, unpack.hix, unpack.hiy, unpack.hiz);

    return {
      unpack,
      glTexture: {
        texture: texture2D,
        data: textureData,
        width,
        height,
      },
    };
  }
  /**
   * 用于确定texture数组类型
   */
  private getUvDataType(texture: Texture2D) {
    const { width, height } = texture;

    return Math.max(width, height) > 255 ? Uint16Array : Uint8Array;
  }

  public getFileData() {
    const skinSchema = PlayerSkinPartSchema.clone(
      PlayerSkinPartSchema.identity,
    );
    skinSchema.partId = BodyPart[this.name];

    if (!this.meshData) {
      return new Blob([this.toBytes(skinSchema)], {
        type: 'application/octet-stream',
      });
    }
    skinSchema.mesh = this.meshData.mesh;
    skinSchema.texture = this.meshData.texture;
    mat4.copy(skinSchema.bindMat, this.matrix);

    return new Blob([this.toBytes(skinSchema)], {
      type: 'application/octet-stream',
    });
  }

  private toBytes(value: typeof PlayerSkinPartSchema.identity) {
    const ws = new MuWriteStream(1);
    PlayerSkinPartSchema.diff(PlayerSkinPartSchema.identity, value, ws);
    const bytes = ws.bytes();
    ws.destroy();
    return bytes;
  }
}
