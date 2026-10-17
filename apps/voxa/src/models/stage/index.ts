import type { Regl } from '@box/regl';
import { vec3 } from 'gl-matrix';
import { PointerAction, setPointerAction } from '../../redux/app-slice';
import { store } from '../../redux/store';
import { debounce } from '../../utils/debounce-throttle';
import type { Camera } from '../rendering/camera/base';
import { OrthographicCamera } from '../rendering/camera/orthographic';
import { PerspectiveCamera } from '../rendering/camera/perspective';
import { OrbitControls } from '../rendering/controls/orbit';
import { WebGLRenderer } from '../rendering/webgl-renderer';

type StageInitParams = {
  regl: Regl;
};

/**
 * 摄像机复位时用的位置偏移，以完整显示模型
 * 该数值没有准确计算方式，以前画布占满页面时取的是40。
 * 现在画布不再占满页面，不会被顶部栏遮盖。该值适当调小。
 */
const CAMERA_POS_OFFSET = 26;

/**
 * 透视fov
 */
const PERSPECTIVE_FOV = Math.PI / 4;

/**
 * 计算相机可视区域最大空间尺寸，
 * 地图的地块最大尺寸是512，与体素编辑器尺寸比例是 1 : 16
 */
const CAMERA_MAX_SPACE_SIZE = 512 * 16;

const CAMERA_Z_NEAR = 1;

const CAMERA_Z_FAR_OFFSET = 100;

/**
 * OrbitControl.maxDistance应该略小于相机的zFar，给予一定的自由度
 */
const ORBIT_MAX_OFFSET = -50;

/**
 * 公共的操作rendering的模块
 */
export class Stage {
  public readonly regl: Regl;
  public readonly renderer: WebGLRenderer;

  /**
   * active camera
   * @default PerspectiveCamera
   */
  private camera: Camera;
  public readonly perspectiveCamera: PerspectiveCamera;
  public readonly orthographicCamera: OrthographicCamera;
  private cameraDir = vec3.create();

  /**
   * canvas的DOMRect缓存。
   * 在resize时更新
   */
  private domRect: DOMRect = new DOMRect();

  public orbitControls: OrbitControls;

  constructor(initParams: StageInitParams) {
    const { regl } = initParams;

    this.regl = regl;

    this.renderer = new WebGLRenderer(regl);

    const { domElement } = this.renderer;

    // 初始化摄像机
    const aspect = domElement.offsetWidth / domElement.offsetHeight;

    const zFar = this.calculateZFar(CAMERA_MAX_SPACE_SIZE, PERSPECTIVE_FOV);

    this.perspectiveCamera = new PerspectiveCamera(
      PERSPECTIVE_FOV,
      aspect,
      CAMERA_Z_NEAR,
      zFar,
    );
    this.orthographicCamera = new OrthographicCamera(
      aspect,
      undefined,
      CAMERA_Z_NEAR,
      zFar,
    );

    // 描述摄像机默认方向的单位向量，俯仰角45度，偏航角30度
    this.getCameraDir(this.cameraDir, Math.PI / 4, Math.PI / 6);

    // 摄像机默认为透视模式
    this.camera = this.perspectiveCamera;

    const { workspaceSize: spaceSize } = store.getState().editing;

    this.setCameraBySpaceSize(spaceSize, [0, 0, 0]);

    // 初始化视角控制器
    const controls = new OrbitControls(
      this.getCamera,
      this.renderer.domElement,
    );
    controls.minDistance = CAMERA_Z_NEAR;
    // maxDistance稍小于相机的zFar，加上偏移量
    controls.maxDistance = zFar + ORBIT_MAX_OFFSET;

    vec3.copy(controls.target, this.getCameraTarget(spaceSize, [0, 0, 0]));
    controls.update();
    this.orbitControls = controls;

    // 监听dom的尺寸变化
    this.resize();

    this.addResizeListener();
  }

  public getCamera = () => this.camera;

  /**
   * 根据俯仰角和偏航角计算摄像机方向
   */
  private getCameraDir(out: vec3, pitch: number, yaw: number) {
    const x = Math.cos(pitch) * Math.sin(yaw);
    const y = Math.sin(pitch);
    const z = Math.cos(pitch) * Math.cos(yaw);
    vec3.set(out, x, y, z);
  }

