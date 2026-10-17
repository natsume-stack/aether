import { vec2 } from 'gl-matrix';
import { Geometry } from '../geometry';
import { Material } from '../materials/material';
import { Object3D, Object3DType } from './object3d';
import { BufferAttribute } from '../geometries/buffer-attribute';

const _vStart: vec2 = [0, 0];
const _vEnd: vec2 = [0, 0];

export class Line extends Object3D {
  public readonly type: Object3DType = Object3DType.Line;

  constructor(public geometry: Geometry, public material: Material) {
    super();
  }

  /**
   * 画虚线时调用这个计算，得到每个顶点到第一个顶点的距离
   * Computes an array of distance values which are necessary for LineDashedMaterial. For each vertex in the geometry, the method calculates the cumulative length from the current point to the very beginning of the line.
   */
  public computeLineDistances() {
    const geometry = this.geometry;

    // we assume non-indexed geometry
    if (geometry.elements) {
      console.warn(
        'Line.computeLineDistances(): Computation only possible with non-indexed Geometry.',
      );

      return this;
    }

    const positionAttribute = geometry.getAttribute('position');

    if (!positionAttribute) {
      console.warn('Line.computeLineDistances(): Missing position attribute.');
      return this;
    }

    const lineDistances = [0];

    for (let i = 1, l = positionAttribute.count; i < l; i++) {
      vec2FromBufferAttribute(_vStart, positionAttribute, i - 1);
      vec2FromBufferAttribute(_vEnd, positionAttribute, i);

      lineDistances[i] = lineDistances[i - 1];
      lineDistances[i] += vec2.dist(_vStart, _vEnd);
    }

    geometry.setAttribute(
      'lineDistance',
      new BufferAttribute(new Float32Array(lineDistances), 1),
    );

    return this;
  }

  public draw(): void {}
}

function vec2FromBufferAttribute(
  out: vec2,
  bufferAttribute: BufferAttribute,
  idx: number,
): vec2 {
  const item = bufferAttribute.getItem(idx);

  out[0] = item[0];
  out[1] = item[1];

  return out;
}
