import { vec2, vec3 } from 'gl-matrix';

import { Frustum } from './rendering/math/frustum';
import { Controller } from './voxel-app/controller';
import { traverseVoxels } from '@box/utils/helper';
import { composeSymmetryOperation } from './editing/util';
import { store } from '../redux/store';
import { screenPosToClipPos } from '../utils/coordinate';
import { Box3 } from './rendering/math/box3';
import { AppMode } from '../redux/app-slice';
import type { Stage } from './stage';
import type { VoxelApp } from './voxel-app';
import type { AnimatorApp } from './animator-app';
import {
  getBoneIdBySkinId,
  getRootParentId,
  isBoneNode,
  isBonesInteractive,
  isSkinPart,
  isSkinPartInteractive,
} from './animator-app/util';
import { ProjectNodeType } from '../redux/animator-slice';

// 平截头体
const frustum = new Frustum();
// 投射起点坐标/视线方向
const vecNear = vec3.create();
// 近平面坐标
const vecTopLeft = vec3.create();
const vecTopRight = vec3.create();
const vecDownRight = vec3.create();
const vecDownLeft = vec3.create();
// 远平面坐标
const vecFarTopLeft = vec3.create();
const vecFarTopRight = vec3.create();
const vecFarDownRight = vec3.create();
const vecFarDownLeft = vec3.create();

const SCREEN_START = vec2.create();
const SCREEN_END = vec2.create();
const TEMP_BOX = new Box3();

type SelectOptions = {
  appMode: AppMode;
  start: vec2;
  end: vec2;
};

const enum CacheType {
  Inside,
  Outside,
  Skip,
}

type Cache = Record<string, CacheType>;

type InitParams = {
  stage: Stage;
  animatorApp: AnimatorApp;
  voxelApp: VoxelApp;
};

/**
 * 框选工具，通过2d平面的矩形框根据投影生成frustum
 * 对模型的体素/部件进行选中
 */
export class SelectBox {
  private controller: Controller;
  private startPoint = vec3.create();
  private endPoint = vec3.create();

  private stage: Stage;

  private voxelApp: VoxelApp;

  private animatorApp: AnimatorApp;

  constructor({ stage, voxelApp, animatorApp }: InitParams) {
    this.stage = stage;

    this.voxelApp = voxelApp;

    this.animatorApp = animatorApp;

    this.controller = this.voxelApp.veController;
  }

  private calcStartEndPoints(start: vec2, end: vec2) {
    if (!start || !end) {
      return;
    }

    const elementRect = this.stage.getRendererDOMRect();

    screenPosToClipPos(SCREEN_START, start, elementRect);
    screenPosToClipPos(SCREEN_END, end, elementRect);

    const [sx, sy] = SCREEN_START;
    let [ex, ey] = SCREEN_END;

    // Avoid invalid frustum
    if (sx === ex) {
      ex += Number.EPSILON;
    }

    if (sy === ey) {
      ey += Number.EPSILON;
    }

    this.startPoint[0] = Math.min(sx, ex);
    this.startPoint[1] = Math.max(sy, ey);
    this.endPoint[0] = Math.max(sx, ex);
    this.endPoint[1] = Math.min(sy, ey);
  }

  public select(options: SelectOptions) {
    const { start, end, appMode } = options;
    this.calcStartEndPoints(start, end);

    const camera = this.stage.getCamera();
    if (camera.isPerspectiveCamera()) {
      this.updatePerspectiveFrustum();
    } else if (camera.isOrthographicCamera()) {
      this.updateOrthographicFrustum();
    } else {
      // camera mode invalid
      return;
    }

    // TODO 目前框选无法选中没有空的骨骼节点
    appMode === AppMode.Voxel
      ? this.searchVoxelInFrustum(frustum)
      : this.searchSkinPartsInFrustum(frustum);
  }

