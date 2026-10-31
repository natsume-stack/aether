import type { SkinPart } from './index';
import { store } from '../../redux/store';
import { AppMode } from 'apps/voxa/src/redux/app-slice';
import {
  AnimatorMode,
  PivotMode,
} from 'apps/voxa/src/redux/animator-slice';
import { LineBox } from '../line-box';

export class SkinPartBox extends LineBox {
  public declare readonly parent?: SkinPart;

  public updateMatrixWorld(force?: boolean): void {
    this.updateVisible();
    super.updateMatrixWorld(force);
  }

  private updateVisible() {
    const { app, animator } = store.getState();

    /**
     * 以下场景不显示框框
     * - 体素模式
     * - 物理编辑模式
     * - 模型中心点模式
     */
    if (
      app.mode === AppMode.Voxel ||
      animator.mode === AnimatorMode.HitBox ||
      animator.pivotMode === PivotMode.Model
    ) {
      this.visible = false;
      return;
    }
    this.visible = animator.boxesVisible;
  }
}
