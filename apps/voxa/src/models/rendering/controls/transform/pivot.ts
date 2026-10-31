import type { Regl } from '@box/regl';
import type { Camera } from '../../camera/base';
import { quat } from 'gl-matrix';

import { ShaderMaterial } from '../../materials/shader';
import { basicFragmentShader, basicVertexShader } from '../../shaders';
import { TransformType, YELLOW, AxisToolMesh } from './def';
import { Translate } from './translate';
import { TorusGeometry } from '../../geometries/torus-geometry';
import { SphereGeometry } from '../../geometries/sphere-geometry';
import type { Object3D } from '../../objects/object3d';

const TEMP_Q = quat.create();

export class Pivot extends Translate {
  public readonly transformType: TransformType = TransformType.Pivot;
  public rotatedRing: Object3D;

  constructor(regl: Regl, rotatedRing?: Object3D) {
    super(regl);

    const { ringMaterial, sphereMaterial } = this.getMaterials();

    const ringGeometry = new TorusGeometry({
      radius: 0.6,
      tube: 0.1,
      radialSegments: 3,
      tubularSegments: 64,
    });

    const sphereGeometry = new SphereGeometry({
      radius: 0.2,
      widthSegments: 16,
      heightSegments: 8,
    });
    const sphere = new AxisToolMesh(regl, sphereGeometry, sphereMaterial);

    this.rotatedRing = rotatedRing
      ? rotatedRing
      : new AxisToolMesh(regl, ringGeometry, ringMaterial);

    this.add(sphere, this.rotatedRing);
  }

  public rotateWithCamera(camera: Camera): void {
    if (!this.parent) {
      return;
    }
    quat.invert(TEMP_Q, this.parent.quaternionWorld);
    quat.mul(this.rotatedRing.quaternion, TEMP_Q, camera.quaternion);
  }

  protected getMaterials() {
    const material = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: YELLOW,
        alpha: 1,
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
      transparent: true,
    });

    return {
      ringMaterial: material,
      sphereMaterial: material,
    };
  }
}
