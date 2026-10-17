import type { Regl } from '@box/regl';
import type { Camera } from '../../camera/base';
import { mat4, quat, vec3 } from 'gl-matrix';

import { Object3D } from '../../objects/object3d';
import { ShaderMaterial } from '../../materials/shader';
import { Mesh } from '../../objects/mesh';
import { Axis } from '../../def';

import { basicFragmentShader, basicVertexShader } from '../../shaders';
import { TorusGeometry } from '../../geometries/torus-geometry';
import {
  TransformTool,
  TransformType,
  AxisTool,
  WHITE,
  AxisToolMesh,
  BasicAxisTool,
  BLUE,
  GREEN,
  RED,
} from './def';
import { CircleGeometry } from '../../geometries/circle-geometry';
import { BoxGeometry } from '../../geometries/box-geometry';

const TEMP_Q = quat.create();
const TEMP_V = vec3.create();
const TEMP_M = mat4.create();

/**
 * 缩放工具由一个圆环（TorusGeometry）和一个圆（Circle）组成
 * - 圆环表现视觉效果
 * - 圆作为交互热区
 */
export class Scale extends Object3D implements TransformTool {
  public interactiveObjects: Mesh[] = [];
  public readonly transformType: TransformType = TransformType.Scale;

  public axisTools: (Cube | RingTool)[] = [];

  public readonly ring: RingTool;

  constructor(regl: Regl) {
    super();
    const xCube = new Cube(regl, Axis.X, RED);
    const yCube = new Cube(regl, Axis.Y, GREEN);
    const zCube = new Cube(regl, Axis.Z, BLUE);
    this.ring = new RingTool(regl);

    this.interactiveObjects = [
      xCube.interactive,
      yCube.interactive,
      zCube.interactive,
      this.ring.interactive,
    ];
    this.axisTools = [xCube, yCube, zCube, this.ring];

    this.add(
      xCube.body,
      yCube.body,
      zCube.body,
      xCube.head,
      yCube.head,
      zCube.head,
      xCube.sphere,
      yCube.sphere,
      zCube.sphere,
      xCube.interactive,
      yCube.interactive,
      zCube.interactive,
      this.ring.filled,
      this.ring.fixed,
      this.ring.interactive,
    );
  }

  public rotateWithCamera(camera: Camera): void {
    if (!this.parent) {
      return;
    }
    quat.invert(TEMP_Q, this.parent.quaternionWorld);
    quat.mul(this.ring.filled.quaternion, TEMP_Q, camera.quaternion);
    quat.mul(this.ring.fixed.quaternion, TEMP_Q, camera.quaternion);
    quat.mul(this.ring.interactive.quaternion, TEMP_Q, camera.quaternion);
  }

  public getAxisToolByInteractiveObj(object: Object3D) {
    return this.axisTools.find((arrow) => arrow.interactive === object);
  }
}

const DEFAULT_BODY_HEIGHT = 10;
class Cube extends BasicAxisTool {
  public head: AxisToolMesh;
  protected headHeight = 1.2;

  constructor(regl: Regl, axis: Axis, color: vec3) {
    super(regl, axis, color);

    const cubeSize = vec3.fromValues(
      this.headHeight,
      this.headHeight,
      this.headHeight,
    );
    const headGeometry = new BoxGeometry({
      size: cubeSize,
    });

    this.head = new AxisToolMesh(regl, headGeometry, this.material);
    vec3.scale(this.head.pivot, cubeSize, -0.5);

    this.initTransform(axis);
  }

  public setActive(active: boolean): void {
    super.setActive(active);
  }

  private startParentScale = 1;
  public handleDragStart(
    offset: vec3,
    parentInvert: mat4,
    matrixWorld: mat4,
  ): void {
    super.handleDragStart(offset, parentInvert, matrixWorld);
    mat4.invert(TEMP_M, parentInvert);
    mat4.getScaling(TEMP_V, TEMP_M);
    this.startParentScale = TEMP_V[this.axis];
  }

  public handleDrag(intersection: vec3): {
    currDiff: number;
    totalDiff: number;
  } {
    const res = super.handleDrag(intersection);
    const diff = res.currDiff * this.startParentScale;
    this.bodyHeight += diff;
    this.bodyHeight = Math.max(0.1, this.bodyHeight);
    this.bodyGeometry.update({
      radiusTop: 0.05,
      radiusBottom: 0.05,
      height: this.bodyHeight,
    });
    this.initTransform(this.axis);
    return res;
  }

  public handleDragEnd(): number {
    const res = super.handleDragEnd();
    this.bodyHeight = DEFAULT_BODY_HEIGHT;
    this.bodyGeometry.update({
      radiusTop: 0.05,
      radiusBottom: 0.05,
      height: this.bodyHeight,
    });
    this.initTransform(this.axis);
    return res;
  }
}

/**
 * 设计稿上是120px
 * 参照旋转轴，140px的圆半径为6，那么此处半径 = (6 / 140) * 120;
 *
 * 其他半径数值以此类推
 */
