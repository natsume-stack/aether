import { mat4, vec3 } from 'gl-matrix';
import type {
  DrawCommand,
  NDArrayLike,
  Regl,
  VertexArrayObject,
} from '@box/regl';
import type { TypedArray } from 'ndarray';
import { Geometry } from '../geometry';
import { Material } from '../materials/material';
import { Ray } from '../math/ray';
import { Intersection, Raycaster } from '../raycast';
import { intersectTriangle } from '../utils/intersect';
import { DefaultDrawConfig, Object3D, Object3DType } from './object3d';

interface Props {
  attributes: { [key: string]: NDArrayLike };
  elements?: TypedArray;
  vao?: VertexArrayObject;
  uniforms: { [key: string]: any };
}

const TEMP_RAY = new Ray();
const TEMP_MAT = mat4.create();
export class Mesh<
  CustomGeometry extends Geometry = Geometry,
  CustomMaterial extends Material = Material,
> extends Object3D {
  public readonly type = Object3DType.Mesh;
  private drawCommand: DrawCommand;

  constructor(
    protected regl: Regl,
    /**
     * 暂时不支持动态更换Geometry，需要完成重新构建 DrawCommand 的流程后才能够支持
     */
    public readonly geometry: CustomGeometry,
    /**
     * 暂时不支持动态更换Material，需要完成重新构建 DrawCommand 的流程后才能够支持
     */
    public readonly material: CustomMaterial,
  ) {
    super();
    this.drawCommand = this.createCommand();
  }

  // TODO 补充基础的Shader
  private createCommand() {
    const config = this.createDrawConfig();

    if (this.material.isShader()) {
      this.parseShaderMaterialParams(config);
    }

    if (this.geometry.isMesh()) {
      return this.regl<any, any, Props>({
        ...config,
        vao: this.regl.prop('vao'),
        primitive: 'triangles',
      });
    }

    const attrs = Object.keys(this.geometry.attributes);
    for (let i = 0; i < attrs.length; ++i) {
      const name = attrs[i];
      config.attributes[name] = (_, props) => props.attributes[name];
    }

    return this.regl<any, any, Props>({
      ...config,
      elements: this.regl.prop('elements'),
      primitive: 'triangles',
    });
  }

  private parseShaderMaterialParams(config: DefaultDrawConfig) {
    if (!this.material.isShader()) {
      return;
    }

    if (this.material.vertexShader) {
      config.vert = this.material.vertexShader;
    }
    if (this.material.fragmentShader) {
      config.frag = this.material.fragmentShader;
    }

    if (this.material.uniforms) {
      const uniforms = Object.keys(this.material.uniforms);

      for (let i = 0; i < uniforms.length; ++i) {
        const name = uniforms[i];
        config.uniforms[name] = (_, props) => props.uniforms[name];
      }
    }

    if (this.material.attributes) {
      const attrs = Object.keys(this.material.attributes);
      for (let i = 0; i < attrs.length; ++i) {
        const name = attrs[i];
        config.attributes[name] = this.material.attributes[name];
      }
    }

    // undefined 'blend', 'depth', 'cull' will make regl throw error
    if (this.material.blend) {
      config.blend = this.material.blend;
    }

    if (this.material.depth) {
      config.depth = this.material.depth;
    }

    if (this.material.cull) {
      config.cull = this.material.cull;
    }
  }

  public draw() {
    const config: Props = {
      attributes: {},
      uniforms: {},
    };

    if (this.geometry.isMesh()) {
      config.vao = this.geometry.vao;
    } else {
      const attrs = Object.keys(this.geometry.attributes);
      for (let i = 0; i < attrs.length; ++i) {
        const name = attrs[i];
        const attr = this.geometry.getAttribute(name);
        if (attr) {
          config.attributes[name] = attr.getArray();
        }
      }

      const elementsAttribute = this.geometry.elements;
      if (elementsAttribute) {
        config.elements = elementsAttribute.getTypedArray();
      }
    }

    if (this.material.isShader()) {
      if (this.material.uniforms) {
        const uniforms = Object.keys(this.material.uniforms);
        for (let i = 0; i < uniforms.length; ++i) {
          const name = uniforms[i];
          config.uniforms[name] = this.material.uniforms[name];
        }
      }

      if (this.material.attributes) {
        const attrs = Object.keys(this.material.attributes);
        for (let i = 0; i < attrs.length; ++i) {
          const name = attrs[i];
          config.attributes[name] = this.material.attributes[name];
        }
      }
    }

    this.drawCommand(config);
  }

  public raycastTest(raycaster: Raycaster): Intersection | undefined {
    const elementsAttribute = this.geometry.elements;

    if (!elementsAttribute) {
      return;
    }
    const elements = elementsAttribute;

    TEMP_RAY.copy(raycaster.ray);

    mat4.invert(TEMP_MAT, this.matrixWorld);
    TEMP_RAY.applyMatrix4(TEMP_MAT);

    const { origin, direction } = TEMP_RAY;

    const positions = this.geometry.getAttribute('position');
    const normals = this.geometry.getAttribute('normal');

    if (!positions || !normals) {
      return;
    }

    for (let i = 0; i < elements.count; i++) {
      const e = elements.getVec3(i);
      const normal = normals.getVec3(e[0]);

      if (vec3.dot(direction, normal) >= 0) {
        continue;
      }

      const tri = [
        positions.getVec3(e[0]),
        positions.getVec3(e[1]),
        positions.getVec3(e[2]),
      ];

      const res1 = vec3.create();
      const voxPos = vec3.create();
      const t = intersectTriangle(res1, origin, direction, tri);

      if (t !== null) {
        for (let j = 0; j < res1.length; j++) {
          voxPos[j] = Math.floor(res1[j]) | 0;
        }

        return {
          absPos: res1,
          voxelPos: voxPos,
          normal,
          distance: t,
          object: this,
        };
      }
    }
  }

  public raycast(intersects: Intersection[], raycaster: Raycaster): void {
    const result = this.raycastTest(raycaster);
    if (result) {
      intersects.push(result);
    }
  }
}
