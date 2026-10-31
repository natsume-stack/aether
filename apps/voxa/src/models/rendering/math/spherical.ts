/**
 * Ref: https://en.wikipedia.org/wiki/Spherical_coordinate_system
 *
 * The polar angle (phi) is measured from the positive y-axis. The positive y-axis is up.
 * The azimuthal angle (theta) is measured from the positive z-axis.
 */

import { vec3 } from 'gl-matrix';
import { clamp } from 'ramda';

export class Spherical {
  constructor(
    public radius = 1,
    /**
     * polar angle
     */
    public phi = 0,
    /**
     * azimuthal angle
     */
    public theta = 0,
  ) {}

  public set(radius: number, phi: number, theta: number) {
    this.radius = radius;
    this.phi = phi;
    this.theta = theta;

    return this;
  }

  public copy(other: this) {
    this.radius = other.radius;
    this.phi = other.phi;
    this.theta = other.theta;

    return this;
  }

  // restrict phi to be between EPS and PI-EPS
  public makeSafe() {
    const EPS = 0.000001;
    this.phi = Math.max(EPS, Math.min(Math.PI - EPS, this.phi));

    return this;
  }

  public setFromVector3(v: vec3) {
    return this.setFromCartesianCoords(v[0], v[1], v[2]);
  }

  public setFromCartesianCoords(x: number, y: number, z: number) {
    this.radius = Math.sqrt(x * x + y * y + z * z);

    if (this.radius === 0) {
      this.theta = 0;
      this.phi = 0;
    } else {
      this.theta = Math.atan2(x, z);
      this.phi = Math.acos(clamp(-1, 1, y / this.radius));
    }

    return this;
  }

  public clone() {
    return new Spherical().copy(this);
  }

  public applyToVec3(out: vec3) {
    const sinPhiRadius = Math.sin(this.phi) * this.radius;

    vec3.set(
      out,
      sinPhiRadius * Math.sin(this.theta),
      Math.cos(this.phi) * this.radius,
      sinPhiRadius * Math.cos(this.theta),
    );
  }
}
