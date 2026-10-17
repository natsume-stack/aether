import { vec3 } from 'gl-matrix';
import { store } from '../../../redux/store';
import { EditingMode } from '@box/utils/helper';
import { VoxelView } from '@box/utils/voxel';
import type { Model } from '../../voxel-model/model';
import type { Operation } from '../mode/interfaces';
import { composeSymmetryOperation, isEmptyVoxel } from '../util';
import { BasicTool, Params } from './base';

/**
 * 色刷工具。
 * 对应Actions.Paint
 */
export class Painter extends BasicTool {
  protected supportedModes: EditingMode[] = [
    EditingMode.voxel,
    EditingMode.line,
  ];

  private started = false;

  /**
   * 缓存记录的数据，切换模式时，用于恢复数据
   */
  private collectionBackup?: vec3[] = undefined;

  /**
   * 在pointerDown中保留的数据
   */
  private preservedPointerData = {
    voxelPos: vec3.fromValues(-1, -1, -1),
    textureId: 0,
  };

  private operation?: Operation;

  private modelChanged = false;

  private changedVoxels: vec3[] = [];

  constructor(params: Params) {
    super(params);

    this.mode = EditingMode.voxel;
  }

  protected onEnabled(): void {
    this.updateCollectorLimit();
  }

  protected onDisabled(): void {
    this.clear();
  }

  protected onAbort(): void {
    this.started && this.clear();
  }

  public start = () => {
    this.started = true;

    this.collector.clear();

    const voxelPos = this.pointer.getVoxelPos();

    this.collector.addPosition(voxelPos);

    const srcModel = this.getPointingModel();

    if (!srcModel) {
      return;
    }

    this.updatePreservedData(srcModel, voxelPos);

    this.activate(srcModel);
  };

  public update = () => {
    if (!this.started) {
      return;
    }

    const voxelPos = this.pointer.getVoxelPos();

    this.collector.addPosition(voxelPos);

    if (!this.collector.iseEmptySrc()) {
      this.render();

      return;
    }

    const srcModel = this.getPointingModel();

    if (!srcModel) {
      return;
    }

    this.activate(srcModel);
  };

  public end = () => {
    this.started = false;

    const srcModel = this.collector.getSrc();

    if (!srcModel) {
      return;
    }

    this.operation = undefined;

    this.collectionBackup = undefined;

    srcModel.voxels.copy(this.modelsDict.editing.voxels);

    if (this.modelChanged) {
      this.saveHistory();
    }

    this.clear();
  };

  private render() {
    const model = this.collector.getSrc();

    if (!model) {
      return;
    }

    const { editing } = this.modelsDict;

    const operation = this.createOperation(editing.voxels);

    const collection = this.collector.getCollection();

    switch (this.mode) {
      case EditingMode.voxel:
        this.editModes.line.parse({
          operation,
          collection,
          startIdx: this.collector.getIndex(),
        });

        this.collector.setIndex(collection.length - 1);
        break;
      case EditingMode.line: {
        this.resetChangedVoxels(model.voxels);

        this.editModes.line.parse({
          operation,
          collection,
        });

        break;
      }
    }

    this.modelsDict.editing.bakeData();
  }

  private updateCollectorLimit() {
    if (this.mode === EditingMode.voxel) {
      this.collector.setLimit(Infinity);
    } else {
      this.collector.setLimit(2);
    }
  }

  protected onModeChanged() {
    const model = this.collector.getSrc();

    if (!model) {
      this.updateCollectorLimit();
      return;
    }

    const currentCollection = this.collector.getCollection();

    const newBackup = currentCollection.slice();

    let newCollection = this.collectionBackup
      ? this.collectionBackup
      : currentCollection;

    newCollection = newCollection.slice();

    const lastOfCurrent = currentCollection[currentCollection.length - 1];

    if (this.mode === EditingMode.voxel) {
      this.resetChangedVoxels(model.voxels);

      this.collector.setIndex(0);
    } else {
      newCollection.splice(1, newCollection.length - 2);
    }

    this.updateCollectorLimit();

    this.collector.setCollection(newCollection);

    lastOfCurrent && this.collector.addPosition(lastOfCurrent);

    this.collectionBackup = newBackup;

    this.render();
  }

  /**
   * 双击修改“面”的颜色。所有操作在双击中完成。
   */
  public paintFace = () => {
    const model = this.getPointingModel();

    if (!model) {
      return;
    }

    const { textureId: hitTextureId } = this.preservedPointerData;

    const newTextureId = store.getState().palette.selectedId;

    if (newTextureId === hitTextureId) {
      this.clearPreservedData();

      return;
    }

    this.clear();

    const startPos = this.pointer.getVoxelPos();

    const hitNormal = this.pointer.getNormal();

    const operation = this.createOperation(model.voxels);

    this.editModes.face.parse({
      voxelView: model.voxels,
      startPos,
      hitNormal,
      options: {
        type: 'hitTextureId',
        hitTextureId,
      },
      operation,
    });

    this.clearPreservedData();

    model.bakeData();

    this.clear();
  };

  /**
   * 根据体素模型启动色刷。
   * 可能在pointerDown和pointerMove中启动。
   */
  private activate(model: Model) {
    this.collector.setSrc(model);

    this.modelsDict.editing.blockRender(false);

    model.blockRender(true);

    this.render();
  }

  private clearPreservedData() {
    vec3.set(this.preservedPointerData.voxelPos, -1, -1, -1);

    this.preservedPointerData.textureId = 0;
  }

  private updatePreservedData(model: Model, voxelPos: vec3) {
    vec3.copy(this.preservedPointerData.voxelPos, voxelPos);

    const [x, y, z] = voxelPos;

    this.preservedPointerData.textureId = model.voxels.getVoxel(x, y, z);
  }

  /**
   * 查询全局状态，创建operation。比如镜像模式。
   */
  private createOperation(voxels: VoxelView): Operation {
    if (!this.operation) {
      const textureId = store.getState().palette.selectedId;

      let operation: Operation = ({ pos: [x, y, z] }) => {
        const idx = voxels.index(x, y, z);

        if (isEmptyVoxel(voxels.data[idx])) {
          return;
        }

        voxels.data[idx] = textureId;

        this.modelChanged = true;

        this.changedVoxels.push([x, y, z]);
      };

      const { mirrorMode } = store.getState().editing;

      this.operation = composeSymmetryOperation({
        opts: mirrorMode,
        range: voxels.getDimension(),
        operation,
      });
    }

    return this.operation;
  }

  private clear() {
    this.operation = undefined;

    this.modelChanged = false;

    this.changedVoxels = [];

    const srcModel = this.collector.getSrc();

    srcModel?.blockRender(false);

    srcModel?.bakeData();

    this.modelsDict.editing.blockRender(true);

    this.collector.clear();
  }

  /**
   * 点和线模式下，重置修改过的体素点。
   */
  private resetChangedVoxels(srcVoxelView: VoxelView) {
    if (this.changedVoxels.length === 0) {
      return;
    }

    const editing = this.modelsDict.editing.voxels;

    this.changedVoxels.forEach(([x, y, z]) => {
      const index = srcVoxelView.index(x, y, z);

      editing.data[index] = srcVoxelView.data[index];
    });

    this.changedVoxels = [];
  }
}
