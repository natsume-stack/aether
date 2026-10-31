import type { Regl } from '@box/regl';
import { lerp } from '@box/voxa-project';
import { vec3 } from 'gl-matrix';
import { Mesh } from '../rendering/objects/mesh';
import { ShaderMaterial } from '../rendering/materials/shader';
import { BoxGeometry } from '../rendering/geometries/box-geometry';
import { basicFragmentShader, basicVertexShader } from '../rendering/shaders';

const HIGHLIGHT_COLOR = [0.51, 0.87, 0];
/**
 * 透明度动画一个循环2秒
 */
const ALPHA_DURATION = 2000;

function applyAlphaEasing(weight: number) {
  if (weight < 0.5) {
    return 2 * weight;
  }

  return -2 * weight + 2;
}

export class HighlightBox extends Mesh {
  public material: ShaderMaterial;
  public geometry: BoxGeometry;
  public startTime: number;

  private alpha = 0.6;

  constructor(regl: Regl, size: vec3) {
    const geometry = new BoxGeometry({ size });

    const material = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: HIGHLIGHT_COLOR,
        alpha: 0.6,
      },
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
        enable: false,
        mask: false,
        func: '<=',
      },
    });

    super(regl, geometry, material);
    this.material = material;
    this.geometry = geometry;
    this.startTime = Date.now();
  }

  public draw(): void {
    const delta = (Date.now() - this.startTime) % ALPHA_DURATION;
    // 透明度在0.6 - 0之间变化
    this.alpha = lerp(0.6, 0, applyAlphaEasing(delta / ALPHA_DURATION));

    if (this.material.uniforms) {
      this.material.uniforms['alpha'] = this.alpha;
    }
    super.draw();
  }

  public update(size: vec3) {
    this.geometry.update({ size });
  }
}
