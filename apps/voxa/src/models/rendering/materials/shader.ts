import type { DrawConfig } from '@box/regl';
import { Material, MaterialType } from './material';

export interface Parameters {
  uniforms: Object;
  vertexShader: string;
  fragmentShader: string;
  blend: DrawConfig['blend'];
  depth: DrawConfig['depth'];
  cull: DrawConfig['cull'];
  attributes: DrawConfig['attributes'];
  transparent: boolean;
}

export class ShaderMaterial extends Material {
  public readonly type = MaterialType.Shader;
  public uniforms?: DrawConfig['uniforms'];
  public vertexShader?: string;
  public fragmentShader?: string;
  public blend?: DrawConfig['blend'];
  public depth?: DrawConfig['depth'];
  public cull?: DrawConfig['cull'];
  public attributes?: DrawConfig['attributes'];

  constructor(parameters?: Partial<Parameters>) {
    super();

    const {
      uniforms,
      vertexShader,
      fragmentShader,
      blend,
      depth,
      cull,
      attributes,
      transparent,
    } = parameters || {};

    this.uniforms = uniforms;
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    this.blend = blend;
    this.depth = depth;
    this.cull = cull;
    this.attributes = attributes;
    this.transparent = !!transparent;
  }
}
