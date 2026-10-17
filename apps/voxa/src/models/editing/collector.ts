import { vec3 } from 'gl-matrix';
import type { Model } from '../voxel-model/model';

type CollectorParams = {
  editingModel: Model;
};

/**
 * 负责记录编辑中的数据，比如：
 * mousemove中的voxelPos、
 * 当前编辑的数据源（destination / selection）
 */
export class EditingCollector {
  /**
   * 保存编辑的体素点
   * 比如paint时，保存mousemove经过的体素点，用于计算线段
   */
  private voxelPositions: vec3[] = [];
  /**
   * 体素点指针，指向voxelPositions中当前编辑的体素点。
   * 比如绘制线的操作，并不需要每次都把所有点之间的线重新绘制，只需要绘制新的即可。
   * 用这个指针记录上一次操作的位置。
   */
  private voxelPosIdx: number = 0;

  private limit = Infinity;

  /**
   * 编辑editing体素模型时，参照的源体素模型
   */
  private srcVoxel?: Model;

  private editingModel: Model;

  constructor(params: CollectorParams) {
    const { editingModel } = params;

    this.editingModel = editingModel;
  }

  /**
   * 记录数据。会对比当前数据与前一个数据，如果相同，则不记录。
   * 当超过记录上限时，清理数据，再记录。
   */
  public addPosition(pos: vec3) {
    const prev = this.voxelPositions[this.voxelPositions.length - 1];

    if (prev && vec3.exactEquals(prev, pos)) {
      return;
    }

    if (this.voxelPositions.length >= this.limit) {
      this.makeSpace(1);
    }

    this.voxelPositions.push(pos);
  }

  /**
   * 设置记录的上限，如果新上限小于当前上限，会清理掉多余的数据
   */
  public setLimit(num: number) {
    if (this.limit === num) {
      return;
    }

    if (this.limit > num) {
      this.makeSpace(this.limit - num);
    }

    this.limit = num;
  }

  /**
   * 清理已有的数据，腾出空间
   * 根据当前模式不同，清理方式不同。
   * @param size 要增加的空间大小
   */
  private makeSpace(size: number) {
    const length = this.voxelPositions.length;

    this.voxelPositions.splice(length - size, size);
  }

  /**
   * 清空当前记录的所有编辑数据
   */
  public clear() {
    // 保持this.voxelPositions引用不变
    this.voxelPositions.splice(0);

    this.voxelPosIdx = 0;

    this.srcVoxel = undefined;
  }

  public getCollection() {
    return this.voxelPositions;
  }

  public setCollection(collection: vec3[]) {
    this.voxelPositions.splice(0, this.voxelPositions.length, ...collection);
  }

  /**
   * 获取索引。
   */
  public getIndex() {
    return this.voxelPosIdx;
  }

  public setIndex(idx: number) {
    this.voxelPosIdx = Math.min(idx, this.voxelPositions.length - 1);
    this.voxelPosIdx = Math.max(idx, 0);
  }

  /**
   * 设置编辑时的源体素模型。并把源体素模型的视图复制到editing中。
   * @param model 源体素模型
   */
  public setSrc(model: Model) {
    if (this.srcVoxel === model) {
      return;
    }

    this.srcVoxel = model;

    this.editingModel.voxels.copy(this.srcVoxel.voxels);

    vec3.copy(this.editingModel.wireFrameColor, this.srcVoxel.wireFrameColor);

    this.editingModel.showGrid(this.srcVoxel['_renderGrid']);
  }

  /**
   * 获取当前编辑参照的源体素模型
   */
  public getSrc() {
    return this.srcVoxel;
  }

  /**
   * 把editing重置回srcModel
   */
  public resetToSrc() {
    if (!this.srcVoxel) {
      return;
    }

    this.editingModel.voxels.copy(this.srcVoxel.voxels);
  }

  /**
   * 判断当前是否未设置srcModel
   */
  public iseEmptySrc() {
    return this.srcVoxel === undefined;
  }
}
