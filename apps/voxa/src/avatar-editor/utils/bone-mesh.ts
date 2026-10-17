import type { Regl } from '@box/regl';
import { TorusGeometry } from '../../models/rendering/geometries/torus-geometry';
import { ShaderMaterial } from '../../models/rendering/materials/shader';
import {
  basicFragmentShader,
  basicVertexShader,
} from '../../models/rendering/shaders';
import { Mesh } from '../../models/rendering/objects/mesh';
import { BODY_PART_DEFAULT_SCALE } from '@box/schema/player/player-schema';

const RADIUS = 1.6 * BODY_PART_DEFAULT_SCALE;
const DEFAULT_COLOR = [0.6, 0.84, 0.53];

export class BoneMesh extends Mesh {
  public raycast = () => {};

  constructor(regl: Regl) {
    const shader = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: DEFAULT_COLOR,
        alpha: 1,
      },
      depth: {
        enable: false,
        mask: false,
      },
      cull: {
        enable: false,
      },
      transparent: true,
    });
    const ringGeometry = new TorusGeometry({
      radius: RADIUS,
      tube: 0.1 * BODY_PART_DEFAULT_SCALE,
      radialSegments: 3,
      tubularSegments: 25,
    });
    super(regl, ringGeometry, shader);
  }
}
