import type { DrawCommand, Regl } from '@box/regl';
import { Line } from './line';
import { Object3DType } from './object3d';
import { Geometry } from '../geometry';
import { Material } from '../materials/material';

interface Props {
  position: number[];
  count: number;
}

export class LineLoop extends Line {
  public readonly type = Object3DType.LineLoop;

  private drawCommand: DrawCommand;

  constructor(protected regl: Regl, geometry: Geometry, material: Material) {
    super(geometry, material);
    this.drawCommand = this.regl({
      vert: this.material.isShader() ? this.material.vertexShader : undefined,
      frag: this.material.isShader() ? this.material.fragmentShader : undefined,
      attributes: {
        position: this.regl.prop<Props, 'position'>('position'),
      },
      depth: this.material.isShader() ? this.material.depth : undefined,
      count: this.regl.prop<Props, 'count'>('count'),
      primitive: 'line loop',
    });
  }

  public draw() {
    const position = this.geometry.getAttribute('position');
    if (position) {
      this.drawCommand({
        position: position.getArray(),
        count: position.count,
      });
    }
  }
}