  /**
   * 更新透视摄像机模式下的框选frustum
   * @returns
   */
  private updatePerspectiveFrustum() {
    const camera = this.stage.getCamera();

    // 根据startPoint & endPoint扩充近平面四个顶点的坐标
    vec3.copy(vecTopLeft, this.startPoint);
    vec3.set(vecTopRight, this.endPoint[0], this.startPoint[1], 0.0);
    vec3.copy(vecDownRight, this.endPoint);
    vec3.set(vecDownLeft, this.startPoint[0], this.endPoint[1], 0.0);

    // 将近平面四个顶点的裁剪坐标转换为世界坐标
    [vecTopLeft, vecTopRight, vecDownLeft, vecDownRight].forEach((v) => {
      vec3.transformMat4(v, v, camera.invViewProjection);
    });

    // 将观察点设置为摄像机的世界坐标处
    vec3.copy(vecNear, camera.position);

    // 根据深度确定远平面上三个点的坐标
    vec3.copy(vecFarTopLeft, vec3.sub(vecFarTopLeft, vecTopLeft, vecNear));
    vec3.copy(vecFarTopRight, vec3.sub(vecFarTopRight, vecTopRight, vecNear));
    vec3.copy(
      vecFarDownRight,
      vec3.sub(vecFarDownRight, vecDownRight, vecNear),
    );
    [vecFarTopLeft, vecFarTopRight, vecFarDownRight].forEach((v) => {
      vec3.normalize(v, v);
      vec3.scale(v, v, camera.far);
      vec3.add(v, v, vecNear);
    });

    const planes = frustum.planes;
    // 生成frustum的6个面
    planes[0].setFromCoplanarPoints(vecNear, vecTopLeft, vecTopRight);
    planes[1].setFromCoplanarPoints(vecNear, vecTopRight, vecDownRight);
    planes[2].setFromCoplanarPoints(vecDownRight, vecDownLeft, vecNear);
    planes[3].setFromCoplanarPoints(vecDownLeft, vecTopLeft, vecNear);
    planes[4].setFromCoplanarPoints(vecTopRight, vecDownRight, vecDownLeft);
    planes[5].setFromCoplanarPoints(
      vecFarDownRight,
      vecFarTopRight,
      vecFarTopLeft,
    );
    vec3.scale(planes[5].normal, planes[5].normal, -1);
  }

  /**
   * 更新正交摄像机模式下的框选frustum
   * @returns
   */
  private updateOrthographicFrustum() {
    const left = this.startPoint[0];
    const top = this.startPoint[1];
    const right = this.endPoint[0];
    const down = this.endPoint[1];

    vec3.set(vecTopLeft, left, top, -1);

    vec3.set(vecTopRight, right, top, -1);

    vec3.set(vecDownRight, right, down, -1);

    vec3.set(vecDownLeft, left, down, -1);

    vec3.set(vecFarTopLeft, left, top, 1);

    vec3.set(vecFarTopRight, right, top, 1);

    vec3.set(vecFarDownRight, right, down, 1);

    vec3.set(vecFarDownLeft, left, down, 1);

    [
      vecTopLeft,
      vecTopRight,
      vecDownRight,
      vecDownLeft,
      vecFarTopLeft,
      vecFarTopRight,
      vecFarDownRight,
      vecFarDownLeft,
    ].forEach((v) =>
      vec3.transformMat4(v, v, this.stage.getCamera().invViewProjection),
    );

    const planes = frustum.planes;
    planes[0].setFromCoplanarPoints(vecTopLeft, vecFarTopLeft, vecFarTopRight);
    planes[1].setFromCoplanarPoints(
      vecTopRight,
      vecFarTopRight,
      vecFarDownRight,
    );
    planes[2].setFromCoplanarPoints(
      vecFarDownRight,
      vecFarDownLeft,
      vecDownLeft,
    );
    planes[3].setFromCoplanarPoints(vecFarDownLeft, vecFarTopLeft, vecTopLeft);
    planes[4].setFromCoplanarPoints(vecTopRight, vecDownRight, vecDownLeft);
    planes[5].setFromCoplanarPoints(
      vecFarDownRight,
      vecFarTopRight,
      vecFarTopLeft,
    );
    vec3.scale(planes[5].normal, planes[5].normal, -1);
  }

  /**
   * 查找并选中存在于平截头体中的皮肤部件/骨骼节点
   * @param frustum 平截头体
   */
  private searchSkinPartsInFrustum(frustum: Frustum) {
    const { hierarchyData, skeletonVisible } = store.getState().animator;
    const activeIds: string[] =
      skeletonVisible && isBonesInteractive()
        ? this.intersectBoneNodes(frustum)
        : [];
    const skinPartsIds = isSkinPartInteractive()
      ? this.intersectSkinParts(frustum)
      : [];
    skinPartsIds.forEach((id) => {
      const parentId = getRootParentId(id);
      if (!parentId) {
        return;
      }
      let activeId = parentId;
      // 如果根节点有绑定的骨骼节点则选中骨骼节点，否则选中根节点
      if (isBonesInteractive()) {
        activeId = getBoneIdBySkinId(parentId) || parentId;
      }
      !activeIds.includes(activeId) && activeIds.push(activeId);
    });

    this.animatorApp.nodeManager.setActiveIds(activeIds);
    activeIds.forEach((id) => {
      if (hierarchyData[id]?.type === ProjectNodeType.Bone) {
        this.animatorApp.nodeManager.expandParents(id);
      }
    });
  }

