import { mat4, quat, vec3 } from 'gl-matrix';
import { Plane } from './plane';
import { Axis } from '../def';

const EYE = vec3.create();
const ALIGN = vec3.create();
const DIRECTION = vec3.create();
const ROTATION_MATRIX = mat4.create();
const POS = vec3.fromValues(0, 0, 0);
const QUAT = quat.create();

const UNIT_X = vec3.fromValues(1, 0, 0);
const UNIT_Y = vec3.fromValues(0, 1, 0);
const UNIT_Z = vec3.fromValues(0, 0, 1);

type UpdateParams = {
  axis: Axis;
  cameraPosition: vec3;
  targetWorldPos: vec3;
  targetWorldQuat: quat;
};

/**
 * 生成一个操控平面，用于处理基于某个点，沿轴延伸平面，在该平面上进行射线检测。
 * 参考Three.js TransformControlsPlane。
 * 该操控平面会尽可能根据视线，保持最大的平面宽度。目测效果。
 */
export class ControlsPlane extends Plane {
  constructor() {
    super();
  }

  public updateByAxis(params: UpdateParams) {
    const { axis, cameraPosition, targetWorldPos, targetWorldQuat } = params;

    vec3.sub(EYE, cameraPosition, targetWorldPos);
    vec3.normalize(EYE, EYE);

    const unit = vec3.create();

    switch (axis) {
      case Axis.X:
        vec3.transformQuat(unit, UNIT_X, targetWorldQuat);
        break;
      case Axis.Y:
        vec3.transformQuat(unit, UNIT_Y, targetWorldQuat);
        break;
      case Axis.Z:
        vec3.transformQuat(unit, UNIT_Z, targetWorldQuat);
        break;
    }

    vec3.normalize(unit, unit);
    vec3.cross(ALIGN, EYE, unit);
    vec3.cross(DIRECTION, unit, ALIGN);

    lookRotation(ROTATION_MATRIX, POS, DIRECTION, ALIGN);

    mat4.getRotation(QUAT, ROTATION_MATRIX);

    const normal = vec3.clone(UNIT_Z);

    vec3.transformQuat(normal, normal, QUAT);

    this.setFromNormalAndCoplanarPoint(normal, targetWorldPos);
  }
}

/**
 * 用于提取旋转的四元数
 * 从three.js中的Matrix4.lookAt抄过来的。与gl-matrix的lookAt不同。
 */
function lookRotation(mat: mat4, eye: vec3, target: vec3, up: vec3) {
  const _z = vec3.sub(vec3.create(), eye, target);

  const _x = vec3.create();

  const _y = vec3.create();

  if (vec3.length(_z) === 0) {
    // eye and target are in the same position

    _z[2] = 1;
  }

  vec3.normalize(_z, _z);

  vec3.cross(_x, up, _z);

  if (vec3.length(_x) === 0) {
    // up and z are parallel

    if (Math.abs(up[2]) === 1) {
      _z[0] += 0.0001;
    } else {
      _z[2] += 0.0001;
    }

    vec3.normalize(_z, _z);
    vec3.cross(_x, up, _z);
  }

  vec3.normalize(_x, _x);
  vec3.cross(_y, _z, _x);

  mat[0] = _x[0];
  mat[4] = _y[0];
  mat[8] = _z[0];
  mat[1] = _x[1];
  mat[5] = _y[1];
  mat[9] = _z[1];
  mat[2] = _x[2];
  mat[6] = _y[2];
  mat[10] = _z[2];
}
