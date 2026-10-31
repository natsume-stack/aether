import { vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import {
  MOUSE,
  MOUSE_BUTTONS,
  OrbitControls,
} from '../../models/rendering/controls/orbit';
import { PerspectiveCamera } from '../../models/rendering/camera/perspective';
import { Scene } from '../../models/rendering/objects/scene';
import { WebGLRenderer } from '../../models/rendering/webgl-renderer';
import { debounce } from '../../utils/debounce-throttle';
import { Axis } from '../../models/rendering/def';

const TEMP_VEC = vec3.create();
const IDENTITY_VEC = vec3.create();

/**
 * 重置相机时，默认给相机增加的偏移量
 */
const CAMERA_POS_OFFSET = 26;

export class Core {
  public renderer: WebGLRenderer;

  public camera: PerspectiveCamera;

  public scene: Scene;

  /**
   * 轨道控制器
   */
  public orbitControls: OrbitControls;

  /**
   * 重置摄像机时描述摄像机默认方向的单位向量
   * 默认俯仰角45度，偏航角30度
   */
  public cameraDir = vec3.create();

  public onResize?: (domRect: DOMRect) => void;

  constructor(private regl: Regl) {
    this.renderer = new WebGLRenderer(this.regl);

    // 初始化摄像机
    const aspect =
      this.renderer.domElement.offsetWidth /
      this.renderer.domElement.offsetHeight;

    this.camera = new PerspectiveCamera(Math.PI / 4, aspect, 0.1, 10000);

    // 设置默认俯仰角45度，偏航角30度
    this.setCameraDir(Math.PI / 4, Math.PI / 6);

    this.orbitControls = this.createOrbitControls();

    // 监听canvas的resize，同步修改canvas分辨率
    this.resize();

    this.addResizeListener();

    this.scene = new Scene();
    this.scene.setBackgroundColor([0, 0, 0, 1]);

    this.startRendering();
  }

  private removeResizeListener = (): void => undefined;

  public resize = (applyPixelRatio: boolean = true) => {
    if (!this.renderer || !this.camera) {
      return;
    }

    const domRect = this.renderer.domElement.getBoundingClientRect();

    const { width, height } = domRect;

    // 更新画布分辨率
    this.updateResolution(width, height, applyPixelRatio);

    // 更新相机aspect
    const aspect = width / height;

    this.camera.aspect = aspect;

    this.camera.updateProjectionMatrix();

    this.onResize?.(domRect);
  };

  private addResizeListener() {
    if (!this.renderer) {
      return;
    }

    const resize = debounce(this.resize, 10);
    const onResize = () => resize();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(onResize);

      observer.observe(this.renderer.domElement);

      this.removeResizeListener = () => observer.disconnect();
    } else {
      window.addEventListener('resize', onResize);

      this.removeResizeListener = () => {
        window.removeEventListener('resize', onResize);
      };
    }
  }

  /**
   * 根据画布的宽高动态调整分辨率
   */
  private updateResolution(
    width: number,
    height: number,
    applyPixelRatio: boolean = true,
  ) {
    if (!this.renderer) {
      return;
    }
    const ratio = applyPixelRatio ? window.devicePixelRatio : 1;

    this.renderer.domElement.width = width * ratio;
    this.renderer.domElement.height = height * ratio;
  }

  public destroy() {
    this.scene.clear();
    this.removeResizeListener();
  }

  private startRendering() {
    this.regl.frame(() => {
      if (!this.renderer || !this.camera || !this.scene) {
        return;
      }

      this.render();
    });
  }

  private render = () => {
    // TODO postProcess应该作为内部状态更合适
    this.renderer.render(this.scene, this.camera, {
      postProcess: true,
      bloomEnabled: true,
      ssaoEnabled: true,
    });
  };

  public resetCamera(
    max: vec3 = IDENTITY_VEC,
    min: vec3 = IDENTITY_VEC,
    /**
     * 摄像机移动的距离
     * 如果输入数字则以指定数字距离移动摄像机
     * 否则按照轴向计算+offset移动摄像机
     *
     * 默认是以Axis.E轴计算
     * 再额外移动CAMERA_POS_OFFSET
     */
    cameraDist?:
      | {
          /**
           * 摄像机额外移动的距离
           * 默认CAMERA_POS_OFFSET
           */
          cameraOffset?: number;
          /**
           * 计算摄像机默认移动距离的轴向依据
           * 默认是Axis.E，以xyz立体空间外接球半径为准，保证摄像机可以看全所有轴向的内容
           */
          axis?: Axis;
        }
      | number,
  ) {
    let distance: number;
    if (typeof cameraDist === 'number') {
      distance = cameraDist;
    } else {
      const axis = cameraDist?.axis === undefined ? Axis.E : cameraDist.axis;
      const cameraOffset =
        cameraDist?.cameraOffset === undefined
          ? CAMERA_POS_OFFSET
          : cameraDist.cameraOffset;

      // 计算空间的半径
      let radius: number;
      switch (axis) {
        case Axis.X:
        case Axis.Y:
        case Axis.Z:
          radius = (max[axis] - min[axis]) * 0.5;
          break;
        default:
          radius = vec3.distance(max, min) * 0.5;
          break;
      }
      const sinFov = Math.sin(this.camera.fov * 0.5);
      distance = radius / sinFov + cameraOffset;
    }

    // 计算中心点作为target
    vec3.sub(TEMP_VEC, max, min);
    vec3.scale(TEMP_VEC, TEMP_VEC, 0.5);
    vec3.add(TEMP_VEC, TEMP_VEC, min);

    vec3.copy(this.camera.target, TEMP_VEC);
    vec3.scaleAndAdd(this.camera.position, TEMP_VEC, this.cameraDir, distance);

    this.orbitControls.reset();
    this.orbitControls.update();
  }

  /**
   * 根据俯仰角和偏航角设置 重置摄像机时候摄像机的方向
   * 默认俯仰角45度，偏航角30度
   * 入参单位为弧度
   */
  public setCameraDir(pitch: number, yaw: number) {
    const x = Math.cos(pitch) * Math.sin(yaw);
    const y = Math.sin(pitch);
    const z = Math.cos(pitch) * Math.cos(yaw);
    vec3.set(this.cameraDir, x, y, z);
  }

  private createOrbitControls() {
    // 初始化视角控制器
    const orbitControls = new OrbitControls(
      this.camera,
      this.renderer.domElement,
    );

    vec3.copy(orbitControls.target, [0, 0, 0]);

    orbitControls.minDistance = 1;

    orbitControls.update();

    orbitControls.enablePan = false;

    orbitControls.enableZoom = false;

    orbitControls.bindMouseButtonAction(MOUSE_BUTTONS.LEFT, MOUSE.ROTATE);
    orbitControls.unbindMouseButtonAction(MOUSE_BUTTONS.MIDDLE);
    orbitControls.unbindMouseButtonAction(MOUSE_BUTTONS.RIGHT);

    return orbitControls;
  }

  /**
   * 截图
   */
  public async getScreenshot(opt?: {
    beforeScreenshot?: (() => Promise<void>) | (() => void);
    afterScreenshot?: (() => Promise<void>) | (() => void);
    /**
     * 图片的类型，默认为image/jpeg
     */
    mime?: string;
  }) {
    const coverImageBlob = await this.canvasToBlob({
      forceRender: false,
      mime: opt?.mime,
    });

    let coverImageUrl: string | undefined;
    let coverImg: HTMLImageElement | undefined;

    if (coverImageBlob) {
      coverImageUrl = URL.createObjectURL(coverImageBlob);

      coverImg = await this.loadCoverImg(coverImageUrl);

      if (coverImg) {
        this.renderer.domElement.insertAdjacentElement('afterend', coverImg);
      }
    }

    const { domElement } = this.renderer;
    const sourceVisibility = domElement.style.visibility;
    domElement.style.visibility = 'hidden';
    await opt?.beforeScreenshot?.();

    const previewImageBlob = await this.canvasToBlob({
      forceRender: true,
      mime: opt?.mime,
    });

    await opt?.afterScreenshot?.();
    this.render();
    domElement.style.visibility = sourceVisibility;

    if (coverImg) {
      URL.revokeObjectURL(coverImg.src);

      coverImg.remove();
    }

    return previewImageBlob;
  }

  /**
   * 加载一个盖在canvas上的图片。
   * 在截图时会使用该图片盖住canvas，悄咪咪隐藏控件、调整视角进行截图。
   */
  private async loadCoverImg(
    url: string,
  ): Promise<HTMLImageElement | undefined> {
    const img = new Image();

    return new Promise<HTMLImageElement | undefined>((resolve) => {
      img.src = url;
      img.style.left = '0';
      img.style.top = '0';
      img.style.position = 'absolute';
      img.style.width = '100%';
      img.style.height = '100%';
      img.draggable = false;

      img.onload = () => {
        resolve(img);
      };

      // 超时也失败
      setTimeout(resolve, 100);
    });
  }

  /**
   * 封装成异步函数的canvas.toBlob()。
   * 可以通过参数控制是否立即执行一次渲染。
   */
  private async canvasToBlob(options: {
    /**
     * 是否立即执行一次渲染
     */
    forceRender: boolean;
    /**
     * 图片的类型，默认为image/jpeg
     */
    mime?: string;
  }): Promise<Blob | undefined> {
    const { forceRender, mime = 'image/jpeg' } = options;

    if (forceRender) {
      this.render();
    }

    return new Promise<Blob | undefined>((resolve) => {
      this.renderer.domElement.toBlob((blob) => {
        if (!blob) {
          resolve(undefined);

          console.error('Failed to get blob of canvas');
          return;
        }

        resolve(blob);
      }, mime);
    });
  }
}