  private intersectSkinParts(frustum: Frustum) {
    const skinPartIds: string[] = [];

    for (const skinNodes of this.animatorApp.nodeManager.getAllSkinNodes()) {
      if (!isSkinPart(skinNodes)) {
        continue;
      }
      TEMP_BOX.makeEmpty().expandByObject(skinNodes.skinPartBox);
      // TODO: 现在这个盒子太粗糙，后续优化
      if (frustum.intersectsBox(TEMP_BOX)) {
        skinPartIds.push(skinNodes.uuid);
      }
    }
    return skinPartIds;
  }

  private intersectBoneNodes(frustum: Frustum) {
    const boneIds: string[] = [];

    for (const boneNode of this.animatorApp.nodeManager.getAllBoneNodes()) {
      if (!isBoneNode(boneNode)) {
        continue;
      }
      if (frustum.intersectsSphere(boneNode.interactive)) {
        boneIds.push(boneNode.uuid);
      }
    }
    return boneIds;
  }

  /**
   * 选中存在于平截头体中的体素。
   * @returns 是否有选中新的数据。
   */
  private searchVoxelInFrustum(frustum: Frustum) {
    const { destination, selection } = this.controller.models;
    const dimension = selection.voxels.getDimension();

    /**
     * 缓存坐标相同点的判断结果。
     */
    let cache: Cache = {};

    const { mirrorMode } = store.getState().editing;

    const operation = composeSymmetryOperation({
      opts: mirrorMode,
      range: dimension,
      operation: ({ pos: [x, y, z] }) => {
        const voxel = destination.voxels.getVoxel(x, y, z);

        voxel && selection.voxels.setVoxel(x, y, z, voxel);

        destination.voxels.setVoxel(x, y, z, 0);

        const key = `${x}-${y}-${z}`;

        cache[key] = CacheType.Skip;
      },
    });

    traverseVoxels(
      destination.voxels,
      [0, 0, 0],
      dimension,
      (i, j, k, data) => {
        if (
          data === 0 ||
          this.containsVoxel([i, j, k], frustum, cache) !== CacheType.Inside
        ) {
          return;
        }

        operation({ pos: [i, j, k] });
      },
    );

    selection.blockRender(false);
    selection.bakeData();
    destination.bakeData();

    this.voxelApp.saveHistory();
  }

  /**
   * 根据体素点的低位（lo），检测体素是否在平截头体内。
   * 只要体素点有一个顶点在平截头体内，即算作在平截头体中。
   * @param voxelLoPos 体素点的低位
   * @param frustum 平截头体
   * @param cache 缓存结果，避免重复计算
   */
  private containsVoxel(
    voxelLoPos: vec3,
    frustum: Frustum,
    cache: Cache,
  ): CacheType {
    let res: CacheType = CacheType.Outside;

    STEPS.find((step) => {
      const pos = vec3.add(TEMP_VOXEL, voxelLoPos, step);

      const key = `${pos[0]}-${pos[1]}-${pos[2]}`;

      let isContained = false;

      if (cache[key] === undefined) {
        isContained = frustum.containsPoint(pos);

        cache[key] = isContained ? CacheType.Inside : CacheType.Outside;
      } else {
        isContained = cache[key] === CacheType.Inside;
      }

      res = cache[key];

      return isContained;
    });

    return res;
  }
}

/**
 * 缓存变量，计算时复用。
 */
const TEMP_VOXEL = vec3.create();

/**
 * 体素的长宽高
 */
const VOXEL_SIZE = 1;
/**
 * 体素八个顶点与低点的偏移量。
 * lo + STEPS[i] = 对应的顶点
 */
const STEPS: vec3[] = [
  [0, 0, 0],
  [VOXEL_SIZE, 0, 0],
  [VOXEL_SIZE, VOXEL_SIZE, 0],
  [VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE],
  [0, VOXEL_SIZE, 0],
  [0, VOXEL_SIZE, VOXEL_SIZE],
  [0, 0, VOXEL_SIZE],
  [VOXEL_SIZE, 0, VOXEL_SIZE],
];
