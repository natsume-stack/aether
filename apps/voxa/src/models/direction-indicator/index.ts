import { mat4, quat, vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { Object3D } from '../rendering/objects/object3d';
import { Mesh } from '../rendering/objects/mesh';
import { CylinderGeometry } from '../rendering/geometries/cylinder-geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import { basicFragmentShader, basicVertexShader } from '../rendering/shaders';

const TEMP_MAT = mat4.create();

interface Parameters {
  regl: Regl;
  /**
   * 箭头中线的x坐标
   */
  centerX: number;
  /**
   * 箭头所在空间的最大z坐标，箭头位置基于该坐标增加一定的间距
   */
  maxZ: number;
  /**
   * 箭头的放大倍数
   */
  shapeScale: number;
}

export class DirectionIndicator extends Object3D {
  public material: ShaderMaterial;

  private radialSegments = 4;
  private centerX: number;
  private maxZ: number;
  private shapeScale: number;

  private regl: Regl;

  constructor(param: Parameters) {
    super();
    this.regl = param.regl;

    const material = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      depth: {
        enable: true,
        mask: true,
        func: '<=',
      },
      uniforms: {
        color: [0.7, 0.7, 0.7],
        alpha: 1,
      },
    });
    this.material = material;

    const { centerX, maxZ, shapeScale } = param;
    this.centerX = centerX;
    this.maxZ = maxZ;
    this.shapeScale = shapeScale;
    this.updateShape();
  }

  public update(param: Parameters) {
    const { centerX, maxZ, shapeScale } = param;
    if (
      centerX === this.centerX &&
      this.maxZ === maxZ &&
      shapeScale === this.shapeScale
    ) {
      return;
    }

    this.centerX = centerX;
    this.maxZ = maxZ;
    this.shapeScale = shapeScale;
    this.updateShape();
  }

  private updateShape() {
    this.clear();

    /**
     * 箭头的四个顶点
     *    3
     *    1
     *  2   4
     */
    const margin1 = this.shapeScale / 9; // 顶点1距离z轴边缘的距离
    const margin2 = this.shapeScale / 10; // 顶点2/4距离z轴边缘的距离
    const diff = this.shapeScale / 16; // 顶点1和顶点3在z轴上的距离，顶点1和顶点2/4在x轴上的距离
    const radius = this.shapeScale / 450;

    const vertices: vec3[] = [];
    vertices.push(vec3.fromValues(this.centerX, 0, this.maxZ + margin1));
    vertices.push(vec3.fromValues(this.centerX - diff, 0, this.maxZ + margin2));
    vertices.push(vec3.fromValues(this.centerX, 0, this.maxZ + margin1 + diff));
    vertices.push(vec3.fromValues(this.centerX + diff, 0, this.maxZ + margin2));

    this.drawLineBox(vertices[0], vertices[1], radius);
    this.drawLineBox(vertices[1], vertices[2], radius);
    this.drawLineBox(vertices[2], vertices[3], radius);
    this.drawLineBox(vertices[3], vertices[0], radius);
  }

  /**
   * 在两点之间绘制一个柱体
   */
  private drawLineBox(pointA: vec3, pointB: vec3, radius: number) {
    const geometry = new CylinderGeometry({
      radiusTop: radius,
      radiusBottom: radius,
      height: vec3.dist(pointA, pointB),
      radialSegments: this.radialSegments,
    });
    const mesh = new Mesh(this.regl, geometry, this.material);

    mat4.targetTo(TEMP_MAT, pointA, pointB, this.up);
    mat4.getRotation(mesh.quaternion, TEMP_MAT);
    quat.rotateX(mesh.quaternion, mesh.quaternion, Math.PI / 2);
    vec3.set(
      mesh.position,
      (pointA[0] + pointB[0]) / 2,
      (pointA[1] + pointB[1]) / 2,
      (pointA[2] + pointB[2]) / 2,
    );

    this.add(mesh);
  }
}
