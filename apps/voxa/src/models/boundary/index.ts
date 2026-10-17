import { mat4, vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { BoxGeometry } from '../rendering/geometries/box-geometry';
import { ShaderMaterial } from '../rendering/materials/shader';
import { Mesh } from '../rendering/objects/mesh';
import { Intersection, Raycaster } from '../rendering/raycast';
import { intersectTriangle } from '../rendering/utils/intersect';
import fragmentShader from './frag.frag';
import vertexShader from './vert.vert';

export class BoundaryBox extends Mesh {
  public material: ShaderMaterial;

  public declare geometry: BoxGeometry;

  constructor(regl: Regl, private shape: vec3) {
    const geometry = new BoxGeometry({ size: shape });
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
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
        enable: true,
        mask: false,
        func: '<=',
      },
      cull: {
        enable: true,
        face: 'back',
      },
      uniforms: {
        color: [0.067, 0.067, 0.067],
        workspaceSize: vec3.clone(shape),
        model: mat4.create(),
        alpha: 0.5,
        inflate: false,
        showGrid: false,
      },
    });

    super(regl, geometry, material);

    this.shape = vec3.clone(shape);
    this.material = material;
  }

  public raycast(intersects: Intersection[], raycaster: Raycaster) {
    const elements = this.geometry.elements;

    const rayDir = raycaster.ray.direction;
    const rayOrigin = raycaster.ray.origin;
    const positions = this.geometry.getAttribute('position');
    const normals = this.geometry.getAttribute('normal');

    if (!positions || !normals) {
      return;
    }

    for (let i = 0; i < elements.count; i++) {
      const e = elements.getVec3(i);
      const normal = normals.getVec3(e[0]);
      if (vec3.dot(rayDir, normal) >= 0) {
        continue;
      }
      const tri = [
        positions.getVec3(e[0]),
        positions.getVec3(e[1]),
        positions.getVec3(e[2]),
      ];
      const res1 = vec3.create();
      const voxPos = vec3.create();
      const t = intersectTriangle(res1, rayOrigin, rayDir, tri, [
        [0, 0, 0],
        this.shape,
      ]);

      if (t !== null) {
        for (let j = 0; j < res1.length; j++) {
          voxPos[j] = Math.floor(res1[j]) | 0;
        }

        intersects.push({
          absPos: res1,
          voxelPos: voxPos,
          normal,
          distance: t,
          object: this,
        });
        return intersects;
      }
    }
  }

  /**
   * boundary网格显示的开关
   * @param show
   */
  public toggleGrid(show: boolean) {
    if (
      this.material.uniforms &&
      this.material.uniforms['showGrid'] !== undefined
    ) {
      this.material.uniforms['showGrid'] = show;
    }
  }

  public update(shape: vec3) {
    if (vec3.exactEquals(this.shape, shape)) {
      return;
    }

    const geometry = new BoxGeometry({ size: shape });

    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');

    if (!position || !normal) {
      return;
    }

    this.geometry.setAttribute('position', position);

    this.geometry.setAttribute('normal', normal);

    this.geometry.elements = geometry.elements;

    vec3.copy(this.shape, shape);

    if (this.material.uniforms && this.material.uniforms['workspaceSize']) {
      vec3.copy(this.material.uniforms['workspaceSize'], shape);
    }
  }
}
