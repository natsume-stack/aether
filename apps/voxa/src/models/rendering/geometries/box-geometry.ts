import { vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

type BoxGeometryParams = {
  /**
   * 长方体的尺寸
   */
  size: vec3;
  /**
   * 是否在计算体素，由于每个点都被扩充为体素，end都需要+1。
   * @default false
   */
  isVoxel?: boolean;
  /**
   * 法向量朝内还是朝外。
   * @default false
   */
  outerNormal?: boolean;
};

export class BoxGeometry extends Geometry {
  public type = GeometryType.Box;

  /**
   * BoxGeometry必然有Elements
   */
  public declare elements: BufferAttribute;
  public size: vec3;
  private isVoxel: boolean;
  private outerNormal: boolean;

  constructor(params: BoxGeometryParams) {
    super();

    const { size, isVoxel = false, outerNormal = false } = params;

    this.size = vec3.clone(size);

    this.isVoxel = isVoxel;

    this.outerNormal = outerNormal;

    this.updateAttributes();
  }

  private updateAttributes() {
    const { positions, normals, elements } = generateCuboid(
      [0, 0, 0],
      this.size,
      this.isVoxel,
      this.outerNormal,
    );

    this.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3),
    );
    this.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(normals), 3),
    );
    this.setElementsByArray(elements, 3);
  }

  public update(params: BoxGeometryParams) {
    const {
      size,
      isVoxel = this.isVoxel,
      outerNormal = this.outerNormal,
    } = params;

    if (
      vec3.exactEquals(size, this.size) &&
      isVoxel === this.isVoxel &&
      outerNormal === this.outerNormal
    ) {
      return;
    }

    vec3.copy(this.size, size);

    this.isVoxel = isVoxel;

    this.outerNormal = outerNormal;

    this.updateAttributes();

    super.updateBounding();
  }
}

/**
 * 取两点在范围内生成立方体
 * @param a
 * @param b
 * @param isVoxel 是否在计算体素，由于每个点都被扩充为体素，end都需要+1
 * @param outerNormal 严重怀疑这里写反了，true时反而拿到的是朝内的法向量
 * @param range
 * @returns
 */
export function generateCuboid(
  a: vec3,
  b: vec3,
  isVoxel: boolean,
  outerNormal: boolean,
  range?: vec3 | boolean,
) {
  const { start, end } = boundary(
    a,
    b,
    [-Infinity, -Infinity, -Infinity],
    [Infinity, Infinity, Infinity],
  );
  /**
   * 立方体的6个面的顶点，6*4=24个，有重合
   */
  const positions: number[] = [];
  /**
   * 构成立方体的三角形，用于渲染
   */
  const elements: number[] = [];
  /**
   * 6个面的法向量，用来确定顶点顺序
   */
  const normals: number[] = [];
  const nSign = outerNormal ? -1 : 1;
  if (isVoxel) {
    for (let i = 0; i < 3; i++) {
      if (range) {
        end[i] = Math.min(end[i] + 1, range[i]);
      } else {
        end[i] = end[i] + 1;
      }
    }
  }

  positions.push(start[0], start[1], start[2]);
  positions.push(start[0], start[1], end[2]);
  positions.push(end[0], start[1], end[2]);
  positions.push(end[0], start[1], start[2]);

  positions.push(start[0], end[1], start[2]);
  positions.push(end[0], end[1], start[2]);
  positions.push(end[0], end[1], end[2]);
  positions.push(start[0], end[1], end[2]);

  positions.push(end[0], start[1], start[2]);
  positions.push(end[0], start[1], end[2]);
  positions.push(end[0], end[1], end[2]);
  positions.push(end[0], end[1], start[2]);

  positions.push(start[0], start[1], start[2]);
  positions.push(start[0], end[1], start[2]);
  positions.push(start[0], end[1], end[2]);
  positions.push(start[0], start[1], end[2]);

  positions.push(start[0], start[1], start[2]);
  positions.push(end[0], start[1], start[2]);
  positions.push(end[0], end[1], start[2]);
  positions.push(start[0], end[1], start[2]);

  positions.push(start[0], start[1], end[2]);
  positions.push(start[0], end[1], end[2]);
  positions.push(end[0], end[1], end[2]);
  positions.push(end[0], start[1], end[2]);

  for (let i = 0; i < 4; i++) {
    normals.push(0, 1 * nSign, 0);
  }
  for (let i = 0; i < 4; i++) {
    normals.push(0, -1 * nSign, 0);
  }
  for (let i = 0; i < 4; i++) {
    normals.push(-1 * nSign, 0, 0);
  }
  for (let i = 0; i < 4; i++) {
    normals.push(1 * nSign, 0, 0);
  }
  for (let i = 0; i < 4; i++) {
    normals.push(0, 0, 1 * nSign);
  }
  for (let i = 0; i < 4; i++) {
    normals.push(0, 0, -1 * nSign);
  }

  const surfaceIndex = [0, 4, 8, 12, 16, 20];
  for (let i = 0; i < surfaceIndex.length; i++) {
    if (nSign == -1) {
      elements.push(
        surfaceIndex[i] + 2,
        surfaceIndex[i] + 1,
        surfaceIndex[i],

        surfaceIndex[i],
        surfaceIndex[i] + 3,
        surfaceIndex[i] + 2,
      );
    } else {
      elements.push(
        surfaceIndex[i],
        surfaceIndex[i] + 1,
        surfaceIndex[i] + 2,

        surfaceIndex[i] + 2,
        surfaceIndex[i] + 3,
        surfaceIndex[i],
      );
    }
  }
  return {
    positions,
    elements,
    normals,
  };
}

/**
 * 取两点，在限制大小内，生成立方体
 * @param a
 * @param b
 * @param minima
 * @param maxima
 * @returns 返回立方体的对角顶点坐标
 */
export function boundary(
  a: vec3,
  b: vec3,
  minima: vec3,
  maxima: vec3,
): { start: vec3; end: vec3 } {
  const minX = Math.max(Math.min(a[0], b[0]), minima[0]);
  const maxX = Math.min(Math.max(a[0], b[0]), maxima[0]);
  const minY = Math.max(Math.min(a[1], b[1]), minima[1]);
  const maxY = Math.min(Math.max(a[1], b[1]), maxima[1]);
  const minZ = Math.max(Math.min(a[2], b[2]), minima[2]);
  const maxZ = Math.min(Math.max(a[2], b[2]), maxima[2]);
  return {
    start: [minX, minY, minZ],
    end: [maxX, maxY, maxZ],
  };
}
