import { vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { allocEmptyVoxels } from '@box/utils/helper';
import type { Pointer } from '../pointer';
import { ColorSelectMode } from './edit-mode/color-select';
import { FitResult, Model, VMOpts } from './model';
import { VoxelDimensionType } from '../project/interfaces';

/**
 * Voxel models to store voxels
 */
export class Models {
  /**
   * Model to render selection wireframe
   */
  public readonly selection: Model;
  public readonly editing: Model;
  public readonly destination: Model;
  public readonly colorSelectMode: ColorSelectMode;

  constructor(params: { pointer: Pointer; regl: Regl; baseArgs: VMOpts }) {
    const { regl, baseArgs, pointer } = params;

    this.selection = Models.createSelectionModel(regl, baseArgs);
    this.editing = new Model(regl, { name: 'editingModel', ...baseArgs });
    this.destination = new Model(regl, { name: 'destModel', ...baseArgs });

    this.colorSelectMode = new ColorSelectMode({
      models: {
        editing: this.editing,
        destination: this.destination,
        selection: this.selection,
      },
      pointer,
    });
  }

  private static createSelectionModel(regl: Regl, baseArgs: VMOpts) {
    const selectionModel = new Model(regl, {
      name: 'selectionModel',
      ...baseArgs,
      wireFrameColor: [1, 1, 1],
    });
    selectionModel.inflate = true;
    selectionModel.showGrid(true);
    return selectionModel;
  }

  public reset(size?: vec3) {
    if (size && !vec3.equals(size, this.selection.voxels.shape)) {
      this.reAlloc(size);
    } else {
      this.clear();
    }
  }

  public reAlloc(size: vec3) {
    this.selection.reAlloc(size);
    this.editing.reAlloc(size);
    this.destination.reAlloc(size);
  }

  public clear() {
    this.selection.clearVoxel();
    this.editing.clearVoxel();
    this.destination.clearVoxel();
  }

  public trim(): FitResult {
    const { changed, start } = this.destination.trim();

    if (changed) {
      const shape = this.destination.voxels.shape;

      this.selection.reAlloc(shape);
      this.selection.cleanMeshData();
      this.editing.reAlloc(shape);
    }

    return { changed, start };
  }

  public squashToTwoDimension(dimension: VoxelDimensionType) {
    const changed = this.destination.squashToTwoDimension(dimension);
    if (changed) {
      const shape = this.destination.voxels.shape;

      this.selection.reAlloc(shape);
      this.selection.cleanMeshData();
      this.editing.reAlloc(shape);
    }
  }

  /**
   * 模型空间伸缩的函数
   * 在x和z方向上坐标轴的中央作为伸缩的基准
   * 在y方向上以y=0的地方为伸缩的基准
   * @param size 变化后的空间大小
   * @returns
   */
  public resize(size: vec3, clearEditing: boolean = true) {
    const [x, y, z] = size;
    if (vec3.equals(size, this.destination.voxels.shape)) {
      return;
    }

    const newDestination = allocEmptyVoxels(x, y, z);
    const newSelection = allocEmptyVoxels(x, y, z);

    // 新空间下的x,z坐标
    let nx;
    let nz;
    // 原空间下的x,z坐标
    let px;
    let pz;
    // 新空间的三个方向上的大小
    let l;
    let h;
    let w;

    if (x > this.destination.voxels.shape[0]) {
      nx = Math.floor((x - this.destination.voxels.shape[0]) / 2);
      px = 0;
      l = this.destination.voxels.shape[0];
    } else if (x === this.destination.voxels.shape[0]) {
      nx = px = 0;
      l = this.destination.voxels.shape[0];
    } else {
      nx = 0;
      px = Math.floor((this.destination.voxels.shape[0] - x) / 2);
      l = x;
    }

    if (z > this.destination.voxels.shape[2]) {
      nz = Math.floor((z - this.destination.voxels.shape[2]) / 2);
      pz = 0;
      w = this.destination.voxels.shape[2];
    } else if (z === this.destination.voxels.shape[2]) {
      nz = pz = 0;
      w = this.destination.voxels.shape[2];
    } else {
      nz = 0;
      pz = Math.floor((this.destination.voxels.shape[2] - z) / 2);
      w = z;
    }

    h = Math.min(this.destination.voxels.shape[1], y);

    for (let i = nx, _i = px; i < nx + l; i++, _i++) {
      for (let j = 0, _j = 0; j < h; j++, _j++) {
        for (let k = nz, _k = pz; k < nz + w; k++, _k++) {
          newDestination.setVoxel(
            i,
            j,
            k,
            this.destination.voxels.getVoxel(_i, _j, _k),
          );
          newSelection.setVoxel(
            i,
            j,
            k,
            this.selection.voxels.getVoxel(_i, _j, _k),
          );
        }
      }
    }

    clearEditing && this.editing.reAlloc(size);
    this.selection.setVoxels(newSelection);
    this.destination.setVoxels(newDestination);
  }

  /**
   * 开启/隐藏体素网格
   */
  public toggleGrid(flag: boolean) {
    this.destination.showGrid(flag);
    this.editing.showGrid(flag);
  }
}
