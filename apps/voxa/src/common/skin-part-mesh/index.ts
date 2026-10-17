import type { AttributeConfig, Elements, Regl, Texture2D } from '@box/regl';
import { MeshGeometry } from '../../models/rendering/geometries/mesh-geometry';
import { ShaderMaterial } from '../../models/rendering/materials/shader';
import { Mesh } from '../../models/rendering/objects/mesh';
import vertexShader from './vertex.vert';
import fragmentShader from './fragment.frag';
import { BIG_ELEMENT_SIZE, initQuad, SMALL_ELEMENT_SIZE } from './util';

export interface MeshData {
  meshData: Uint16Array | Uint8Array;
  uvData: Uint16Array | Uint8Array;
  count: number;
}

export interface GLTexture {
  texture: Texture2D;
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RenderData {
  mesh: MeshData;
  glTexture: GLTexture;
}

const LIGHTNESS = [1.0, 0.85, 0.82, 0.75, 0.7, 0.65];
interface Light {
  top: number;
  bottom: number;
  right: number;
  left: number;
  back: number;
  front: number;
}

const TopLight: Light = {
  top: LIGHTNESS[0],
  bottom: LIGHTNESS[1],
  right: LIGHTNESS[2],
  left: LIGHTNESS[3],
  back: LIGHTNESS[4],
  front: LIGHTNESS[5],
};

const FrontLight: Light = {
  front: LIGHTNESS[0],
  back: LIGHTNESS[1],
  right: LIGHTNESS[2],
  left: LIGHTNESS[3],
  top: LIGHTNESS[4],
  bottom: LIGHTNESS[5],
};

export class SkinPartMesh extends Mesh {
  public material: ShaderMaterial;
  public geometry: MeshGeometry;

  /**
   * 强行渲染，不需要计算是否在相机范围内
   */
  protected frustumCulled = false;

  public raycast = () => {};

  public alpha: number = 1;

  // 按需创建，所有skinPart共享

  // mesh顶点顺序
  private static smallElements?: Elements | undefined = undefined;
  private static bigElements?: Elements | undefined = undefined;
  // 空texture占位
  private static emptyTexture?: Texture2D | undefined = undefined;
  private static getEmptyTexture(regl: Regl) {
    if (!SkinPartMesh.emptyTexture) {
      SkinPartMesh.emptyTexture = regl.texture();
      regl.on('destroy', () => {
        SkinPartMesh.emptyTexture = undefined;
      });

      regl.on('lost', () => {
        SkinPartMesh.emptyTexture = undefined;
      });
    }
    return SkinPartMesh.emptyTexture;
  }

  private renderData?: RenderData;

  constructor(
    regl: Regl,
    options?: {
      /**
       * 渲染数据，可以是无，就是没有东西渲染
       */
      renderData?: RenderData;
      /**
       * 灯光类型，顶光或者面光
       * 默认顶光
       */
      lightType?: 'top' | 'front';
    },
  ) {
    const light = options?.lightType === 'front' ? FrontLight : TopLight;
    const geometry = new MeshGeometry();

    const material = new ShaderMaterial({
      fragmentShader: fragmentShader,
      vertexShader: vertexShader,
      blend: {
        enable: (() => this.material.transparent) as any,
        func: {
          srcRGB: 'src alpha',
          srcAlpha: 1,
          dstRGB: 'one minus src alpha',
          dstAlpha: 1,
        },
        equation: {
          rgb: 'add',
          alpha: 'add',
        },
        color: [1, 1, 1, 1],
      },
      depth: {
        enable: true,
        mask: true,
        func: '<=',
      },
      cull: {
        enable: true,
        face: 'back',
      },
      attributes: {
        s0: 0,
        uv: 1,
      },
      uniforms: {
        'alpha': 1,
        'texture': SkinPartMesh.getEmptyTexture(regl),
        'textureShape': [0, 0],
        // 左
        'Lightness[0]': light.left,
        // 右
        'Lightness[1]': light.right,
        // 下
        'Lightness[2]': light.bottom,
        // 上
        'Lightness[3]': light.top,
        // 后
        'Lightness[4]': light.back,
        // 前
        'Lightness[5]': light.front,
        'Lightness[6]': 0.3,
      },
    });

    super(regl, geometry, material);

    this.material = material;
    this.material.transparent = false;
    this.geometry = geometry;

    this.update(options?.renderData);

    regl.on('lost', () => {
      this.geometry.vao?.destroy();
      this.geometry.vao = undefined;
    });

    regl.on('restore', () => {
      this.update(this.renderData);
    });
  }

  public update(renderData?: RenderData) {
    this.renderData = renderData;
    this.geometry.vao?.destroy();
    this.geometry.vao = this.createVao(renderData?.mesh);
    if (!this.material.uniforms) {
      return;
    }

    if (renderData) {
      const { texture, data, width, height } = renderData.glTexture;
      texture({
        data,
        width,
        height,
        wrap: 'clamp',
      });
      this.material.uniforms['texture'] = texture;
      this.material.uniforms['textureShape'] = [width, height];
    } else {
      this.material.uniforms['texture'] = SkinPartMesh.getEmptyTexture(
        this.regl,
      );
      this.material.uniforms['textureShape'] = [0, 0];
    }
  }

  private createVao(mesh?: MeshData) {
    const count = mesh?.count || 0;
    const meshData = mesh?.meshData || new Uint8Array();
    const uvData = mesh?.uvData || new Uint8Array();

    const elements = this.getQuadElements(count);

    if (!elements) {
      return;
    }

    const buffer = this.regl.buffer(meshData);

    const s0: AttributeConfig = {
      buffer,
      offset: 0,
      stride: 4,
      size: 4,
      divisor: 0,
      normalized: false,
    };

    const uvBuffer = this.regl.buffer(uvData);

    const uvStride = uvData instanceof Uint8Array ? 2 : 4;

    const uv: AttributeConfig = {
      buffer: uvBuffer,
      offset: 0,
      stride: uvStride,
      size: 2,
      divisor: 0,
      normalized: false,
    };

    return this.regl.vao({
      attributes: [s0, uv],
      elements,
      count,
      primitive: 'triangles',
    });
  }

  public draw() {
    this.material.transparent = this.alpha < 1;

    if (this.material.uniforms) {
      this.material.uniforms['alpha'] = this.alpha;
    }

    super.draw();
  }

  private getQuadElements(count: number) {
    if (count <= SMALL_ELEMENT_SIZE) {
      if (!SkinPartMesh.smallElements) {
        SkinPartMesh.smallElements = this.regl.elements(
          initQuad(new Uint16Array(SMALL_ELEMENT_SIZE)),
        );

        this.regl.on('destroy', () => {
          SkinPartMesh.smallElements = undefined;
        });

        this.regl.on('lost', () => {
          SkinPartMesh.smallElements = undefined;
        });
      }

      return SkinPartMesh.smallElements;
    }

    if (
      count <= BIG_ELEMENT_SIZE &&
      this.regl.hasExtension('OES_element_index_uint')
    ) {
      if (!SkinPartMesh.bigElements) {
        SkinPartMesh.bigElements = this.regl.elements(
          initQuad(new Uint32Array(BIG_ELEMENT_SIZE)),
        );

        this.regl.on('destroy', () => {
          SkinPartMesh.bigElements = undefined;
        });

        this.regl.on('lost', () => {
          SkinPartMesh.bigElements = undefined;
        });
      }
      return SkinPartMesh.bigElements;
    }

    return undefined;
  }
}
