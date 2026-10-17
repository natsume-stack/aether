import { mat4 } from 'gl-matrix';
import { Bone } from '../../../models/rendering/objects/bone';
import { IKConfiguration } from '../interfaces';

export interface IBoneOptions {
  name: string;
  ikConfiguration: IKConfiguration;
}

export class BoneNode extends Bone {
  public configuration: IKConfiguration;

  constructor(opt: IBoneOptions) {
    super();

    this.name = opt.name;
    this.configuration = opt.ikConfiguration;
  }

  public updateMatrixWorld(force = false): void {
    mat4.getScaling(this.scale, this.configuration[this.name]);
    mat4.getRotation(this.quaternion, this.configuration[this.name]);
    mat4.getTranslation(this.position, this.configuration[this.name]);

    super.updateMatrixWorld(force);
  }
}
