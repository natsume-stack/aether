import { vec3 } from 'gl-matrix';

export class Plane {
  public normal: vec3;
  public constant: number;

  constructor(normal: vec3 = vec3.fromValues(1, 0, 0), constant: number = 0) {
    // normal is assumed to be normalized
    this.normal = normal;
    this.constant = constant;
  }

  /**
   * 根据法向量和平面上一点生成平面
   * @param normal 向量
   * @param point 共面点
   * @returns
   */
  public setFromNormalAndCoplanarPoint(normal: vec3, point: vec3): Plane {
    vec3.copy(this.normal, normal);
    this.constant = -vec3.dot(point, this.normal);
    return this;
  }

  /**
   * 根据三个共面点生成平面
   * @param a
   * @param b
   * @param c
   * @returns
   */
  public setFromCoplanarPoints(a: vec3, b: vec3, c: vec3): Plane {
    const normal = vec3.create();
    vec3.sub(normal, c, b);

    const temp = vec3.create();
    vec3.subtract(temp, a, b);

    vec3.cross(normal, normal, temp);
    vec3.normalize(normal, normal);

    // Q: should an error be thrown if normal is zero (e.g. degenerate plane)?
    this.setFromNormalAndCoplanarPoint(normal, a);

    return this;
  }

  /**
   * 根据法线-距离表达式生成平面
   */
  public setComponents(x: number, y: number, z: number, w: number) {
    vec3.set(this.normal, x, y, z);
    this.constant = w;

    const inverseNormalLength = 1.0 / vec3.len(this.normal);
    vec3.scale(this.normal, this.normal, inverseNormalLength);
    this.constant *= inverseNormalLength;
  }

  public distanceToPoint(point: vec3): number {
    return vec3.dot(this.normal, point) + this.constant;
  }
}
