import type { Regl } from '@box/regl';
import type { Camera } from '../../camera/base';
import { mat3, mat4, quat, vec3 } from 'gl-matrix';

import { Object3D } from '../../objects/object3d';
import { ShaderMaterial } from '../../materials/shader';
import { Mesh } from '../../objects/mesh';
import { Axis } from '../../def';

import { basicFragmentShader, basicVertexShader } from '../../shaders';
import { TorusGeometry } from '../../geometries/torus-geometry';
import {
  AxisToolMesh,
  TransformTool,
  TransformType,
  AxisTool,
  BLUE,
  GRAY,
  GREEN,
  HALF_PI,
  RED,
  WHITE,
  UNIT,
} from './def';
import { CircleGeometry } from '../../geometries/circle-geometry';
import { SphereGeometry } from '../../geometries/sphere-geometry';

const TEMP_Q = quat.create();
const TEMP_V = vec3.create();
const TEMP_V2 = vec3.create();
const TEMP_M3 = mat3.create();

export class Rotate extends Object3D implements TransformTool {
  public readonly transformType: TransformType = TransformType.Rotate;
  public interactiveObjects: Mesh[] = [];

  public axisTools: Ring[] = [];

  /**
   * 纯视觉辅助灰色的轴
   * 不在axisTools中
   */
  private ringHelper: Ring;

  constructor(regl: Regl) {
    super();
    this.ringHelper = new Ring(regl, Axis.E, GRAY);

    const xRing = new Ring(regl, Axis.X, RED);
    const yRing = new Ring(regl, Axis.Y, GREEN);
    const zRing = new Ring(regl, Axis.Z, BLUE);

    this.interactiveObjects = [
      xRing.interactive,
      yRing.interactive,
      zRing.interactive,
    ];
    this.axisTools = [xRing, yRing, zRing];

    this.add(
      xRing.activeCircle,
      yRing.activeCircle,
      zRing.activeCircle,
      this.ringHelper.body,
      xRing.body,
      yRing.body,
      zRing.body,
      xRing.sphere,
      yRing.sphere,
      zRing.sphere,
      this.ringHelper.interactive,
      xRing.interactive,
      yRing.interactive,
      zRing.interactive,
    );
  }

  public getAxisToolByInteractiveObj(object: Object3D) {
    return this.axisTools.find((ring) => ring.interactive === object);
  }

  public rotateWithCamera(camera: Camera) {
    if (!this.parent) {
      return;
    }
    quat.invert(TEMP_Q, this.parent.quaternionWorld);
    vec3.copy(TEMP_V, camera.position);
    vec3.transformQuat(TEMP_V, TEMP_V, TEMP_Q);

    quat.invert(TEMP_Q, this.parent.quaternionWorld);
    quat.mul(TEMP_Q, TEMP_Q, camera.quaternion);
    quat.copy(this.ringHelper.body.quaternion, TEMP_Q);
    quat.copy(this.ringHelper.activeCircle.quaternion, TEMP_Q);
    quat.copy(this.ringHelper.interactive.quaternion, TEMP_Q);

    for (const ring of this.axisTools) {
      switch (ring.axis) {
        case Axis.X:
          quat.setAxisAngle(
            TEMP_Q,
            UNIT[Axis.X],
            Math.atan2(-TEMP_V[1], TEMP_V[2]),
          );
          quat.rotateY(TEMP_Q, TEMP_Q, HALF_PI);
          quat.rotateZ(TEMP_Q, TEMP_Q, HALF_PI);
          break;
        case Axis.Y:
          quat.setAxisAngle(
            TEMP_Q,
            UNIT[Axis.Y],
            Math.atan2(TEMP_V[0], TEMP_V[2]),
          );
          quat.rotateX(TEMP_Q, TEMP_Q, -HALF_PI);
          quat.rotateZ(TEMP_Q, TEMP_Q, Math.PI);
          break;
        case Axis.Z:
          quat.setAxisAngle(
            TEMP_Q,
            UNIT[Axis.Z],
            Math.atan2(TEMP_V[1], TEMP_V[0]),
          );
          quat.rotateZ(TEMP_Q, TEMP_Q, -HALF_PI);
          break;
      }

      quat.copy(ring.body.quaternion, TEMP_Q);
      quat.copy(ring.activeCircle.quaternion, TEMP_Q);
      quat.copy(ring.interactive.quaternion, TEMP_Q);
    }
  }
}

