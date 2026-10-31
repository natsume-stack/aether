import type { Regl } from '@box/regl';
import { RenderOrder } from '../animator-app/util';
import { PlaneGeometry } from '../rendering/geometries/plane-geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import { Mesh } from '../rendering/objects/mesh';
import fragmentShader from './frag.glsl';
import vertexShader from './vertex.glsl';

export class Grid extends Mesh {
  public material: ShaderMaterial;

  constructor(regl: Regl) {
    const geometry = new PlaneGeometry({
      width: 320,
      height: 320,
    });

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      blend: {
        enable: true,
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
      cull: {
        enable: false,
      },
      uniforms: {
        size: 320,
        gridSize: 4,
      },
      transparent: true,
    });

    super(regl, geometry, material);

    this.material = material;

    this.renderOrder = RenderOrder.grid;
  }
}