const INACTIVE_RADIUS = 5.14;
export const FIXED_TORUS_RADIUS = 0.85;

// 外圈的透明度在激活/未激活状态不一样
const ACTIVE_ALPHA = 1;
const INACTIVE_ALPHA = 0.5;

const FIXED_DRAGGING_COLOR: vec3 = [129, 222, 0];
vec3.scale(FIXED_DRAGGING_COLOR, FIXED_DRAGGING_COLOR, 1 / 255);

/**
 * 缩放轴像个甜甜圈
 */
class RingTool implements AxisTool {
  public readonly axis: Axis = Axis.E;

  /**
   * 开始拖拽时，触点与圆心的距离
   */
  private dragStartDist: number = 0;
  /**
   * diff值代表圆环半径与初始圆环半径的差值
   */
  private totalDiff: number = 0;
  private prevRadius: number = 0;
  /**
   * 圆心
   */
  private center: vec3 = [0, 0, 0];

  private activeMaterial: ShaderMaterial;
  private activeGeometry: TorusGeometry;

  private fixedMaterial: ShaderMaterial;

  private filledGeometry: CircleGeometry;

  /**
   * 随拖拽变化的环
   * - 未拖拽时，用于表示交互区域
   * - 拖拽时，跟随拖拽位置变化
   * - 层级高于固定的环（fixedTorus）
   */
  public interactive: Mesh;
  /**
   * 尺寸固定的环
   * - 表示拖拽前的缩放比例，用于和变化的圈对比
   */
  public fixed: Mesh;
  /**
   * 带有填充色的圆
   * - 未拖拽时，和固定的圈
   */
  public filled: Mesh;

  constructor(regl: Regl) {
    this.activeMaterial = this.getShaderMaterial(WHITE, INACTIVE_ALPHA);

    this.activeGeometry = new TorusGeometry({
      radius: INACTIVE_RADIUS,
      tube: 0.1,
      radialSegments: 3,
      tubularSegments: 64,
      arc: Math.PI * 2,
    });

    this.interactive = new AxisToolMesh(
      regl,
      this.activeGeometry,
      this.activeMaterial,
    );

    this.fixedMaterial = this.getShaderMaterial(WHITE, 1);

    const fixedGeometry = new TorusGeometry({
      radius: FIXED_TORUS_RADIUS,
      tube: 0.1,
      radialSegments: 3,
      tubularSegments: 64,
      arc: Math.PI * 2,
    });

    this.fixed = new AxisToolMesh(regl, fixedGeometry, this.fixedMaterial);

    this.filledGeometry = new CircleGeometry({
      radius: FIXED_TORUS_RADIUS,
      segments: 64,
    });

    const filledMaterial = this.getShaderMaterial(WHITE, 0.21);

    this.filled = new AxisToolMesh(regl, this.filledGeometry, filledMaterial);
  }

  public setActive(active: boolean) {
    if (this.activeMaterial.uniforms) {
      this.activeMaterial.uniforms['alpha'] = active
        ? ACTIVE_ALPHA
        : INACTIVE_ALPHA;
    }
  }

  public setVisible(visible: boolean) {
    this.interactive.visible = visible;
    this.fixed.visible = visible;
    this.filled.visible = visible;
  }

  public handleDragStart(offset: vec3, parentInvert: mat4, matrixWorld: mat4) {
    // 计算圆心的位置
    mat4.getTranslation(this.center, matrixWorld);

    this.activeGeometry.update({ radius: FIXED_TORUS_RADIUS });
    this.filledGeometry.update({ radius: FIXED_TORUS_RADIUS });
    this.setFixedActive(true);

    mat4.getScaling(TEMP_V, matrixWorld);
    this.dragStartDist = vec3.len(offset) / TEMP_V[0];

    this.prevRadius = FIXED_TORUS_RADIUS;

    this.totalDiff = 0;
  }

  private setFixedActive(active: boolean) {
    const color = active ? FIXED_DRAGGING_COLOR : WHITE;
    if (
      this.fixedMaterial.uniforms &&
      !vec3.exactEquals(this.fixedMaterial.uniforms['color'], color)
    ) {
      this.fixedMaterial.uniforms['color'] = vec3.clone(color);
    }
  }

  public handleDrag(intersection: vec3, matrixWorld: mat4) {
    mat4.getScaling(TEMP_V, matrixWorld);

    const newDist = vec3.dist(intersection, this.center) / TEMP_V[0];
    const dist = newDist - this.dragStartDist;

    let radius = dist + FIXED_TORUS_RADIUS;
    radius = Math.max(radius, 0);

    const currDiff = radius - this.prevRadius;

    this.totalDiff += currDiff;
    this.prevRadius = radius;

    this.activeGeometry.update({ radius });
    this.filledGeometry.update({ radius });

    return {
      currDiff,
      totalDiff: this.totalDiff,
    };
  }

  public handleDragEnd() {
    this.setFixedActive(false);

    this.activeGeometry.update({ radius: INACTIVE_RADIUS });
    this.filledGeometry.update({ radius: FIXED_TORUS_RADIUS });

    return this.totalDiff;
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
