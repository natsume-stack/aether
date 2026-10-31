import { setSelectedId } from '../../../redux/palette-slice';
import { store } from '../../../redux/store';
import type { Actions, EditingMode } from '@box/utils/helper';
import type { SetTool } from '../../voxel-app/interfaces';
import { BasicTool, Params } from './base';

interface InitParams extends Params {
  setTool: SetTool;
}

export class VoxelColorPicker extends BasicTool {
  protected ignoreMode: boolean = true;

  private prevToolType?: Actions;
  private prevMode?: EditingMode;

  private setTool: SetTool;

  constructor({ setTool, ...base }: InitParams) {
    super(base);

    this.setTool = setTool;
  }

  protected onEnabled(): void {
    const { toolType, mode } = store.getState().editing;

    this.prevToolType = toolType;
    this.prevMode = mode;
  }

  public start() {
    const model = this.getPointingModel();

    if (!model) {
      return;
    }

    const [x, y, z] = this.pointer.getVoxelPos();

    const textureId = model.voxels.getVoxel(x, y, z);

    store.dispatch(setSelectedId(textureId));

    this.setTool({
      toolType: this.prevToolType,
      mode: this.prevMode,
    });
  }
}
