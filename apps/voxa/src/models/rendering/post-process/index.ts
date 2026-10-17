import {
  DefaultContext,
  DrawCommand,
  Framebuffer,
  Framebuffer2D,
  Regl,
  ReglProps,
  Texture2D,
  VertexArrayObject,
} from '@box/regl';
import { prevPow2 } from 'bit-twiddle';
import { RenderConfig } from '../webgl-renderer';

import basicVertexShader from './basic-vertex.glsl';
import uvVertexShader from './uv-vertex.glsl';
import initBrightsShader from './init-brights.glsl';
import downSampleBlurShader from './down-sample-blur.glsl';
import accumulateBloomShader from './accumulate-bloom.glsl';
import drawFboShader from './draw-fbo.glsl';
import ssaoFragment from './ssao.frag';

/**
 * down sample的次数
 */
const BLUR_NUM = 4;
/**
 * down sample的系数
 */
const BLUR_SCALE = 4;

interface BloomProp {
  /**
   * 顶点数据缓存
   */
  vao: VertexArrayObject;
  /**
   * 发光处理的输入对象，可能是初始的场景纹理，或过程中产生的纹理
   */
  pixels: Texture2D | Framebuffer | null;
  /**
   * 发光处理的输出对象
   */
  frameBuffer: Framebuffer;
  /**
   * 场景的尺寸
   */
  blurShape: [number, number];
  /**
   * 第n次模糊算法的结果，下同
   */
  blurBuffers0: Framebuffer;
  blurBuffers1: Framebuffer;
  blurBuffers2: Framebuffer;
}

interface SSAOProp {
  /**
   * 顶点数据缓存
   */
  vao: VertexArrayObject;
  /**
   * 未经后期处理的场景深度纹理
   */
  fboDepth: Texture2D | null;
  /**
   * ssao处理的输出对象
   */
  ssaoBuffer: Framebuffer | null;
}

interface DrawFboProp {
  /**
   * 顶点数据缓存
   */
  vao: VertexArrayObject;
  /**
   * 未经后期处理的场景纹理
   */
  color: Texture2D | null;
  /**
   * bloom效果的最终处理结果
   */
  bloom: Framebuffer;
  /**
   * ssao处理结果
   */
  ssao: Framebuffer;
}

export type FloatBufferType = 'half float' | 'float' | 'uint8';

export class PostProcess {
  /**
   * Create a shader which sets up a single fullscreen triangle which wrap all the subsequent shaders.
   */
  private triangle?: VertexArrayObject;

  private fboColor: Texture2D | null = null;
  private fboDepth: Texture2D | null = null;
  /**
   * 后期处理开启时，场景渲染到fbo的纹理上，对该纹理进行各种计算实现后期效果。
   *
   * 后期处理关闭时，fbo为null，即使用默认的framebuffer渲染场景。
   */
  public fbo: Framebuffer2D | null = null;
  private drawFbo: DrawCommand<DefaultContext, DrawFboProp>;

  private blurBuffers: Framebuffer[] = [];
  private blurShape: [number, number] = [0, 0];

  private initBrights: DrawCommand<DefaultContext, BloomProp>;
  private downSampleBlur: DrawCommand<DefaultContext, BloomProp>;
  private accumulateBloom: DrawCommand<DefaultContext, BloomProp>;

  private ssaoBuffer: Framebuffer2D | null = null;
  private ssaoCommand: DrawCommand<DefaultContext, SSAOProp>;

  /**
   * 空的frameBuffer，填充未开启特效的frameBuffer，作为uniform传入
   */
  private static emptyFrameBuffer?: Framebuffer2D | undefined = undefined;
  private static getEmptyFrameBuffer(regl: Regl) {
    if (!PostProcess.emptyFrameBuffer) {
      PostProcess.emptyFrameBuffer = regl.framebuffer();
      regl.on('destroy', () => {
        PostProcess.emptyFrameBuffer = undefined;
      });

      regl.on('lost', () => {
        PostProcess.emptyFrameBuffer = undefined;
      });
    }
    return PostProcess.emptyFrameBuffer;
  }

  constructor(private regl: Regl, private floatBufferType: FloatBufferType) {
    this.drawFbo = this.createDrawFbo();

    this.initBrights = this.createInitBrights();
    this.downSampleBlur = this.createDownSampleBlur();
    this.accumulateBloom = this.createAccumulateBloom();

    this.ssaoCommand = this.createSSAOCommand();

    regl.on('lost', this.destroy);
  }

  public destroy = () => {
    this.destroyFbo();
    this.destroyBlurBuffers();
    this.destroySSAO();
  };

