import type { ShaderMaterial } from './shader';

export const enum MaterialType {
  Basic,
  Shader,
}

export class Material {
  public readonly type: MaterialType = MaterialType.Basic;
  public transparent: boolean = false;
  public isShader(): this is ShaderMaterial {
    return this.type === MaterialType.Shader;
  }
}
