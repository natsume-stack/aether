import { Object3D, Object3DType } from './object3d';

export class Group extends Object3D {
  public readonly type: Object3DType = Object3DType.Group;
}
