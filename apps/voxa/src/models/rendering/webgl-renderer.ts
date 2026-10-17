import type {
  DefaultContext,
  DrawCommand,
  Framebuffer,
  Regl,
  ReglProps,
  Vec4,
} from '@box/regl';
import { Object3D, Object3DType } from './objects/object3d';
import type { Scene } from './objects/scene';
import { Camera } from './camera/base';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { WebGLBackground } from './webgl-background';
import { RenderItem, WebGLRenderList } from './webgl-render-list';
import { Frustum } from './math/frustum';
import { FloatBufferType, PostProcess } from './post-process';

const TEMP_VEC3 = vec3.create();

const DEFAULT_CONFIG: RenderConfig = {
  postProcess: false,
  bloomEnabled: false,
  ssaoEnabled: false,
};

type CommandContextProps = {
  fbo: Framebuffer | null;
  position: vec3;
  viewMatrix: mat4;
  projectionMatrix: mat4;
  matrixWorld: mat4;
  projectionMatrixInverse: mat4;
  time: number;
  invViewProjection: mat4;
};

export interface RenderConfig {
  /**
   * 是否开启后期处理
   * @default false
   */
  postProcess?: boolean;
  /**
   * 是否开启泛光效果，仅在后期处理开启时有效。
   * @default false
   */
  bloomEnabled?: boolean;
  /**
   * 是否开启SSAO，仅在后期处理开启时有效。
   * @default false
   */
  ssaoEnabled?: boolean;
}

export class WebGLRenderer {
  /**
   * 存储 webglcontextlost 的触发状态
   */
  private _isContextLost: boolean = false;

  /**
   * 渲染对象列表
   */
  private renderList: WebGLRenderList = new WebGLRenderList();

  private projScreenMatrix = mat4.create();
  private frustum = new Frustum();

  private readonly contextCommand: DrawCommand<
    DefaultContext,
    CommandContextProps
  >;

  private postProcess: PostProcess;
  private background: WebGLBackground;
  public readonly domElement: HTMLCanvasElement;

  /**
   * 部分texture buffer的类型，比如postProcess.fboColor
   * 根据设备是否支持来确定用哪种，fallback顺序：['half float', 'float', 'uint8']
   */
  public readonly floatBufferType: FloatBufferType;

  constructor(public readonly regl: Regl) {
    this.domElement = this.regl._gl.canvas as HTMLCanvasElement;
    this.background = new WebGLBackground(this);
    this.floatBufferType = this.getFloatBufferType();
    this.postProcess = new PostProcess(this.regl, this.floatBufferType);
    this.contextCommand = this.createContext();

    this.regl.on('lost', () => {
      this._isContextLost = true;
      // Lost context 再 Restore 后需要触发一次浏览器的刷新
      // 这里利用 visibility 的变化达到这个效果
      this.domElement.style.visibility = 'hidden';
    });

    this.regl.on('restore', () => {
      this._isContextLost = false;
      this.domElement.style.visibility = '';
    });
  }

  private createContext(): DrawCommand<DefaultContext, CommandContextProps> {
    const modelMatrix = mat4.identity(mat4.create());

    const prop: ReglProps<CommandContextProps> = this.regl.prop;

    return this.regl({
      framebuffer: prop('fbo'),
      context: {
        model: modelMatrix,
        eye: prop('position'),
        view: prop('viewMatrix'),
        projection: prop('projectionMatrix'),
        invView: prop('matrixWorld'),
        invProjection: prop('projectionMatrixInverse'),
      },
      uniforms: {
        model: modelMatrix,
        u_time: prop('time'),
        eye: prop('position'),
        view: prop('viewMatrix'),
        projection: prop('projectionMatrix'),
        invView: prop('matrixWorld'),
        invProjection: prop('projectionMatrixInverse'),
        invViewProj: prop('invViewProjection'),
      },
    });
  }

  private getDistanceToCamera(object: Object3D) {
    mat4.getTranslation(TEMP_VEC3, object.matrixWorld);
    vec3.transformMat4(TEMP_VEC3, TEMP_VEC3, this.projScreenMatrix);
    return TEMP_VEC3[2];
  }

  /**
   * 渲染场景中的所有对象
   * @param scene 被渲染的场景
   * @param camera 用于渲染的摄像机
   * @param config 渲染相关配置，默认关闭后期处理
   * @returns
   */
  public render(
    scene: Scene,
    camera: Camera,
    config: RenderConfig = DEFAULT_CONFIG,
  ) {
    if (this._isContextLost === true) return;

    this.postProcess.update(config);

    this.contextCommand(
      {
        // TODO 旧代码，我也不知道为啥是这个奇怪的数
        fbo: this.postProcess.fbo,
        time: ((Date.now() % 1200) / 1200) * Math.PI * 2,
        position: camera.position,
        viewMatrix: camera.viewMatrix,
        matrixWorld: camera.matrixWorld,
        projectionMatrix: camera.projectionMatrix,
        projectionMatrixInverse: camera.projectionMatrixInverse,
        invViewProjection: camera.invViewProjection,
      },
      () => {
        this.background.render(scene);

        scene.updateMatrixWorld();

        if (camera.parent === undefined) {
          camera.updateMatrixWorld();
        }

        mat4.mul(
          this.projScreenMatrix,
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        );
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

        this.renderList.init();

        this.projectObject(scene);
        this.renderList.sort();

        // render list
        this.renderList.opaque.length &&
          this.renderObjects(camera, this.renderList.opaque);
        this.renderList.transparent.length &&
          this.renderObjects(camera, this.renderList.transparent);

        if (config.postProcess) {
          if (config.bloomEnabled) {
            this.postProcess.bloom();
          }

          if (config.ssaoEnabled) {
            this.postProcess.ssao();
          }

          this.postProcess.draw();
        }
      },
    );
  }

  /**
   * 根据渲染对象，展开构造渲染结构列表
   * @param object
   * @returns
   */
  private projectObject(object: Object3D) {
    if (object.visible === false) return;

    if (!object.getFrustumCulled() || this.frustum.intersectsObject(object)) {
      const z = this.getDistanceToCamera(object);
      this.renderList.push(object, z);
    }

    const children = object.children;

    for (let i = 0, l = children.length; i < l; i++) {
      this.projectObject(children[i]);
    }
  }

  private renderObjects(camera: Camera, renderItems: RenderItem[]) {
    for (let i = 0, l = renderItems.length; i < l; i++) {
      const renderItem = renderItems[i].object;
      this.renderObject(renderItem, camera);
    }
  }

  private renderObject(object: Object3D, camera: Camera) {
    if (object.type === Object3DType.Scene) {
      // 这里看起来有个TS的Bug，使用isScene会导致后面的object变为never
      return;
    }

    mat4.mul(object.modelViewMatrix, camera.viewMatrix, object.matrixWorld);

    object.draw();
  }

  public clear(color: vec4) {
    this.regl.clear({
      color: color as Vec4,
      depth: 1,
    });
  }

  private getFloatBufferType(): FloatBufferType {
    if (this.regl.hasExtension('OES_texture_half_float')) {
      return 'half float';
    }

    if (this.regl.hasExtension('OES_texture_float')) {
      return 'float';
    }

    return 'uint8';
  }
}
