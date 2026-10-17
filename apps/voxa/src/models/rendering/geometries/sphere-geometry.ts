import { vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

export interface SphereOptions {
  radius: number;
  widthSegments: number;
  heightSegments: number;
  phiStart: number;
  phiLength: number;
  thetaStart: number;
  thetaLength: number;
}

export class SphereGeometry extends Geometry {
  public type = GeometryType.Sphere;

  private params: SphereOptions = {
    radius: 1,
    widthSegments: 32,
    heightSegments: 16,
    phiStart: 0,
    phiLength: Math.PI * 2,
    thetaStart: 0,
    thetaLength: Math.PI,
  };

  constructor(options?: Partial<SphereOptions>) {
    super();

    if (options) {
      Object.keys(options).forEach((item) => {
        this.params[item] = options[item];
      });
    }

    this.params.widthSegments = Math.max(
      3,
      Math.floor(this.params.widthSegments),
    );
    this.params.heightSegments = Math.max(
      2,
      Math.floor(this.params.heightSegments),
    );

    // generate vertices, normals and uvs
    const { vertices, normals, uvs, grid } = this.generateVerticesNormalsUvs();
    // indices
    const indices = this.generateIndices(grid);

    // build geometry
    this.setElementsByArray(indices, 3);
    this.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(vertices), 3),
    );
    this.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(normals), 3),
    );
    this.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  }

  private generateVerticesNormalsUvs() {
    const {
      thetaStart,
      thetaLength,
      heightSegments,
      widthSegments,
      radius,
      phiStart,
      phiLength,
    } = this.params;

    const thetaEnd = Math.min(thetaStart + thetaLength, Math.PI);
    let index = 0;

    const vertex = vec3.create();
    const normal = vec3.create();

    // buffers
    const grid: number[][] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let iy = 0; iy <= heightSegments; iy++) {
      const verticesRow: number[] = [];

      const v = iy / heightSegments;

      // special case for the poles

      let uOffset = 0;

      if (iy == 0 && thetaStart == 0) {
        uOffset = 0.5 / widthSegments;
      } else if (iy == heightSegments && thetaEnd == Math.PI) {
        uOffset = -0.5 / widthSegments;
      }

      for (let ix = 0; ix <= widthSegments; ix++) {
        const u = ix / widthSegments;

        // vertex

        vertex[0] =
          -radius *
          Math.cos(phiStart + u * phiLength) *
          Math.sin(thetaStart + v * thetaLength);
        vertex[1] = radius * Math.cos(thetaStart + v * thetaLength);
        vertex[2] =
          radius *
          Math.sin(phiStart + u * phiLength) *
          Math.sin(thetaStart + v * thetaLength);

        vertices.push(vertex[0], vertex[1], vertex[2]);

        // normal
        vec3.copy(normal, vertex);
        vec3.normalize(normal, normal);
        normals.push(normal[0], normal[1], normal[2]);

        // uv
        uvs.push(u + uOffset, 1 - v);

        verticesRow.push(index++);
      }

      grid.push(verticesRow);
    }

    return {
      vertices,
      normals,
      uvs,
      grid,
    };
  }

  private generateIndices(grid: number[][]) {
    const { thetaStart, thetaLength, heightSegments, widthSegments } =
      this.params;
    const thetaEnd = Math.min(thetaStart + thetaLength, Math.PI);

    // buffer
    const indices: number[] = [];

    for (let iy = 0; iy < heightSegments; iy++) {
      for (let ix = 0; ix < widthSegments; ix++) {
        const a = grid[iy][ix + 1];
        const b = grid[iy][ix];
        const c = grid[iy + 1][ix];
        const d = grid[iy + 1][ix + 1];

        if (iy !== 0 || thetaStart > 0) indices.push(a, b, d);
        if (iy !== heightSegments - 1 || thetaEnd < Math.PI)
          indices.push(b, c, d);
      }
    }

    return indices;
  }
}
