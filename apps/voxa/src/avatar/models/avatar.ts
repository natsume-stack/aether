import { quat, vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { Core } from '../../common/core';
import {
  defaultMotions,
  BodyPartName,
  ScreenshotModePartsMap,
  ScreenshotCameraMap,
  DEFAULT_IK_PALETTE,
  DEFAULT_EXTENSION,
  DEFAULT_ITERATIONS,
} from './defs';
import { AvatarIKState, IKPalette } from './interfaces';
import { computeIKState, initIKState } from './animation/ik';
import { Object3D } from '../../models/rendering/objects/object3d';
import { Box3 } from '../../models/rendering/math/box3';
import { degreeToRad } from '../../utils/math';
import { SkinPart } from './skin-part';
import { BoneNode } from './bone';
import { Background } from './background';
import { IframeTool, ScreenshotMode } from './iframe';
import { MS_PER_TICK } from '@box/schema/clock/clock-schema';

/**
 * 栅格适配数据，栅格最大宽度1200px
 */
const MAX_GRID_WITH = 1200;
/**
 * 一共划分12个栅格
 */
const GRID_COUNT = 12;
/**
 * 栅格左右两边的padding固定24
 */
const GRID_PADDING = 24;
/**
 * 统一截图尺寸512 * 512
 */
const SCREENSHOT_SIZE = 512;

const TEMP_VEC3 = vec3.create();

export interface IAvatarOptions {
  regl: Regl;
}

export type Align = 'center' | 'right';

export type ScreenshotQueue = {
  mode: ScreenshotMode;
  execute: (blob: Blob | undefined) => void;
};

export class Avatar {
  private regl: Regl;
  private core: Core;
  private background: Background;
  private bones = new Object3D();

  /**
   * 人物布局，默认center
   */
  private align: Align = 'center';
  /**
   * 人物高度占页面高度，默认0.5
   */
  private avatarHeight = 0.5;
  /**
   * 摄像机俯仰角，单位角度
   * 默认4度
   */
  private pitch = 4;
  /**
   * 摄像机偏航角，单位角度
   * 默认10度
   */
  private yaw = 10;

  // init ik
  public ikPalette: IKPalette = DEFAULT_IK_PALETTE;
  public extension = DEFAULT_EXTENSION;
  public palette: IKPalette = Object.assign(
    DEFAULT_IK_PALETTE,
    DEFAULT_EXTENSION,
  );
  public state: AvatarIKState = initIKState();

  private motionName: string = defaultMotions.IDLE;
  private iterations = DEFAULT_ITERATIONS;

  public skinParts: Map<string, SkinPart> = new Map();
  public boundingBox = new Box3();
  public iframeTool: IframeTool;

  /**
   * 截图后，恢复界面的暂存函数
   */
  private afterScreenshotFns?: ((() => void) | (() => Promise<void>))[];
  private prevMouseX?: number;
  private screenshotQueue: ScreenshotQueue[] = [];
  private prevTime = 0;

  constructor(opt: IAvatarOptions) {
    this.regl = opt.regl;

    if (!this.regl) {
      throw new Error('Failed to init regl');
    }
    this.core = new Core(this.regl);
    this.core.scene.setBackgroundColor([0, 0, 0, 0]);
    this.core.orbitControls.enabled = false;

    this.background = new Background(this.regl, this.core);

    this.iframeTool = new IframeTool(
      this.skinParts,
      this.getScreenshot,
      this.playMotion,
    );

    // 设置默认摄像机角度
    this.core.setCameraDir(degreeToRad(this.pitch), degreeToRad(this.yaw));

    // 设置默认avatar盒子大小
    vec3.set(this.boundingBox.max, 0.9, 2, 0.4);
    vec3.set(this.boundingBox.min, -0.9, 0, -0.4);
    this.resetCameraByBox();

    this.core.scene.add(this.bones);
    Object.values(BodyPartName).forEach((name) => {
      const bone = new BoneNode({
        name: name,
        ikConfiguration: this.state.configuration,
      });
      const skinPart = new SkinPart({
        name: name,
        regl: this.regl,
      });
      bone.add(skinPart);
      this.bones.add(bone);
      this.skinParts.set(name, skinPart);
    });

    this.regl.frame((context) => {
      const deltaClock = context.time - this.prevTime;
      this.tickAnimation((deltaClock * 1000) / MS_PER_TICK);
      this.prevTime = context.time;
    });
    this.addListener();
  }

  private addListener() {
    const { domElement } = this.core.renderer;
    domElement.addEventListener('contextmenu', this.onContextMenu);
    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointercancel', this.onPointerUp);
  }

  private removeListener() {
    const { domElement } = this.core.renderer;
    domElement.removeEventListener('contextmenu', this.onContextMenu);
    domElement.removeEventListener('pointerdown', this.onPointerDown);
    domElement.removeEventListener('pointercancel', this.onPointerUp);
    domElement.removeEventListener('pointermove', this.onPointerMove);
    domElement.removeEventListener('pointerup', this.onPointerUp);
    domElement.removeEventListener('pointerout', this.onPointerUp);
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.prevMouseX !== undefined) {
      return;
    }
    const { domElement } = this.core.renderer;
    domElement.addEventListener('pointermove', this.onPointerMove);
    domElement.addEventListener('pointerup', this.onPointerUp);
    domElement.addEventListener('pointerout', this.onPointerUp);
    this.prevMouseX = e.clientX;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.prevMouseX === undefined) {
      return;
    }
    const diff = e.clientX - this.prevMouseX;
    quat.rotateY(
      this.bones.quaternion,
      this.bones.quaternion,
      degreeToRad(diff),
    );
    this.prevMouseX = e.clientX;
  };

  private onPointerUp = () => {
    const { domElement } = this.core.renderer;
    domElement.removeEventListener('pointermove', this.onPointerMove);
    domElement.removeEventListener('pointerup', this.onPointerUp);
    domElement.removeEventListener('pointerout', this.onPointerUp);
    this.prevMouseX = undefined;
  };

  public async load(opt: {
    /**
     * 是否展示背景
     * 默认否
     */
    background?: boolean;
    /**
     * 人物布局
     * 可入参center/right。默认center
     */
    align?: string;
    /**
     * 人物高度占整个浏览器页面高度的比例
     * 默认是0.5
     */
    avatarHeight?: number;
    /**
     * 摄像机俯仰角
     * 默认4
     */
    pitch?: number;
    /**
     * 摄像机偏航角
     * 默认10
     */
    yaw?: number;
  }) {
    const {
      background,
      align = this.align,
      avatarHeight = this.avatarHeight,
      pitch = this.pitch,
      yaw = this.yaw,
    } = opt;

    this.avatarHeight = avatarHeight;
    this.pitch = pitch;
    this.yaw = yaw;
    if (align === 'center' || align === 'right') {
      this.align = align;
    }

    this.resetCameraByBox();
    if (this.align !== 'center') {
      this.core.onResize = (domRect: DOMRect) => {
        this.resetCameraByBox(domRect);
      };
    }

    if (background) {
      await this.background.init();
    }

    this.iframeTool.emitLoadEvent();
  }

  public resetCameraByBox(domRect?: DOMRect) {
    const { max, min } = this.boundingBox;
    const dist = vec3.dist(max, min);
    this.core.setCameraDir(degreeToRad(this.pitch), degreeToRad(this.yaw));
    this.core.resetCamera(max, min, {
      cameraOffset: dist * (1 - this.avatarHeight),
    });
    if (this.align === 'right') {
      const rect =
        domRect || this.core.renderer.domElement.getBoundingClientRect();
      const width = Math.min(rect.width, MAX_GRID_WITH) - GRID_PADDING * 2;
      const height = rect.height;
      const gridWidth = width / GRID_COUNT;

      // 右侧适配时，人物位于右侧5个栅格的中间
      const offsetPx = (gridWidth * 5) / 2 + gridWidth;

      // 先计算摄像机与视觉中心的z轴距离
      // 再通过视场角度与z轴距离计算出摄像机视野的高度
      this.boundingBox.getCenter(TEMP_VEC3);
      const zDist = Math.abs(this.core.camera.position[2] - TEMP_VEC3[2]);
      const cameraHeight = Math.tan(this.core.camera.fov * 0.5) * zDist * 2;

      const offsetCamera = (cameraHeight * offsetPx) / height;

      this.core.camera.position[0] -= offsetCamera;
      this.core.camera.target[0] -= offsetCamera;
      this.core.orbitControls.reset();
      this.core.orbitControls.update();
    }
  }

  public playMotion = (motionName: string, iterations?: number) => {
    this.motionName = motionName;
    this.iterations =
      typeof iterations === 'number' ? iterations : DEFAULT_ITERATIONS;
    this.state.groundEmotePhase = 0;
  };

  private async waitDomRender() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(resolve);
    });
  }

  /**
   * 截图前，记录相机位置，隐藏背景等
   */
  private beforeScreenshot = async (mode: ScreenshotMode) => {
    this.afterScreenshotFns = [];

    // 调整截图尺寸
    const { domElement } = this.core.renderer;
    const sourceWidth = domElement.width;
    const sourceHeight = domElement.height;
    const sourceStyleWidth = domElement.style.width;
    const sourceStyleHeight = domElement.style.height;

    domElement.width = SCREENSHOT_SIZE;
    domElement.height = SCREENSHOT_SIZE;
    domElement.style.width = `${SCREENSHOT_SIZE}px`;
    domElement.style.height = `${SCREENSHOT_SIZE}px`;
    this.core.resize(false);
    // 等待浏览器渲染
    await this.waitDomRender();

    this.afterScreenshotFns.unshift(async () => {
      domElement.width = sourceWidth;
      domElement.height = sourceHeight;
      domElement.style.width = sourceStyleWidth;
      domElement.style.height = sourceStyleHeight;
      this.core.resize();
      // 等待浏览器渲染
      await this.waitDomRender();
    });

    // 摄像机处理
    // 截图的时候改变摄像机俯仰角，偏航角，重新计算人物位置
    const snapshot = this.core.camera.getSnapshot();
    const sourceBounding = new Box3().copy(this.boundingBox);
    const sourceCameraDir = vec3.clone(this.core.cameraDir);

    // 重置人物旋转度数
    const sourceQuat = quat.clone(this.bones.quaternion);
    this.bones.setQuaternion(0, 0, 0);

    // 记录当前播放的动作以及播放进度
    const sourceStatePhase = this.state.groundEmotePhase;
    const sourceMotion = this.motionName;

    // 设置人物动作为default，计算box大小，并且渲染
    this.motionName = defaultMotions.IDLE;
    this.tickAnimation();
    this.core.scene.updateMatrixWorld(true);

    switch (mode) {
      case ScreenshotMode.Share:
        // 分享页面截图规则
        // 人物动作idle，摄像机看向人物整体最小外接立方体中心点
        this.boundingBox.makeEmpty();
        for (const skinPart of this.skinParts.values()) {
          const partBox = new Box3().copy(skinPart.voxelBox);
          partBox.applyMatrix4(skinPart.matrixWorld);
          this.boundingBox.union(partBox);
        }
        break;
      case ScreenshotMode.Avatar:
        // 头像截图规则
        // 人物动作idle，摄像机看向头部体素中心点
        const head = this.skinParts.get(BodyPartName.head);
        if (head) {
          this.boundingBox.copy(head.voxelBox);
          this.boundingBox.applyMatrix4(head.matrixWorld);
        }
        break;
      case ScreenshotMode.Suit:
      case ScreenshotMode.Head:
      case ScreenshotMode.Shirt:
      case ScreenshotMode.Pants:
      case ScreenshotMode.Shoes:
        // 换肤界面部位示意图截图规则
        // 人物动作idle，摄像机看向各固定的盒子中心点
        // 无关部件隐藏
        const parts = ScreenshotModePartsMap[mode];
        this.boundingBox.makeEmpty();
        for (const skinPart of this.skinParts.values()) {
          if (!parts.includes(skinPart.name)) {
            skinPart.visible = false;
            continue;
          }
          const partBox = new Box3().copy(skinPart.voxelBox);
          partBox.applyMatrix4(skinPart.matrixWorld);
          this.boundingBox.union(partBox);
        }
        break;
    }
    // 统一调整摄像机的角度，摄像机看向的点，以及移动的位置
    const { dir, dist, box } = ScreenshotCameraMap[mode];
    this.core.setCameraDir(degreeToRad(dir.pitch), degreeToRad(dir.yaw));
    this.core.resetCamera(
      box?.max || this.boundingBox.max,
      box?.min || this.boundingBox.min,
      dist,
    );

    this.afterScreenshotFns.unshift(() => {
      this.core.camera.sync(snapshot);
      this.boundingBox.copy(sourceBounding);
      this.bones.setQuaternion(sourceQuat);
      vec3.copy(this.core.cameraDir, sourceCameraDir);

      this.state.groundEmotePhase = sourceStatePhase;
      this.motionName = sourceMotion;
      this.tickAnimation();
      this.core.scene.updateMatrixWorld(true);

      // 截图期间有可能有部件隐藏，全部恢复可见状态
      this.skinParts.forEach((sp) => (sp.visible = true));
    });

    // 隐藏背景
    const sourceVisible = this.background.getVisible();
    this.background.setVisible(false);
    this.afterScreenshotFns.unshift(() => {
      this.background.setVisible(sourceVisible);
    });
  };

  /**
   * 截图后，恢复界面
   */
  private afterScreenshot = async () => {
    if (this.afterScreenshotFns) {
      for (const fn of this.afterScreenshotFns) {
        await fn();
      }

      this.afterScreenshotFns = undefined;
    }
  };

  public getScreenshot = async (
    mode: ScreenshotMode = ScreenshotMode.Share,
  ) => {
    return new Promise<Blob | undefined>((resolve) => {
      const isQueueEmpty = !this.screenshotQueue.length;
      this.screenshotQueue.push({
        execute: (blob) => resolve(blob),
        mode,
      });
      isQueueEmpty && this.releaseScreenshotQueue();
    });
  };

  private async releaseScreenshotQueue() {
    while (this.screenshotQueue.length) {
      const firstQueue = this.screenshotQueue[0];
      const blob = await this.core.getScreenshot({
        beforeScreenshot: async () =>
          await this.beforeScreenshot(firstQueue.mode),
        afterScreenshot: this.afterScreenshot,
        mime: 'image/png',
      });
      firstQueue.execute(blob);
      this.screenshotQueue.shift();
    }
  }

  private tickAnimation = (dt?: number) => {
    computeIKState(
      this.motionName,
      this.state,
      this.palette,
      dt || 0,
      this.iterations,
    );
  };

  public destroy() {
    this.removeListener();
    this.core.scene.clear();
    this.skinParts.clear();
    this.regl.destroy();
    this.core.destroy();
  }
}
