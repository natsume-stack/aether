import { vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

export interface TorusOptions {
  radius: number;
  tube: number;
  radialSegments: number;
  tubularSegments: number;
  arc: number;
}

export class TorusGeometry extends Geometry {
  public type = GeometryType.Torus;

  private params: TorusOptions = {
    radius: 1,
    tube: 0.4,
    radialSegments: 8,
    tubularSegments: 6,
    arc: Math.PI * 2,
  };

  constructor(options?: Partial<TorusOptions>) {
    super();

    if (options) {
      Object.keys(options).forEach((item) => {
        this.params[item] = options[item];
      });
    }

    this.params.radialSegments = Math.floor(this.params.radialSegments);
    this.params.tubularSegments = Math.floor(this.params.tubularSegments);

    this.buildGeometry();
  }

  private buildGeometry() {
    // buffers
    const indices: number[] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    // helper variables
    const center = vec3.create();
    const vertex = vec3.create();
    const normal = vec3.create();

    // generate vertices, normals and uvs
    const { radius, tube, radialSegments, tubularSegments, arc } = this.params;
    for (let j = 0; j <= radialSegments; j++) {
      for (let i = 0; i <= tubularSegments; i++) {
        const u = (i / tubularSegments) * arc;
        const v = (j / radialSegments) * Math.PI * 2;

        // vertex
        vertex[0] = (radius + tube * Math.cos(v)) * Math.cos(u);
        vertex[1] = (radius + tube * Math.cos(v)) * Math.sin(u);
        vertex[2] = tube * Math.sin(v);

        vertices.push(...vertex);

        // normal
        center[0] = radius * Math.cos(u);
        center[1] = radius * Math.sin(u);
        vec3.sub(normal, vertex, center);
        vec3.normalize(normal, normal);

        normals.push(...normal);

        // uv
        uvs.push(i / tubularSegments);
        uvs.push(j / radialSegments);
      }
    }

    // generate indices
    for (let j = 1; j <= radialSegments; j++) {
      for (let i = 1; i <= tubularSegments; i++) {
        // indices
        const a = (tubularSegments + 1) * j + i - 1;
        const b = (tubularSegments + 1) * (j - 1) + i - 1;
        const c = (tubularSegments + 1) * (j - 1) + i;
        const d = (tubularSegments + 1) * j + i;

        // faces
        indices.push(a, b, d, b, c, d);
      }
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

  public update(options: Partial<TorusOptions>) {
    Object.keys(options).forEach((item) => {
      this.params[item] = options[item];
    });

    this.params.radialSegments = Math.floor(this.params.radialSegments);
    this.params.tubularSegments = Math.floor(this.params.tubularSegments);

    this.buildGeometry();
    super.updateBounding();
  }
}