  public update(config: RenderConfig) {
    const {
      postProcess = false,
      bloomEnabled = false,
      ssaoEnabled = false,
    } = config;

    if (!postProcess) {
      this.destroy();
      return;
    }

    this.initFbo();

    if (bloomEnabled) {
      this.initBlurBuffers();
    } else {
      this.destroyBlurBuffers();
    }

    if (ssaoEnabled) {
      this.initSSAO();
    } else {
      this.destroySSAO();
    }
  }

  private initFbo() {
    const width = this.regl._gl.drawingBufferWidth;
    const height = this.regl._gl.drawingBufferHeight;

    if (this.fbo && this.fboColor && this.fboDepth && this.triangle) {
      this.fbo.resize(width, height);
      return;
    }

    this.fboColor = this.regl.texture({
      shape: [width, height, 4],
      type: this.floatBufferType,
      format: 'rgba',
      min: 'linear',
      mag: 'linear',
    });
    this.fboDepth = this.regl.texture({
      shape: [width, height, 2],
      format: 'depth stencil',
      type: <any>'depth stencil',
    });
    this.fbo = this.regl.framebuffer({
      color: this.fboColor,
      depthStencil: this.fboDepth,
    });
    this.triangle = this.createTriangle();
  }

  private destroyFbo() {
    if (this.fbo) {
      this.fbo.destroy();
      this.fbo = null;
    }
    if (this.fboColor) {
      this.fboColor.destroy();
      this.fboColor = null;
    }
    if (this.fboDepth) {
      this.fboDepth.destroy();
      this.fboDepth = null;
    }
    if (this.triangle) {
      this.triangle.destroy();
      this.triangle = undefined;
    }
  }

  private initBlurBuffers() {
    let targetWidth = prevPow2(this.regl._gl.drawingBufferWidth);
    let targetHeight = prevPow2(this.regl._gl.drawingBufferHeight);

    this.blurShape = [targetWidth, targetHeight];
    this.blurBuffers.length = BLUR_NUM;

    for (let i = 0; i < BLUR_NUM; ++i) {
      const buffer = this.blurBuffers[i];
      if (buffer) {
        buffer.resize(targetWidth, targetHeight);
        return;
      }
      this.blurBuffers[i] = this.regl.framebuffer({
        color: this.regl.texture({
          shape: [targetWidth, targetHeight, 4],
          format: 'rgba',
          type: 'uint8',
          min: 'linear',
          mag: 'linear',
          wrap: 'clamp',
        }),
        depthStencil: false,
      });

      targetHeight = Math.max(1, Math.floor(targetHeight / BLUR_SCALE));
      targetWidth = Math.max(1, Math.floor(targetWidth / BLUR_SCALE));
    }
  }

  private destroyBlurBuffers() {
    for (let i = 0; i < this.blurBuffers.length; ++i) {
      const buffer = this.blurBuffers[i];
      if (buffer) {
        buffer.destroy();
      }
    }
    this.blurBuffers.length = 0;
  }

  public bloom() {
    // Compute the initial un-blurred bloom with the scene fbo as input to get a bright pass
    this.initBrights({
      vao: this.triangle,
      pixels: this.fboColor,
      frameBuffer: this.blurBuffers[0],
    });

    // Down scale the bright pass 3 times
    // Each of the downscaled bright pass outputs are blurred with a separable Gaussian filter
    for (let i = 0; i < BLUR_NUM - 1; ++i) {
      this.downSampleBlur({
        vao: this.triangle,
        pixels: this.blurBuffers[i],
        frameBuffer: this.blurBuffers[i + 1],
      });
    }

    // Add all blur buffers to the higher resolution bright pass output
    this.accumulateBloom({
      vao: this.triangle,
      blurShape: this.blurShape,
      frameBuffer: this.blurBuffers[0],
      blurBuffers0: this.blurBuffers[1],
      blurBuffers1: this.blurBuffers[2],
      blurBuffers2: this.blurBuffers[3],
    });
  }

  public draw() {
    this.drawFbo({
      vao: this.triangle,
      color: this.fboColor,
      bloom: !!this.blurBuffers[0]
        ? this.blurBuffers[0]
        : PostProcess.getEmptyFrameBuffer(this.regl),
      ssao: !!this.ssaoBuffer
        ? this.ssaoBuffer
        : PostProcess.getEmptyFrameBuffer(this.regl),
    });
  }

