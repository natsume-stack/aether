import { vec3 } from 'gl-matrix';
import type { DrawCommand, Regl } from '@box/regl/regl';
import { Pivot } from '../../rendering/controls/transform/pivot';
import {
  ShaderMaterial,
  Parameters as ShaderMaterialParams,
} from '../../rendering/materials/shader';
import {
  basicFragmentShader,
  basicVertexShader,
  lineDashedVertexShader,
  lineDashedFragmentShader,
} from '../../rendering/shaders';
import { Path } from '../../rendering/path';
import { Geometry } from '../../rendering/geometry';
import { BufferAttribute } from '../../rendering/geometries/buffer-attribute';
import { Line } from '../../rendering/objects/line';
import type { Material } from '../../rendering/materials/material';

/**
 * 虚线圆环的计算半径以及缩放，参照设计稿调参得到
 * - 用较大的半径得到较合理的顶点
 * - 用缩放使圆环的尺寸和“部件锚点”的外圈保持差不多一致大小
 */
const RING_RADIUS = 9;
const RING_SCALE = 0.08;

export class ModelPivotTool extends Pivot {
  constructor(regl: Regl) {
    const ring = createDashedRing(regl);

    super(regl, ring);
  }

  protected getMaterials(): {
    ringMaterial: ShaderMaterial;
    sphereMaterial: ShaderMaterial;
  } {
    const material = getMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        color: [1, 0.29, 0.29],
        alpha: 1,
      },
    });

    return { ringMaterial: material, sphereMaterial: material };
  }
}

function getMaterial(params: Partial<ShaderMaterialParams>): ShaderMaterial {
  return new ShaderMaterial({
    blend: {
      enable: true,
      func: {
        srcRGB: 'src alpha',
        srcAlpha: 1,
        dstRGB: 'one minus src alpha',
        dstAlpha: 1,
      },
      equation: {
        rgb: 'add',
        alpha: 'add',
      },
      color: [1, 1, 1, 1],
    },
    depth: {
      enable: false,
      mask: false,
      func: '<=',
    },
    transparent: true,
    ...params,
  });
}

/**
 * 创建虚线圆环
 */
function createDashedRing(regl: Regl) {
  const points = new Path()
    .absarc(0, 0, RING_RADIUS, 0, Math.PI * 2)
    .getSpacedPoints(50);

  const geometry = new Geometry();

  const positions: number[] = [];

  points.forEach(([x, y]) => {
    positions.push(x, y);
  });

  geometry.setAttribute(
    'position',
    // 2D的坐标itemSize是2
    new BufferAttribute(new Float32Array(positions), 2),
  );

  const material = getMaterial({
    vertexShader: lineDashedVertexShader,
    fragmentShader: lineDashedFragmentShader,
    uniforms: {
      color: [1, 1, 1],
      alpha: 1,
    },
  });

  const line = new DashedLine(regl, geometry, material);
  line.computeLineDistances();

  vec3.scale(line.scale, line.scale, RING_SCALE);
  return line;
}

interface Props {
  position: number[];
  count: number;
  lineDistance: number[];
}

class DashedLine extends Line {
  private drawCommand: DrawCommand;

  constructor(
    protected regl: Regl,
    geometry: Geometry,
    material: ShaderMaterial,
  ) {
    super(geometry, material);

    const config = this.createDrawConfig();

    this.drawCommand = this.regl({
      uniforms: {
        ...config.uniforms,
        ...material.uniforms,
      },
      vert: material.vertexShader,
      frag: material.fragmentShader,
      attributes: {
        position: this.regl.prop<Props, 'position'>('position'),
        lineDistance: this.regl.prop<Props, 'lineDistance'>('lineDistance'),
      },
      depth: material.depth,
      count: this.regl.prop<Props, 'count'>('count'),
      primitive: 'line strip',
    });
  }

  public draw() {
    const position = this.geometry.getAttribute('position');
    const lineDistance = this.geometry.getAttribute('lineDistance');

    if (position && lineDistance) {
      this.drawCommand({
        position: position.getArray(),
        lineDistance: lineDistance.getArray(),
        count: position.count,
      });
    }
  }
}
