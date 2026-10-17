import type {
  VertexArrayObject,
  Buffer as REGLBuffer,
  AttributeConfig,
  Regl,
} from '@box/regl';
import { nextPow2 } from 'bit-twiddle';
import { Mesh } from '../../rendering/objects/mesh';
import { MeshGeometry } from '../../rendering/geometries/mesh-geometry';
import { ShaderMaterial } from '../../rendering/materials/shader';

import fragmentShader from './frag.glsl';
import vertexShader from './vertex.glsl';
import { BoxGeometry } from '../../rendering/geometries/box-geometry';

export class SkinPartAOMesh extends Mesh {
  public material: ShaderMaterial;
  public geometry: MeshGeometry;
  public rawMeshBuffer: Uint16Array;

  public alpha = 1;
  /**
   * 是否开启发光功能
   */
  public emissive = false;

  private buffer: REGLBuffer;
  private vao: VertexArrayObject;

  constructor(
    regl: Regl,
    private box: BoxGeometry,
    rawMeshBuffer?: Uint16Array,
  ) {
    const geometry = new MeshGeometry();
    const material = new ShaderMaterial({
      fragmentShader,
      vertexShader,
      uniforms: {
        'Lightness[0]': 0.6,
        'Lightness[1]': 0.7,
        'Lightness[2]': 0.75,
        'Lightness[3]': 1.0,
        'Lightness[4]': 0.5,
        'Lightness[5]': 0.4,
        'Lightness[6]': 0.1,
        'alpha': 1,
        'enableEmissive': true,
      },
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
        s1: 1,
        s2: 2,
      },
    });
    super(regl, geometry, material);

    this.buffer = this.regl.buffer(4096);
    this.material = material;
    this.geometry = geometry;

    this.rawMeshBuffer = rawMeshBuffer || new Uint16Array(0);
    this.vao = this.createVao(this.rawMeshBuffer);
    this.geometry.vao = this.vao;

    this.updateSize();

    regl.on('lost', () => {
      this.vao.destroy();
    });

    regl.on('restore', () => {
      this.updateSize();
      this.updateBuffer(this.rawMeshBuffer);
    });
  }

  public draw() {
    this.material.transparent = this.alpha < 1;
    if (this.material.uniforms) {
      this.material.uniforms['alpha'] = this.alpha;
      this.material.uniforms['enableEmissive'] = this.emissive;
    }

    super.draw();
  }

  public updateBuffer(rawMeshBuffer: Uint16Array) {
    this.vao.destroy();
    this.rawMeshBuffer = rawMeshBuffer;
    this.vao = this.createVao(this.rawMeshBuffer);

    this.geometry.vao = this.vao;
  }

  public updateSize() {
    const position = this.box.getAttribute('position');
    const normal = this.box.getAttribute('normal');
    if (position && normal) {
      this.geometry.setAttribute('position', position);
      this.geometry.setAttribute('normal', normal);
    }
  }

  private createVao(rawMeshBuffer: Uint16Array) {
    const count = Math.floor(rawMeshBuffer.length / 9) | 0;
    this.buffer = this.regl.buffer(nextPow2(rawMeshBuffer.byteLength));
    this.buffer(rawMeshBuffer);

    const s0: AttributeConfig = {
      buffer: this.buffer,
      offset: 0,
      stride: 18,
      size: 4,
      divisor: 0,
    };

    const s1: AttributeConfig = {
      buffer: this.buffer,
      offset: 8,
      stride: 18,
      size: 4,
      divisor: 0,
    };

    const s2: AttributeConfig = {
      buffer: this.buffer,
      offset: 16,
      stride: 18,
      size: 1,
      divisor: 0,
    };

    return this.regl.vao({
      attributes: [s0, s1, s2],
      count,
      primitive: 'triangles',
    });
  }
}