  private createTriangle() {
    return this.regl.vao({
      attributes: [
        [
          [-4, 0],
          [4, -4],
          [4, 4],
        ],
      ],
      elements: null,
      count: 3,
      offset: 0,
      primitive: 'triangles',
    });
  }

  private createInitBrights(): DrawCommand<DefaultContext, BloomProp> {
    const prop: ReglProps<BloomProp> = this.regl.prop;

    return this.regl({
      vert: uvVertexShader,
      frag: initBrightsShader,
      uniforms: {
        blurNum: BLUR_NUM,
        pixels: prop('pixels'),
      },
      attributes: {
        position: 0,
      },
      vao: prop('vao'),
      count: 3,
      offset: 0,
      primitive: 'triangles',
      framebuffer: prop('frameBuffer'),
    });
  }

  private createDownSampleBlur(): DrawCommand<DefaultContext, BloomProp> {
    const prop: ReglProps<BloomProp> = this.regl.prop;

    return this.regl({
      vert: basicVertexShader,
      frag: downSampleBlurShader,
      uniforms: {
        shape: ({ viewportWidth, viewportHeight }) => [
          viewportWidth,
          viewportHeight,
        ],
        pixels: prop('pixels'),
      },
      attributes: {
        position: 0,
      },
      vao: prop('vao'),
      count: 3,
      offset: 0,
      primitive: 'triangles',
      framebuffer: prop('frameBuffer'),
    });
  }

  private createAccumulateBloom(): DrawCommand<DefaultContext, BloomProp> {
    const prop: ReglProps<BloomProp> = this.regl.prop;

    return this.regl({
      vert: uvVertexShader,
      frag: accumulateBloomShader,
      uniforms: {
        'shape': prop('blurShape'),
        'blurBuffers[0]': prop('blurBuffers0'),
        'blurBuffers[1]': prop('blurBuffers1'),
        'blurBuffers[2]': prop('blurBuffers2'),
      },
      attributes: {
        position: 0,
      },
      vao: prop('vao'),
      count: 3,
      offset: 0,
      primitive: 'triangles',
      blend: {
        enable: true,
        func: { src: 1, dst: 1 },
        equation: 'add',
      },
      framebuffer: prop('frameBuffer'),
    });
  }

  private createDrawFbo(): DrawCommand<DefaultContext, DrawFboProp> {
    const prop: ReglProps<DrawFboProp> = this.regl.prop;

    return this.regl({
      vert: basicVertexShader,
      frag: drawFboShader,
      uniforms: {
        shape: ({ viewportWidth, viewportHeight }) => [
          viewportWidth,
          viewportHeight,
        ],
        color: prop('color'),
        bloomEnabled: () => !!this.blurBuffers[0],
        bloom: prop('bloom'),
        ssaoEnabled: () => !!this.ssaoBuffer,
        ssao: prop('ssao'),
      },
      attributes: {
        position: 0,
      },
      vao: prop('vao'),
      count: 3,
      offset: 0,
      primitive: 'triangles',
      depth: {
        enable: false,
        mask: false,
      },
      framebuffer: null,
    });
  }

  private initSSAO() {
    const {
      drawingBufferWidth: targetWidth,
      drawingBufferHeight: targetHeight,
    } = this.regl._gl;

    if (!this.ssaoBuffer) {
      this.ssaoBuffer = this.regl.framebuffer({
        color: this.regl.texture({
          shape: [targetWidth, targetHeight, 3],
          format: 'rgb',
          type: 'uint8',
        }),
        depthStencil: false,
      });
    } else {
      this.ssaoBuffer.resize(targetWidth, targetHeight);
    }
  }

  private destroySSAO() {
    if (!this.ssaoBuffer) {
      return;
    }

    this.ssaoBuffer.destroy();
    this.ssaoBuffer = null;
  }

  private createSSAOCommand(): DrawCommand<DefaultContext, SSAOProp> {
    const prop: ReglProps<SSAOProp> = this.regl.prop;

    return this.regl({
      framebuffer: prop('ssaoBuffer'),
      vert: basicVertexShader,
      frag: ssaoFragment,
      uniforms: {
        depthStencil: prop('fboDepth'),
        shape: ({ viewportWidth, viewportHeight }) => {
          return [viewportWidth, viewportHeight];
        },
      },
      attributes: {
        p: 0,
      },
      vao: prop('vao'),
      count: 3,
      offset: 0,
      primitive: 'triangles',
    });
  }

  public ssao() {
    this.ssaoCommand({
      vao: this.triangle,
      ssaoBuffer: this.ssaoBuffer,
      fboDepth: this.fboDepth,
    });
  }
}
