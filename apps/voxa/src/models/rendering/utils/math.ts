import type { mat3, vec2, vec3 } from 'gl-matrix';
import { mat4 } from 'gl-matrix';

/**
 * 计算a / b的结果，如果b的某一项为0，则取defaultValue
 * @param out 存储结果的向量
 * @param a 向量a，被除数
 * @param b 向量b，除数
 * @param defaultValue @default 1
 */
export function safeDivVec<T extends vec3 | vec2>(
  out: T,
  a: T,
  b: T,
  defaultValue: number = 1,
): T {
  b.forEach((v, idx) => {
    if (v === 0) {
      out[idx] = defaultValue;

      return;
    }

    out[idx] = a[idx] / v;
  });

  return out;
}

const TEMP_MAT4 = mat4.create();

export function invertMat4ScaleRight(out: mat4, m: mat4, s: vec3) {
  mat4.fromScaling(TEMP_MAT4, s);
  mat4.invert(TEMP_MAT4, TEMP_MAT4);
  mat4.mul(out, m, TEMP_MAT4);
}

export function mat4SetFromMat3(out: mat4, mat3: mat3) {
  out[0] = mat3[0];
  out[1] = mat3[1];
  out[2] = mat3[2];
  out[3] = 0;
  out[4] = mat3[3];
  out[5] = mat3[4];
  out[6] = mat3[5];
  out[7] = 0;
  out[8] = mat3[6];
  out[9] = mat3[7];
  out[10] = mat3[8];
  out[11] = 0;
  out[12] = 0;
  out[13] = 0;
  out[14] = 0;
  out[15] = 1;
  return out;
}
