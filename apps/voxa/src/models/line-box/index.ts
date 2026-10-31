import type { Regl } from '@box/regl';
import { vec3 } from 'gl-matrix';
import { Mesh } from '../rendering/objects/mesh';
import { ShaderMaterial } from '../rendering/materials/shader';
import { BoxGeometry } from '../rendering/geometries/box-geometry';

import fragmentShader from './frag.glsl';
import vertexShader from './vertex.glsl';

export class LineBox extends Mesh {
  public material: ShaderMaterial;
  public geometry: BoxGeometry;

  public alpha = 1;
  public color = [1, 1, 1, 1];

  constructor(regl: Regl, size: vec3) {
    const geometry = new BoxGeometry({ size });

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
      depth: {
        enable: true,
        mask: false,
        func: '<=',
      },
      cull: {
        enable: false,
      },
      uniforms: {
        color: [1, 1, 1, 1],
        size: vec3.clone(size),
      },
      transparent: true,
    });

    super(regl, geometry, material);
    this.material = material;
    this.geometry = geometry;
  }

  public draw(): void {
    if (this.material.uniforms) {
      this.material.uniforms['color'] = [
        this.color[0],
        this.color[1],
        this.color[2],
        this.alpha,
      ];
    }
    super.draw();
  }

  public update(size: vec3) {
    this.geometry.update({ size });

    if (this.material.uniforms && this.material.uniforms['size']) {
      vec3.copy(this.material.uniforms['size'], size);
    }
  }
}
