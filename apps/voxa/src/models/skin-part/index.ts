import type { Regl } from '@box/regl';
import type { Intersection, Raycaster } from '../rendering/raycast';
import { vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';

import { Object3D } from '../rendering/objects/object3d';
import { SkinPartAOMesh } from './skin-part-mesh';
import { SkinPartBox } from './skin-part-box';
import { store } from '../../redux/store';
import { AppMode, PointerAction } from '../../redux/app-slice';
import {
  ModelUnitType,
  isSkinPartEmissive,
  isSkinPartInteractive,
} from '../animator-app/util';
import { HighlightBox } from './highlight-box';
import { AnimatorMode, PivotMode } from '../../redux/animator-slice';

const DEFAULT_COLOR = [1, 1, 1, 0.3];
const HOVER_COLOR = [1, 1, 1, 1];
const ACTIVE_COLOR = [0.98, 0.91, 0.26, 1];
const RELATIVE_COLOR = [0.64, 0.52, 0.03, 1];
// 高亮闪烁动画持续6秒
const HIGHLIGHT_DURATION = 6000;

const TEMP_VEC3 = vec3.create();

export class SkinPart extends Object3D {
  public readonly modelUnitType: ModelUnitType = ModelUnitType.skinPart;

  public readonly skinPartMesh: SkinPartAOMesh;
  public readonly skinPartBox: SkinPartBox;
  private highlight?: HighlightBox;

  public alpha = 1;

  // 虽然SkinPart自身不渲染任何东西，但需要调用到draw方法更新children的状态
  protected frustumCulled = false;

  constructor(
    private regl: Regl,
    uuid: string,
    size: vec3,
    rawMeshBuffer?: Uint16Array,
  ) {
    super(uuid);
    this.skinPartBox = new SkinPartBox(this.regl, size);
    this.skinPartMesh = new SkinPartAOMesh(
      this.regl,
      this.skinPartBox.geometry,
      rawMeshBuffer,
    );

    this.add(this.skinPartMesh);
    this.add(this.skinPartBox);
    // 默认轴心在部件的中心点
    vec3.scale(this.pivot, size, -0.5);
  }

  public raycast(out: Intersection[], raycaster: Raycaster): void {
    const result = this.skinPartBox.raycastTest(raycaster);
    if (result) {
      out.push({
        absPos: result.absPos,
        voxelPos: result.voxelPos,
        normal: result.normal,
        distance: result.distance,
        object: this,
      });
    }
  }

  public draw() {
    this.skinPartBox.color = this.getColor();

    const { mode } = store.getState().app;

    this.skinPartMesh.alpha = this.getMeshAlpha();

    this.skinPartMesh.visible = this.getVisible();

    this.skinPartMesh.emissive = isSkinPartEmissive();

    this.skinPartBox.alpha = this.skinPartBox.color === DEFAULT_COLOR ? 0.3 : 1;

    // 高亮闪烁动画持续6秒后/截图时/切换值体素模式时消失
    if (
      this.highlight &&
      (Date.now() - this.highlight.startTime > HIGHLIGHT_DURATION ||
        mode === AppMode.Voxel)
    ) {
      this.remove(this.highlight);
      this.highlight = undefined;
    }
  }

  private getVisible() {
    const { mode, editingSkinPartId } = store.getState().app;
    // 体素模式下，当前编辑的部件不可见
    const invisible = mode === AppMode.Voxel && editingSkinPartId === this.uuid;
    return !invisible;
  }

  private getMeshAlpha() {
    const { mode } = store.getState().app;
    const { pivotMode, mode: animatorMode } = store.getState().animator;
    switch (mode) {
      case AppMode.Voxel:
        return this.alpha * 0.3;
      case AppMode.Animator:
        const pivotBackground =
          (pivotMode === PivotMode.SkinNode &&
            this.skinPartBox.color !== ACTIVE_COLOR) ||
          pivotMode === PivotMode.Model;
        if (pivotBackground || animatorMode === AnimatorMode.HitBox) {
          return 0.3;
        }
    }
    return this.alpha;
  }

  private getColor() {
    if (!isSkinPartInteractive()) {
      return DEFAULT_COLOR;
    }

    const { hoveredSkinPartIds, activeSkinPartIds, relativeSkinPartIds } =
      store.getState().animator;
    const { pointerAction } = store.getState().app;

    if (activeSkinPartIds.includes(this.uuid)) {
      return ACTIVE_COLOR;
    }

    if (
      hoveredSkinPartIds.includes(this.uuid) &&
      pointerAction !== PointerAction.Dragging
    ) {
      return HOVER_COLOR;
    }

    if (relativeSkinPartIds.includes(this.uuid)) {
      return RELATIVE_COLOR;
    }

    return DEFAULT_COLOR;
  }

  public updateSize(size: vec3) {
    // 获取当前中心点与质心的偏移量
    vec3.scale(TEMP_VEC3, this.skinPartBox.geometry.size, -0.5);
    vec3.sub(TEMP_VEC3, this.pivot, TEMP_VEC3);

    // 更新中心点的位置，要求中心点位置在新的质心+旧的与质心的偏移量
    vec3.scale(this.pivot, size, -0.5);
    vec3.add(this.pivot, this.pivot, TEMP_VEC3);

    this.skinPartBox.update(size);
    this.skinPartMesh.updateSize();
    this.highlight?.update(size);
  }

  public setHighlight() {
    if (this.highlight) {
      return;
    }
    this.highlight = new HighlightBox(
      this.regl,
      this.skinPartBox.geometry.size,
    );
    this.add(this.highlight);
  }

  public copy(source: SkinPart, recursive?: boolean | undefined): this {
    const newSkin = super.copy(source, recursive);
    newSkin.alpha = source.alpha;
    const { rawMeshBuffer } = source.skinPartMesh;
    newSkin.skinPartMesh.updateBuffer(new Uint16Array(rawMeshBuffer));

    return newSkin;
  }

  public clone(recursive = false): SkinPart {
    const newSkin = new SkinPart(
      this.regl,
      nanoid(),
      this.skinPartBox.geometry.size,
    );
    newSkin.copy(this, recursive);
    return newSkin;
  }
}
