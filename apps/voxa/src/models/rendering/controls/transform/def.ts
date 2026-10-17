import type { Camera } from '../../camera/base';
import type { Object3D } from '../../objects/object3d';
import type { Regl } from '@box/regl';

import { Mesh } from '../../objects/mesh';
import { Geometry } from '../../geometry';
import { ShaderMaterial } from '../../materials/shader';

import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { Axis } from '../../def';
import { CylinderGeometry } from '../../geometries/cylinder-geometry';
import { SphereGeometry } from '../../geometries/sphere-geometry';
import { basicFragmentShader, basicVertexShader } from '../../shaders';

/**
 * #E83232
 */
export const RED: vec3 = [0.91, 0.2, 0.2];

/**
 * #32E844
 */
export const GREEN: vec3 = [0.2, 0.91, 0.267];

/**
 * #00C2FF
 */
export const BLUE: vec3 = [0, 0.76, 1];

/**
 * #FFFFFF
 */
export const WHITE: vec3 = [1, 1, 1];

/**
 * #616161
 */
export const GRAY: vec3 = [0.38, 0.38, 0.38];

/**
 * #FADC19
 */
export const YELLOW: vec3 = [0.98, 0.86, 0.098];

export const HALF_PI = Math.PI / 2;

/**
 * 节点scale的默认值
 */
export const IDENTITY_SCALE: vec3 = [1, 1, 1];
/**
 * 节点世界轴(父级)缩放矩阵默认值
 */
export const IDENTITY_SCALE_MAT3: mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const MIN_SCALE = 0.001;
export const MIN_SCALE_VEC: vec3 = [MIN_SCALE, MIN_SCALE, MIN_SCALE];

export const UNIT = {
  [Axis.X]: vec3.fromValues(1, 0, 0),
  [Axis.Y]: vec3.fromValues(0, 1, 0),
  [Axis.Z]: vec3.fromValues(0, 0, 1),
};

export enum TransformType {
  Translate,
  Rotate,
  Pivot,
  Scale,
}

export interface TransformTool extends Object3D {
  readonly transformType: TransformType;
  interactiveObjects: Object3D[];
  axisTools: AxisTool[];
  rotateWithCamera(camera: Camera): void;
  getAxisToolByInteractiveObj(object: Object3D): AxisTool | undefined;
}

export interface AxisTool {
  readonly axis: Axis;
  setActive(active: boolean): void;
  setVisible(visible: boolean): void;
  handleDragStart(offset: vec3, parentInvert: mat4, matrixWorld: mat4): void;
  handleDrag(
    intersection: vec3,
    matrixWorld: mat4,
    quaternionWorld: quat,
  ): { currDiff: number; totalDiff: number };
  handleDragEnd(): number;
}

export class AxisToolMesh extends Mesh {
  constructor(regl: Regl, geometry: Geometry, material: ShaderMaterial) {
    super(regl, geometry, material);

    // 为了操作杆不被任何物体挡住，放在最后渲染
    this.renderOrder = Infinity;
  }
}

const TEMP_V = vec3.create();
/**
 * 单轴工具简易基础类
 * translate和scale单轴缩放工具通用，他们俩只有头不一样
 */
export abstract class BasicAxisTool implements AxisTool {
  public abstract head: AxisToolMesh;
  public body: AxisToolMesh;
  public interactive: AxisToolMesh;
  public sphere: AxisToolMesh;

  protected bodyHeight = 10;
  protected headHeight = 2.4;
  protected bodyGeometry: CylinderGeometry;
  protected material: ShaderMaterial;

  private parentInvert = mat4.create();
  private offset = vec3.create();
  private prevPos = vec3.create();
  private totalDiff = 0;

  constructor(regl: Regl, public readonly axis: Axis, private color: vec3) {
    this.material = this.getShaderMaterial(color);

    this.bodyGeometry = new CylinderGeometry({
      radiusTop: 0.05,
      radiusBottom: 0.05,
      height: this.bodyHeight,
    });
    const interactiveGeometry = new CylinderGeometry({
      radiusTop: 0.8,
      radiusBottom: 0.8,
      height: this.bodyHeight + this.headHeight,
    });

    const sphereGeometry = new SphereGeometry({
      radius: 0.2,
      widthSegments: 16,
      heightSegments: 8,
    });

    this.body = new AxisToolMesh(regl, this.bodyGeometry, this.material);
    this.interactive = new AxisToolMesh(
      regl,
      interactiveGeometry,
      this.material,
    );
    this.sphere = new AxisToolMesh(regl, sphereGeometry, this.material);
    this.interactive.visible = false;
    this.sphere.visible = false;
  }

  protected initTransform(axis: Axis) {
    const q = quat.create();

    switch (axis) {
      case Axis.X:
        quat.rotateZ(q, q, -HALF_PI);
        break;
      case Axis.Z:
        quat.rotateX(q, q, HALF_PI);
        break;
    }
    const bodyPosOffset = this.bodyHeight / 2;
    const headPosOffset = this.bodyHeight + this.headHeight / 2;
    const interactivePosOffset = (this.bodyHeight + this.headHeight) / 2;

    quat.copy(this.body.quaternion, q);
    quat.copy(this.head.quaternion, q);
    quat.copy(this.interactive.quaternion, q);

    vec3.scale(TEMP_V, UNIT[axis], bodyPosOffset);
    vec3.copy(this.body.position, TEMP_V);

    vec3.scale(TEMP_V, UNIT[axis], headPosOffset);
    vec3.copy(this.head.position, TEMP_V);

    vec3.scale(TEMP_V, UNIT[axis], interactivePosOffset);
    vec3.copy(this.interactive.position, TEMP_V);
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
    this.head.visible = visible;
  }

  public handleDragStart(offset: vec3, parentInvert: mat4, matrixWorld: mat4) {
    this.totalDiff = 0;
    vec3.copy(this.offset, offset);
    mat4.copy(this.parentInvert, parentInvert);
    mat4.getTranslation(TEMP_V, matrixWorld);
    vec3.transformMat4(TEMP_V, TEMP_V, parentInvert);
    vec3.copy(this.prevPos, TEMP_V);
    this.sphere.visible = true;
  }

  public handleDrag(intersection: vec3) {
    vec3.sub(TEMP_V, intersection, this.offset);
    vec3.transformMat4(TEMP_V, TEMP_V, this.parentInvert);
    const diff = TEMP_V[this.axis] - this.prevPos[this.axis];
    this.totalDiff += diff;
    vec3.copy(this.prevPos, TEMP_V);
    return {
      currDiff: diff,
      totalDiff: this.totalDiff,
    };
  }

  public handleDragEnd() {
    this.sphere.visible = false;
    return this.totalDiff;
  }

  private getShaderMaterial(color: vec3) {
    return new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: color,
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
  }
}
