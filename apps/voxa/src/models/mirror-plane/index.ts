import { vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import type { AxisType } from '@box/box-design';
import { ShaderMaterial } from '../rendering/materials/shader';
import { Mesh } from '../rendering/objects/mesh';
import vertexShader from './vert.glsl';
import fragmentShader from './frag.glsl';
import { Geometry } from '../rendering/geometry';
import { BufferAttribute } from '../rendering/geometries/buffer-attribute';

/**
 * 镜像平面
 */
export class MirrorPlane extends Mesh {
  private size: vec3;
  private axis: AxisType;

  constructor(regl: Regl, size: vec3, axis: AxisType) {
    const geometry = new Geometry();

    updateMirrorPlaneGeo(geometry, size, axis);

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        color: [1, 1, 1],
        alpha: 0.09,
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
        enable: true,
        mask: true,
        func: '<=',
      },
      cull: {
        enable: false,
      },
      transparent: true,
    });

    super(regl, geometry, material);

    this.size = vec3.clone(size);

    this.axis = axis;
  }

  public update(size: vec3, axis: AxisType) {
    if (this.axis === axis && vec3.exactEquals(this.size, size)) {
      return;
    }

    updateMirrorPlaneGeo(this.geometry, size, axis);

    vec3.copy(this.size, size);

    this.axis = axis;
  }
}

/**
 * 更新镜像平面geometry
 * @param geometry [mutated] 镜像平面geometry
 * @param size 建模空间大小
 * @param axis 镜像平面的法线方向
 * @returns
 */
function updateMirrorPlaneGeo(geometry: Geometry, size: vec3, axis: AxisType) {
  /**
   * 平面的4个顶点
   */
  const positions: number[] = [];
  /**
   * 构成平面的三角形，用于渲染
   */
  const elements: number[] = [];
  /**
   * 平面的法线
   */
  let normals: number[] = [];

  let [x, y, z] = size;
  switch (axis) {
    /**
     * 平面法线与X轴平行
     */
    case 'X':
      const halfX = x / 2;
      positions.push(halfX, 0, 0);
      positions.push(halfX, y, 0);
      positions.push(halfX, y, z);
      positions.push(halfX, 0, z);

      normals = Array(4).fill([1, 0, 0]).flat();
      break;
    /**
     * 平面法线与Y轴平行
     */
    case 'Y':
      const halfY = y / 2;
      positions.push(0, halfY, 0);
      positions.push(0, halfY, z);
      positions.push(x, halfY, z);
      positions.push(x, halfY, 0);

      normals = Array(4).fill([0, 1, 0]).flat();
      break;
    /**
     * 平面法线与Z轴平行
     */
    case 'Z':
      const halfZ = z / 2;
      positions.push(0, 0, halfZ);
      positions.push(x, 0, halfZ);
      positions.push(x, y, halfZ);
      positions.push(0, y, halfZ);

      normals = Array(4).fill([0, 0, 1]).flat();
    default:
      break;
  }
  elements.push(0, 1, 2, 2, 3, 0);

  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array(normals), 3),
  );
  geometry.setElementsByArray(elements, 3);
}
