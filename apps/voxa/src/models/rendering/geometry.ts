import { vec3 } from 'gl-matrix';
import {
  BufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
} from './geometries/buffer-attribute';
import { MeshGeometry } from './geometries/mesh-geometry';
import { Box3 } from './math/box3';
import { Sphere } from './math/sphere';
import { arrayNeedsUint32 } from './utils/pool';

export const enum GeometryType {
  Basic,
  Box,
  Circle,
  Cylinder,
  Mesh,
  Plane,
  Sphere,
  Torus,
}

const BOX = new Box3();
const VECTOR = vec3.create();

export class Geometry {
  public type = GeometryType.Basic;

  public attributes: {
    [key: string]: () => BufferAttribute;
  } = {};

  /**
   * 多面体的顶点序列 Elements
   */
  public elements?: BufferAttribute;
  public boundingBox?: Box3;
  public boundingSphere?: Sphere;

  /**
   * 将数组设置为 Elements，会生成对应的 BufferAttribute
   * @param newElements 顶点序列数组
   * @param itemSize 绘制形状的顶点数，通常三角形为3，线条为2
   * @returns
   */
  public setElementsByArray(newElements: number[], itemSize: number) {
    this.elements = new (
      arrayNeedsUint32(newElements)
        ? Uint32BufferAttribute
        : Uint16BufferAttribute
    )(newElements, itemSize);

    return this;
  }

  public getAttribute(name: string) {
    if (this.attributes[name]) {
      return this.attributes[name]();
    }
  }

  public setAttribute(name: string, value: BufferAttribute) {
    this.attributes[name] = () => value;
  }

  public computeBoundingBox() {
    if (!this.boundingBox) {
      this.boundingBox = new Box3();
    }

    const position = this.getAttribute('position');
    if (!position) {
      return this.boundingBox.makeEmpty();
    }

    return this.boundingBox.setFromBufferAttribute(position);
  }

  public computeBoundingSphere() {
    if (!this.boundingSphere) {
      this.boundingSphere = new Sphere();
    }

    const position = this.getAttribute('position');
    if (!position) {
      return this.boundingSphere.makeEmpty();
    }

    // first, find the center of the bounding sphere
    const center = this.boundingSphere.center;
    BOX.setFromBufferAttribute(position);
    BOX.getCenter(center);

    // second, try to find a boundingSphere with a radius smaller than the
    // boundingSphere of the boundingBox: sqrt(3) smaller in the best case

    let maxRadiusSq = 0;

    for (let i = 0, il = position.count; i < il; i++) {
      const item = position.getItem(i);

      if (position.array.shape[1] === 2) {
        vec3.set(VECTOR, item[0], item[1], 0);
      } else {
        vec3.set(VECTOR, item[0], item[1], item[2]);
      }
      maxRadiusSq = Math.max(maxRadiusSq, vec3.squaredDistance(center, VECTOR));
    }
    this.boundingSphere.radius = Math.sqrt(maxRadiusSq);
    if (isNaN(this.boundingSphere.radius)) {
      console.error(
        'geometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',
        this,
      );
    }
    return this.boundingSphere;
  }

  protected updateBounding() {
    this.boundingBox = undefined;
    this.boundingSphere = undefined;
  }

  public isMesh(): this is MeshGeometry {
    return this.type === GeometryType.Mesh;
  }
}