class Ring implements AxisTool {
  public readonly body: AxisToolMesh;
  public readonly activeCircle: AxisToolMesh;
  public readonly interactive: AxisToolMesh;
  public readonly sphere: AxisToolMesh;

  private activeCircleGeometry: CircleGeometry;
  private material: ShaderMaterial;

  private prevDir = vec3.create();
  private cross = vec3.create();
  private totalRad: number = 0;

  constructor(regl: Regl, public readonly axis: Axis, private color: vec3) {
    this.material = this.getShaderMaterial(color, 1);

    const bodyGeometry = new TorusGeometry({
      radius: 6,
      tube: 0.1,
      radialSegments: 3,
      tubularSegments: 64,
      arc: axis === Axis.E ? Math.PI * 2 : Math.PI,
    });
    this.activeCircleGeometry = new CircleGeometry({
      radius: 6,
      segments: 64,
    });
    const interactiveGeometry = new TorusGeometry({
      radius: 6,
      tube: 0.5,
      radialSegments: 15,
      tubularSegments: 64,
      arc: axis === Axis.E ? Math.PI * 2 : Math.PI,
    });

    const sphereGeometry = new SphereGeometry({
      radius: 0.2,
      widthSegments: 16,
      heightSegments: 8,
    });

    this.body = new AxisToolMesh(regl, bodyGeometry, this.material);
    this.activeCircle = new AxisToolMesh(
      regl,
      this.activeCircleGeometry,
      this.getShaderMaterial(color, 0.5),
    );
    this.interactive = new AxisToolMesh(
      regl,
      interactiveGeometry,
      this.material,
    );
    this.sphere = new AxisToolMesh(regl, sphereGeometry, this.material);
    this.activeCircle.visible = false;
    this.interactive.visible = false;
    this.sphere.visible = false;
  }

  public setActive(active: boolean) {
    if (!this.material.uniforms) {
      return;
    }
    const newColor = active ? WHITE : this.color;
    this.material.uniforms['color'] = vec3.clone(newColor);
  }

  public setVisible(visible: boolean) {
    this.body.visible = visible;
  }

  public handleDragStart(offset: vec3, parentInvert: mat4) {
    this.totalRad = 0;
    vec3.copy(this.prevDir, offset);
    vec3.transformMat3(TEMP_V, offset, mat3.fromMat4(TEMP_M3, parentInvert));

    vec3.transformQuat(TEMP_V2, [1, 0, 0], this.activeCircle.quaternion);
    const startRad = this.getRadByDir(TEMP_V, TEMP_V2);
    this.activeCircleGeometry.update({ thetaStart: startRad, thetaLength: 0 });
    this.activeCircle.visible = true;
    this.sphere.visible = true;
  }

  public handleDrag(
    intersection: vec3,
    matrixWorld: mat4,
    quaternionWorld: quat,
  ) {
    vec3.sub(TEMP_V, intersection, mat4.getTranslation(TEMP_V2, matrixWorld));
    vec3.cross(this.cross, TEMP_V, this.prevDir);
    const rad = this.getRadByDir(TEMP_V, this.prevDir);
    vec3.transformQuat(TEMP_V2, UNIT[this.axis], quaternionWorld);
    const diff = Math.abs(rad) * (vec3.dot(this.cross, TEMP_V2) > 0 ? -1 : 1);
    this.totalRad += diff;
    this.totalRad = this.totalRad % (Math.PI * 2);
    this.activeCircleGeometry.update({ thetaLength: this.totalRad });
    vec3.copy(this.prevDir, TEMP_V);
    return {
      currDiff: diff,
      totalDiff: this.totalRad,
    };
  }

  public handleDragEnd() {
    this.activeCircle.visible = false;
    this.sphere.visible = false;
    return this.totalRad;
  }

  private getRadByDir(a: vec3, b: vec3) {
    const cos =
      vec3.dot(a, b) /
      (vec3.distance(a, [0, 0, 0]) * vec3.distance(b, [0, 0, 0]));

    // 计算得来的数字都不靠谱，提前处理下特殊情况

    // 如果出现 0 / 0 说明本次diff角度为0
    if (isNaN(cos)) {
      return 0;
    }
    // 虽然理论上得到的数字一定在[-1, 1]之间
    // 但是各种除不尽的约数会导致他得出1.000000002之类的数字
    // 这里做一个取值矫正
    return Math.acos(Math.min(Math.max(cos, -1), 1));
  }

  private getShaderMaterial(color: vec3, alpha: number) {
    return new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color,
        alpha,
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
  }
}
