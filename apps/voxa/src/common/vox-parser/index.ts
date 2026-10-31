import { mat3, vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';
import { allocEmptyVoxels } from '@box/utils/helper';
import parseMagicaVoxel from '../../models/parse-magica-voxel/src';
import type {
  GroupNode,
  ShapeNode,
  Size,
  TransformNode,
  VoxelPoint,
  VoxFile,
  Frame,
  OnParseSingleVox,
  GetColorIdx,
  VoxelInfo,
} from './interfaces';
import { absVec3 } from '../../utils/math';

const VOXEL_CENTER: vec3 = [0.5, 0.5, 0.5];

export class VoxParser {
  /**
   * 加载并解析.vox文件
   * 返回VoxFile
   * @param file
   * @returns
   */
  public async parseMagicaVoxel(file: File) {
    try {
      const buffer = await file.arrayBuffer();

      const voxFile: VoxFile = await parseMagicaVoxel(buffer);
      return voxFile;
    } catch (err) {
      console.error('Failed to import file', err);

      return;
    }
  }

  /**
   * 解析vox多部件文件
   * 解析到每个单部件的时候会执行回调onParseSingleVox
   * @param params
   * @returns
   */
  public parseVoxParts(params: {
    nTRN: TransformNode[];
    nGRP: GroupNode[];
    nSHP: ShapeNode[];
    XYZI: VoxelPoint[][];
    SIZE: Size[];
    /**
     * 解析到单部件时的回调
     */
    onParseSingleVox: OnParseSingleVox;
    /**
     * 通过原版颜色索引值获取新的颜色索引值
     * 可通过此方法在加载vox的时候更新颜色索引值
     * 选填，默认不修改颜色索引值
     */
    getColorIdx?: GetColorIdx;
    /**
     * 是否剪裁体素shape为偶数值，默认false
     * 诡异的入参，历史遗留问题
     *
     * 检查了一下体素旋转后的数据，理论上旋转体素的时候不应该floor Shape，旋转后的体素相对位置才是对的
     * avatar editor 导入皮肤的时候需要正确的体素相对位置，计算美术绘制的模型中心点偏移量
     *
     * 但不做floor的话position对不上了，原来voxa导入vox文件的功能出现错位
     * 暂时不解决这个问题，以入参的形式fix
     * 即：voxa导入入参true，avatar-editor导入入参false或者不入参
     */
    floorShape?: boolean;
  }) {
    const {
      nTRN,
      nGRP,
      nSHP,
      XYZI,
      SIZE,
      onParseSingleVox,
      getColorIdx,
      floorShape,
    } = params;

    const list: {
      node: TransformNode;
      parentId?: string;
    }[] = [
      {
        node: nTRN[0],
      },
    ];

    let firstGroupId: string | undefined;

    while (list.length) {
      const item = list.pop();

      if (!item) {
        break;
      }

      const parentId = item.parentId;

      const { childId, frames } = item.node;

      const { position, rotation } = this.getTransformByFrame(frames[0]);

      const nodeId = nanoid();

      let target: GroupNode | ShapeNode | undefined = this.findChildById(
        nGRP,
        childId,
      );

      const name = item.node.attributes?._name;

      if (target) {
        onParseSingleVox?.({
          nodeId,
          name,
          parentId,
          position,
          rotation,
        });

        if (!firstGroupId) {
          firstGroupId = nodeId;
        }

        // 把当前组的子节点放入迭代数组中
        target.child_ids.forEach((grpChildId) => {
          const node = this.findChildById(nTRN, grpChildId);

          node &&
            list.push({
              node,
              parentId: nodeId,
            });
        });
      } else {
        target = this.findChildById(nSHP, childId);

        if (target) {
          const modelId = target.models[0].id;
          const voxelInfo = this.parseVoxels({
            points: XYZI[modelId],
            size: SIZE[modelId],
            rotation,
            getColorIdx,
            floorShape,
          });

          onParseSingleVox?.({
            nodeId,
            name,
            parentId,
            position,
            rotation,
            voxelInfo,
          });
        }
      }
    }
    return firstGroupId;
  }

  private getVoxPosition(out: vec3, frameTranslate: string): vec3 {
    const [x, y, z] = frameTranslate.split(' ').map((p) => Number(p));

    return vec3.set(out, x, y, z);
  }

  /**
   * vox记录的rotation旋转矩阵为竖向矩阵
   * 而gl-matrix计算使用横向矩阵，因此不可以直接按原顺序赋值
   * 需要通过此方法转换
   * @param out
   * @param frameRotation
   * @returns
   */
  private getVoxRotation(out: mat3, frameRotation: mat3): mat3 {
    return mat3.set(
      out,
      frameRotation[0],
      frameRotation[3],
      frameRotation[6],
      frameRotation[1],
      frameRotation[4],
      frameRotation[7],
      frameRotation[2],
      frameRotation[5],
      frameRotation[8],
    );
  }

  /**
   * 生成一个旋转了体素点、调整了朝向并裁剪后的体素视图及相关数据。
   * @returns 体素视图及相关数据。 如果为空体素，则返回undefined
   */
  public parseVoxels(params: {
    points: VoxelPoint[];
    size: Size;
    rotation: mat3;
    /**
     * 通过原版颜色索引值获取新的颜色索引值
     * 可通过此方法在加载vox的时候更新颜色索引值
     * 选填，默认不修改颜色索引值
     */
    getColorIdx?: GetColorIdx;
    /**
     * 是否剪裁体素shape为偶数值，默认false
     * 诡异的入参，历史遗留问题
     *
     * 检查了一下体素旋转后的数据，理论上旋转体素的时候不应该floor Shape，旋转后的体素相对位置才是对的
     * avatar editor 导入皮肤的时候需要正确的体素相对位置，计算美术绘制的模型中心点偏移量
     *
     * 但不做floor的话position对不上了，原来voxa导入vox文件的功能出现错位
     * 暂时不解决这个问题，以入参的形式fix
     * 即：voxa导入入参true，avatar-editor导入入参false或者不入参
     */
    floorShape?: boolean;
  }): VoxelInfo | undefined {
    const {
      points,
      size: paramSize,
      rotation,
      getColorIdx,
      floorShape,
    } = params;

    const size = vec3.create();

    /**
     * 后续计算旋转的中心点
     */
    const center = vec3.create();

    vec3.set(size, paramSize.x, paramSize.y, paramSize.z);

    vec3.set(center, paramSize.x / 2, paramSize.y / 2, paramSize.z / 2);
    floorShape && vec3.floor(center, center);

    vec3.transformMat3(size, size, rotation);

    absVec3(size, size);

    const tempVec3 = vec3.create();

    vec3.scale(tempVec3, size, 0.5);
    floorShape && vec3.floor(size, size);

    const [halfX, halfY, halfZ] = tempVec3;

    const lo: vec3 = [-halfX, -halfY, -halfZ];
    const hi: vec3 = [halfX, halfY, halfZ];

    // 消除掉中心点非整数时的影响
    const shape: vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];

    // 记录坐标的最低点和最高点，用于后续计算裁剪。
    const boundaryStart: vec3 = [Infinity, Infinity, Infinity];
    const boundaryEnd: vec3 = [-Infinity, -Infinity, -Infinity];

    const voxelPoints: [number, number, number, number][] = [];

    for (const { x, y, z, c } of points) {
      vec3.set(tempVec3, x, y, z);

      vec3.sub(tempVec3, tempVec3, center);
      vec3.add(tempVec3, tempVec3, VOXEL_CENTER);

      vec3.transformMat3(tempVec3, tempVec3, rotation);

      vec3.sub(tempVec3, tempVec3, VOXEL_CENTER);
      vec3.sub(tempVec3, tempVec3, lo);

      let [vx, vy, vz] = tempVec3;

      vy = shape[1] - vy;

      vec3.set(tempVec3, vx, vz, vy);

      vec3.min(boundaryStart, boundaryStart, tempVec3);
      vec3.max(boundaryEnd, boundaryEnd, tempVec3);

      voxelPoints.push([
        tempVec3[0],
        tempVec3[1],
        tempVec3[2],
        getColorIdx ? getColorIdx(c) : c,
      ]);
    }

    if (
      boundaryEnd[0] < boundaryStart[0] &&
      boundaryEnd[1] < boundaryStart[1] &&
      boundaryEnd[2] < boundaryStart[2]
    ) {
      return;
    }

    vec3.sub(tempVec3, boundaryEnd, boundaryStart);
    vec3.add(tempVec3, tempVec3, [1, 1, 1]);

    const voxels = allocEmptyVoxels(tempVec3[0], tempVec3[1], tempVec3[2]);

    voxelPoints.forEach(([x, y, z, textureId]) => {
      voxels.setVoxel(
        x - boundaryStart[0],
        y - boundaryStart[1],
        z - boundaryStart[2],
        textureId,
      );
    });

    return {
      voxels,
      boundaryStart,
      originShape: [shape[0], shape[2], shape[1]],
    };
  }

  public findChildById<T extends TransformNode | ShapeNode | GroupNode>(
    nodes: T[],
    id: number,
  ): T | undefined {
    return nodes.find(({ id: nodeId }) => nodeId === id);
  }

  public getTransformByFrame(frame: Frame): {
    position: vec3;
    rotation: mat3;
  } {
    const { _t, _r } = frame;

    const position = vec3.create();

    const rotation = mat3.create();

    _t && this.getVoxPosition(position, _t);

    _r && this.getVoxRotation(rotation, _r);

    return { position, rotation };
  }
}