  /**
   * 计算相机的zFar
   * - 按照地图 512 * 512 * 512的规格计算最大可视范围
   * - 地图与体素编辑器的尺寸比例为 1 / 16
   * - 单边长度 = 512 * 16 = 8192
   * - 可视空间的最低点是[-4096, -4096, -4096], 最高点是[4096, 4096, 4096]
   * - 计算包围该立方体的球的半径
   * - 半径是18538.769927812828 约等于 18539
   * - 默认视角的话还要再加上 CAMERA_POS_OFFSET 等于 18565
   * - 相机zFar稍大于默认视角距离，加上 CAMERA_Z_FAR_OFFSET
   */
  private calculateZFar(size: number, fov: number) {
    const halfSize = size / 2;

    return Math.round(
      this.getCameraDefaultDist(
        [halfSize, halfSize, halfSize],
        [-halfSize, -halfSize, -halfSize],
        fov,
      ) + CAMERA_Z_FAR_OFFSET,
    );
  }

  /**
   * 根据空间大小和fov计算默认视角的相机距离
   */
  private getCameraDefaultDist(max: vec3, min: vec3, fov: number) {
    const radius = vec3.distance(max, min) * 0.5;
    const sinFov = Math.sin(fov * 0.5);

    return radius / sinFov + CAMERA_POS_OFFSET;
  }

  /**
   * 根据模型空间大小和摄像机目标计算摄像机位置
   */
  private getCameraPosition(
    max: vec3,
    min: vec3,
    target: vec3,
    cameraDir?: vec3,
  ) {
    const distance = this.getCameraDefaultDist(
      max,
      min,
      this.perspectiveCamera.fov,
    );

    return vec3.scaleAndAdd(
      vec3.create(),
      target,
      cameraDir || this.cameraDir,
      distance,
    );
  }

  /**
   * 获得空间中心点作为摄像机目标
   */
  private getCameraTarget(max: vec3, min: vec3): vec3 {
    const target = vec3.create();
    vec3.sub(target, max, min);
    vec3.scale(target, target, 0.5);
    vec3.add(target, target, min);
    return target;
  }

  /**
   * 根据模型空间设置相机
   */
  private setCameraBySpaceSize(max: vec3, min: vec3, cameraDir?: vec3) {
    const target = this.getCameraTarget(max, min);
    this.camera.setPosition(
      this.getCameraPosition(max, min, target, cameraDir),
    );
    this.camera.lookAt(target);
  }

  public switchCameraMode(perspective: boolean) {
    const lastCamera = this.camera;
    this.camera = perspective
      ? this.perspectiveCamera
      : this.orthographicCamera;
    this.camera.sync(lastCamera);
  }

  /**
   * 重置摄像机
   * @param max 模型空间最大坐标，默认为workspace的大小
   * @param min 模型空间最小坐标，默认为空间原点
   */
  public resetCamera(opt: { max?: vec3; min?: vec3; cameraDir?: vec3 } = {}) {
    const { max, min, cameraDir } = opt;
    const _max = max || store.getState().editing.workspaceSize;
    const _min = min || vec3.create();
    this.setCameraBySpaceSize(_max, _min, cameraDir);

    vec3.copy(this.orbitControls.target, this.getCameraTarget(_max, _min));
    this.orbitControls.reset();
  }

  /**
   * 平移摄像机，使得模型内容看起来在原地变化
   * @param shift
   * @returns
   */
  public translateCamera(shift: vec3): void {
    if (vec3.equals(shift, [0, 0, 0])) {
      return;
    }
    const offset = vec3.create();
    vec3.negate(offset, shift);
    vec3.add(this.camera.position, this.camera.position, offset);
    vec3.add(this.camera.target, this.camera.target, offset);

    this.camera.lookAt(this.camera.target);

    this.orbitControls.reset();
  }

  /**
   * 设置鼠标状态，并更新OrbitControls.enabled。
   */
  public setPointerAction = (pointerAction: PointerAction) => {
    this.orbitControls.enabled = pointerAction === PointerAction.Idle;
    store.dispatch(setPointerAction(pointerAction));
  };

  private removeResizeListener = (): void => undefined;

  private resize = () => {
    const domRect = this.renderer.domElement.getBoundingClientRect();

    this.domRect = domRect;

    const { width, height } = domRect;

    // 更新画布分辨率
    this.updateResolution(width, height);

    // 更新相机aspect
    const aspect = width / height;

    [this.perspectiveCamera, this.orthographicCamera].forEach((camera) => {
      camera.aspect = aspect;

      camera.updateProjectionMatrix();
    });
  };

  private addResizeListener() {
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
  private updateResolution(width: number, height: number) {
    this.renderer.domElement.width = width * window.devicePixelRatio;
    this.renderer.domElement.height = height * window.devicePixelRatio;
  }

  /**
   * 获取缓存的画布尺寸信息
   */
  public getRendererDOMRect(): DOMRect {
    return this.domRect;
  }

  /**
   * 销毁Stage
   * TODO 补充其他控件的销毁
   */
  public destroy() {
    this.removeResizeListener();
  }
}
