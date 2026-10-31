import { vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

export interface PlaneOptions {
  width: number;
  height: number;
  widthSegments: number;
  heightSegments: number;
}

export class PlaneGeometry extends Geometry {
  public type = GeometryType.Plane;

  private params: PlaneOptions = {
    width: 1,
    height: 1,
    widthSegments: 1,
    heightSegments: 1,
  };

  constructor(options?: Partial<PlaneOptions>) {
    super();

    if (options) {
      Object.keys(options).forEach((item) => {
        this.params[item] = options[item];
      });
    }

    this.buildGeometry();
  }

  private buildGeometry() {
    const widthHalf = this.params.width / 2;
    const heightHalf = this.params.height / 2;

    const gridX = Math.floor(this.params.widthSegments);
    const gridY = Math.floor(this.params.heightSegments);

    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;

    const segmentWidth = this.params.width / gridX;
    const segmentHeight = this.params.height / gridY;

    const indices: number[] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let iy = 0; iy < gridY1; iy++) {
      const y = iy * segmentHeight - heightHalf;

      for (let ix = 0; ix < gridX1; ix++) {
        const x = ix * segmentWidth - widthHalf;

        vertices.push(x, -y, 0);

        normals.push(0, 0, 1);

        uvs.push(ix / gridX);
        uvs.push(1 - iy / gridY);
      }
    }

    for (let iy = 0; iy < gridY; iy++) {
      for (let ix = 0; ix < gridX; ix++) {
        const a = ix + gridX1 * iy;
        const b = ix + gridX1 * (iy + 1);
        const c = ix + 1 + gridX1 * (iy + 1);
        const d = ix + 1 + gridX1 * iy;

        indices.push(a, b, d, b, c, d);
      }
    }
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

  public update(options: Partial<PlaneOptions>) {
    Object.keys(options).forEach((item) => {
      this.params[item] = options[item];
    });
    this.buildGeometry();
    super.updateBounding();
  }
}
