import type { Regl } from '@box/regl';
import type { Camera } from '../../camera/base';
import { vec3 } from 'gl-matrix';

import { Object3D } from '../../objects/object3d';
import { Mesh } from '../../objects/mesh';
import { Axis } from '../../def';
import { CylinderGeometry } from '../../geometries/cylinder-geometry';

import {
  AxisToolMesh,
  TransformTool,
  TransformType,
  BLUE,
  GREEN,
  RED,
  BasicAxisTool,
} from './def';

export class Translate extends Object3D implements TransformTool {
  public interactiveObjects: Mesh[] = [];
  public readonly transformType: TransformType = TransformType.Translate;

  public axisTools: Arrow[] = [];

  constructor(regl: Regl) {
    super();
    const xArrow = new Arrow(regl, Axis.X, RED);
    const yArrow = new Arrow(regl, Axis.Y, GREEN);
    const zArrow = new Arrow(regl, Axis.Z, BLUE);
    this.interactiveObjects = [
      xArrow.interactive,
      yArrow.interactive,
      zArrow.interactive,
    ];
    this.axisTools = [xArrow, yArrow, zArrow];

    this.add(
      xArrow.body,
      yArrow.body,
      zArrow.body,
      xArrow.head,
      yArrow.head,
      zArrow.head,
      xArrow.sphere,
      yArrow.sphere,
      zArrow.sphere,
      xArrow.interactive,
      yArrow.interactive,
      zArrow.interactive,
    );
  }

  public rotateWithCamera(camera: Camera): void {}

  public getAxisToolByInteractiveObj(object: Object3D) {
    return this.axisTools.find((arrow) => arrow.interactive === object);
  }
}

export class Arrow extends BasicAxisTool {
  public head: AxisToolMesh;

  constructor(regl: Regl, axis: Axis, color: vec3) {
    super(regl, axis, color);

    const headGeometry = new CylinderGeometry({
      radiusTop: 0,
      radiusBottom: 0.8,
      height: this.headHeight,
      radialSegments: 4,
    });
    this.head = new AxisToolMesh(regl, headGeometry, this.material);

    this.initTransform(axis);
  }
}
