import type { quat } from 'gl-matrix';
import { vec3, mat3 } from 'gl-matrix';
import { radToDegree } from '../../../utils/math';

const R = mat3.create();

/**
 * Returns an euler angle representation of a quaternion
 * 旋转顺序XYZ
 */
export function getEuler(out: vec3, q: quat) {
  mat3.fromQuat(R, q);
  let theta: number; // 绕y轴
  let psi: number; // 绕x轴
  let phi: number; // 绕z轴

  const r11 = R[0];
  const r13 = R[6];
  const r21 = R[1];
  const r31 = R[2];
  const r32 = R[5];
  const r33 = R[8];

  if (r31 !== 1 && r31 !== -1) {
    theta = -Math.asin(r31);
    const cosTheta = Math.cos(theta);
    psi = Math.atan2(r32 / cosTheta, r33 / cosTheta);
    phi = Math.atan2(r21 / cosTheta, r11 / cosTheta);
  } else {
    // Gimbal lock，phi可以取任何角度
    phi = 0;
    if (r31 === -1) {
      theta = Math.PI / 2;
      psi = phi + Math.atan2(r11, r13);
    } else {
      theta = -Math.PI / 2;
      psi = -phi + Math.atan2(-r11, -r13);
    }
  }

  out[0] = radToDegree(psi);
  out[1] = radToDegree(theta);
  out[2] = radToDegree(phi);
}

/**
 * 计算两个单位向量之间的旋转四元数
 * 算法来自three.js
 * @param out 计算输出的旋转四元数
 * @param vFrom 起始向量
 * @param vTo 最终向量
 * @returns
 */
export function setFromUnitVectors(out: quat, vFrom: vec3, vTo: vec3): quat {
  // assumes direction vectors vFrom and vTo are normalized

  let r = vec3.dot(vFrom, vTo) + 1;

  if (r < Number.EPSILON) {
    // vFrom and vTo point in opposite directions
    r = 0;
    if (Math.abs(vFrom[0]) > Math.abs(vFrom[2])) {
      out[0] = -vFrom[1];
      out[1] = vFrom[0];
      out[2] = 0;
      out[3] = r;
    } else {
      out[0] = 0;
      out[1] = -vFrom[2];
      out[2] = vFrom[1];
      out[3] = r;
    }
  } else {
    // crossVectors( vFrom, vTo ); // inlined to avoid cyclic dependency on Vector3
    out[0] = vFrom[1] * vTo[2] - vFrom[2] * vTo[1];
    out[1] = vFrom[2] * vTo[0] - vFrom[0] * vTo[2];
    out[2] = vFrom[0] * vTo[1] - vFrom[1] * vTo[0];
    out[3] = r;
  }

  // normalize
  let l = Math.hypot(out[0], out[1], out[2], out[3]);
  if (l === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
  } else {
    l = 1 / l;
    out[0] = out[0] * l;
    out[1] = out[1] * l;
    out[2] = out[2] * l;
    out[3] = out[3] * l;
  }

  return out;
}
