import { vec2, vec3 } from 'gl-matrix';
import { Geometry, GeometryType } from '../geometry';
import { BufferAttribute } from './buffer-attribute';

export type CylinderOptions = {
  radiusTop: number;
  radiusBottom: number;
  height: number;
  radialSegments: number;
  heightSegments: number;
  openEnded: boolean;
  thetaStart: number;
  thetaLength: number;
};

export class CylinderGeometry extends Geometry {
  public type = GeometryType.Cylinder;

  private params: CylinderOptions = {
    radiusTop: 1,
    radiusBottom: 1,
    height: 1,
    radialSegments: 8,
    heightSegments: 1,
    openEnded: false,
    thetaStart: 0,
    thetaLength: Math.PI * 2,
  };

  constructor(options: Partial<CylinderOptions>) {
    super();

    Object.keys(options).forEach((item) => {
      this.params[item] = options[item];
    });
    this.params.radialSegments = Math.floor(this.params.radialSegments);
    this.params.heightSegments = Math.floor(this.params.heightSegments);

    this.buildGeometry();
  }

  private buildGeometry() {
    const { radiusTop, radiusBottom, openEnded } = this.params;

    const indices: number[] = [];
    const vertices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indexArray: number[][] = [];

    let index = 0;

    index = generateTorso({
      options: this.params,
      index,
      indices,
      vertices,
      normals,
      uvs,
      indexArray,
    }).index;

    if (openEnded === false) {
      if (radiusTop > 0) {
        index = generateCap({
          options: this.params,
          index,
          indices,
          vertices,
          normals,
          uvs,
          top: true,
        }).index;
      }
      if (radiusBottom > 0) {
        index = generateCap({
          options: this.params,
          index,
          indices,
          vertices,
          normals,
          uvs,
          top: false,
        }).index;
      }
    }

    this.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(vertices), 3),
    );
    this.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(normals), 3),
    );

    this.setElementsByArray(indices, 3);
  }

  public update(options: Partial<CylinderOptions>) {
    Object.keys(options).forEach((item) => {
      this.params[item] = options[item];
    });

    this.params.radialSegments = Math.floor(this.params.radialSegments);
    this.params.heightSegments = Math.floor(this.params.heightSegments);

    this.buildGeometry();
    super.updateBounding();
  }
}

type CapParams = {
  options: Required<CylinderOptions>;
  top: boolean;
  index: number;
  vertices: number[];
  normals: number[];
  indices: number[];
  uvs: number[];
};

type ReturnValue = { index: number };

function generateCap(params: CapParams): ReturnValue {
  const {
    options: cylinder,
    top,
    index: paramsIndex,
    vertices,
    indices,
    normals,
    uvs,
  } = params;

  let index = paramsIndex;

  const {
    radiusTop,
    radiusBottom,
    radialSegments,
    thetaStart,
    thetaLength,
    height,
  } = cylinder;

  let x;
  let centerIndexEnd;

  const uv = vec2.create();
  const vertex = vec3.create();

  const radius = top ? radiusTop : radiusBottom;
  const sign = top ? 1 : -1;

  const halfHeight = height / 2;
  const centerIndexStart = index;

  for (x = 1; x <= radialSegments; x++) {
    vertices.push(0, halfHeight * sign, 0);
    normals.push(0, sign, 0);
    uv[0] = 0.5;
    uv[1] = 0.5;

    uvs[index * 2] = uv[0];
    uvs[index * 2 + 1] = uv[1];

    index++;
  }

  centerIndexEnd = index;

  for (x = 0; x <= radialSegments; x++) {
    const u = x / radialSegments;
    const theta = u * thetaLength + thetaStart;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    vertex[0] = radius * sinTheta;
    vertex[1] = halfHeight * sign;
    vertex[2] = radius * cosTheta;
    vertices.push(vertex[0], vertex[1], vertex[2]);
    normals.push(0, sign, 0);

    uv[0] = cosTheta * 0.5 + 0.5;
    uv[1] = sinTheta * 0.5 * sign + 0.5;
    uvs[index * 2] = uv[0];
    uvs[index * 2 + 1] = uv[1];

    index++;
  }

  for (x = 0; x < radialSegments; x++) {
    const c = centerIndexStart + x;
    const i = centerIndexEnd + x;

    if (top === true) {
      indices.push(i, i + 1, c);
    } else {
      indices.push(i + 1, i, c);
    }
  }

  return { index };
}

type TorsoParams = Omit<CapParams, 'top'> & { indexArray: number[][] };

function generateTorso(params: TorsoParams): ReturnValue {
  const {
    options: cylinder,
    index: paramsIndex,
    vertices,
    indices,
    normals,
    uvs,
    indexArray,
  } = params;

  let index = paramsIndex;

  const {
    radiusTop,
    radiusBottom,
    radialSegments,
    thetaStart,
    thetaLength,
    height,
    heightSegments,
  } = cylinder;
  let x;
  let y;
  const normal = vec3.create();
  const vertex = vec3.create();
  const halfHeight = height / 2;

  // let groupCount = 0;
  // this will be used to calculate the normal
  const slope = (radiusBottom - radiusTop) / height;

  // generate vertices, normals and uvs
  for (y = 0; y <= heightSegments; y++) {
    const indexRow: number[] = [];
    const v = y / heightSegments;

    const radius = v * (radiusBottom - radiusTop) + radiusTop;

    for (x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * thetaLength + thetaStart;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      vertex[0] = radius * sinTheta;
      vertex[1] = -v * height + halfHeight;
      vertex[2] = radius * cosTheta;
      vertices.push(vertex[0], vertex[1], vertex[2]);
      normal[0] = sinTheta;
      normal[1] = slope;
      normal[2] = cosTheta;
      vec3.normalize(normal, normal);
      normals.push(normal[0], normal[1], normal[2]);

      uvs[index * 2] = u;
      uvs[index * 2 + 1] = 1 - v;
      indexRow.push(index);

      index++;
    }
    indexArray.push(indexRow);
  }

  // generate indices
  for (x = 0; x < radialSegments; x++) {
    for (y = 0; y < heightSegments; y++) {
      const i1 = indexArray[y][x];
      const i2 = indexArray[y + 1][x];
      const i3 = indexArray[y + 1][x + 1];
      const i4 = indexArray[y][x + 1];

      indices.push(i1, i2, i4, i2, i3, i4);
    }
  }

  return { index };
}
