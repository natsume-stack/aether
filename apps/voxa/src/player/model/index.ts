import { vec3 } from 'gl-matrix';
import { Regl } from '@box/regl';
import type { RequestParams } from './request-params';
import { initRegl } from '../../models/rendering/regl';
import { Core } from '../../common/core';
import { ProjectManager } from './project-manager';
import { Loader } from '../../common/loader';
import { IframeTool } from './iframe';

type Params = {
  canvas: HTMLCanvasElement;
};

/**
 * 通过id请求模型数据时，默认超时时长
 */
const DEFAULT_TIMEOUT = 10 * 1000;
/**
 * 通过id请求模型数据失败时，默认重试次数
 */
const DEFAULT_RETRY_COUNT = 3;

export type RetryOptions = {
  /**
   * 请求超时时长
   */
  timeout?: number;
  /**
   * 重试的次数
   */
  count?: number;
};

const TEMP_VEC = vec3.create();
const SPACE_MIN = vec3.create();

// 10秒内顺时针旋转360°，计算角速度
const AUTO_ROTATION_SPEED = -1 * (Math.PI / 180) * (360 / (10 * 1000));

export class Player {
  private regl?: Regl;

  public core?: Core;
  public loader?: Loader;
  public projectManager?: ProjectManager;

  /**
   * 自动旋转相机的动画
   */
  private autoRotation = -1;
  /**
   * 自动旋转相机时，上一次raf时间戳
   */
  private prevRotationTime?: number;

  private abortLoading?: () => void;

  private iframeTool: IframeTool = new IframeTool();

  public async init(params: Params) {
    const { canvas } = params;

    try {
      this.regl = await initRegl(canvas);
    } catch (err) {
      console.error('Player init error', err);

      return;
    }

    this.core = new Core(this.regl);

    this.loader = new Loader({
      regl: this.regl,
    });

    this.projectManager = new ProjectManager({
      loader: this.loader,
    });

    this.iframeTool = new IframeTool();
  }

  public async load(params: {
    modelId?: number;
    modelFileHash?: string;
    retry?: RetryOptions;
    autoRotate?: boolean;
  }) {
    if (!this.core || !this.projectManager) {
      return;
    }

    const { modelId, modelFileHash, retry = {}, autoRotate = false } = params;

    const { timeout = DEFAULT_TIMEOUT, count = DEFAULT_RETRY_COUNT } = retry;

    const abortController = new AbortController();

    this.abortLoading = () => {
      abortController.abort();

      this.abortLoading = undefined;
    };

    const requestParams: RequestParams = {
      signal: abortController.signal,
      timeout,
    };

    for (let retried = 0; retried <= count; retried++) {
      try {
        const result = await this.projectManager?.load({
          parent: this.core.scene,
          modelId,
          modelFileHash,
          params: requestParams,
        });

        if (result) {
          this.onLoad({ bounds: result.metaData.bounds, autoRotate });

          this.abortLoading = undefined;
          break;
        }
      } catch (err) {
        console.error('Player load error', err);
      }
    }
  }

  private onLoad({
    bounds,
    autoRotate,
  }: {
    bounds: vec3;
    autoRotate: boolean;
  }) {
    this.alignCenter(
      {
        min: SPACE_MIN,
        max: TEMP_VEC,
      },
      bounds,
    );

    this.core?.resetCamera(TEMP_VEC, SPACE_MIN);

    autoRotate && this.startCameraAutoRotation();

    this.iframeTool.emitLoadEvent();
  }

  /**
   * 使模型整体居中，让模型整体的中心点位于世界坐标的[0, 0, 0]
   * 并计算居中后，模型整体的最低点和最高点
   */
  private alignCenter(
    out: {
      min: vec3;
      max: vec3;
    },
    bounds: vec3,
  ) {
    if (!this.core) {
      return;
    }

    // 当前加载会生成一个group代表整体模型，所以只需要查找到首个group即可
    const group = this.core?.scene.children.find((obj) => obj.isGroup());

    if (!group) {
      return;
    }

    const { min, max } = out;

    // 模型居中，让模型整体的中心点位于世界坐标的[0, 0, 0]
    vec3.scale(max, bounds, 0.5);
    vec3.sub(group.position, group.position, max);

    vec3.negate(min, TEMP_VEC);
  }

  private startCameraAutoRotation() {
    this.autoRotateCamera();

    window.addEventListener('pointerdown', this.stopCameraAutoRotation);
  }

  private autoRotateCamera() {
    this.autoRotation = requestAnimationFrame((timestamp) => {
      if (this.prevRotationTime === undefined) {
        this.prevRotationTime = timestamp;
      }

      const elapsed = timestamp - this.prevRotationTime;

      this.core?.orbitControls.rotateLeft(AUTO_ROTATION_SPEED * elapsed);
      this.core?.orbitControls.update();

      this.prevRotationTime = timestamp;

      this.autoRotateCamera();
    });
  }

  private stopCameraAutoRotation = () => {
    cancelAnimationFrame(this.autoRotation);

    this.prevRotationTime = undefined;

    window.removeEventListener('pointerdown', this.stopCameraAutoRotation);
  };

  public destroy() {
    this.abortLoading?.();

    this.stopCameraAutoRotation();

    this.core?.destroy();
    this.regl?.destroy();
  }
}
