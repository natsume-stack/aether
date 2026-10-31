import { vec2, vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

export interface CircleOptions {
  radius: number;
  segments: number;
  thetaStart: number;
  thetaLength: number;
}

export class CircleGeometry extends Geometry {
  public type = GeometryType.Circle;

  private params: CircleOptions = {
    radius: 1,
    segments: 8,
    thetaStart: 0,
    thetaLength: Math.PI * 2,
  };

  constructor(options?: Partial<CircleOptions>) {
    super();

    if (options) {
      Object.keys(options).forEach((item) => {
        this.params[item] = options[item];
      });
    }
    this.buildGeometry();
  }

  private buildGeometry() {
    this.params.segments = Math.max(3, this.params.segments);

    // buffers
    const indices: number[] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    // helper variables
    const vertex = vec3.create();
    const uv = vec2.create();

    // center point
    vertices.push(0, 0, 0);
    normals.push(0, 0, 1);
    uvs.push(0.5, 0.5);

    const { segments, thetaLength, thetaStart, radius } = this.params;

    for (let s = 0, i = 3; s <= segments; s++, i += 3) {
      const segment = thetaStart + (s / segments) * thetaLength;

      // vertex
      vertex[0] = radius * Math.cos(segment);
      vertex[1] = radius * Math.sin(segment);

      vertices.push(vertex[0], vertex[1], vertex[2]);

      // normal
      normals.push(0, 0, 1);

      // uvs
      uv[0] = (vertices[i] / radius + 1) / 2;
      uv[1] = (vertices[i + 1] / radius + 1) / 2;

      uvs.push(uv[0], uv[1]);
    }

    // indices
    for (let i = 1; i <= segments; i++) {
      indices.push(i, i + 1, 0);
    }

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

  public update(options: Partial<CircleOptions>) {
    Object.keys(options).forEach((item) => {
      this.params[item] = options[item];
    });
    this.buildGeometry();
    super.updateBounding();
  }
}
