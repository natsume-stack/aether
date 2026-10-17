import { vec2 } from 'gl-matrix';
import { Curve } from './curve';

/**
 * A curve representing a 2d line segment.
 */
class LineCurve extends Curve {
  public isLineCurve = true;

  public type = 'LineCurve';

  public v1: vec2;
  public v2: vec2;

  constructor(v1 = vec2.create(), v2 = vec2.create()) {
    super();

    this.type = 'LineCurve';

    this.v1 = v1;
    this.v2 = v2;
  }

  public getPoint(t: number, optionalTarget = vec2.create()) {
    const point = optionalTarget;

    if (t === 1) {
      vec2.copy(point, this.v2);
    } else {
      vec2.sub(point, this.v2, this.v1);
      vec2.scale(point, point, t);
      vec2.add(point, point, this.v1);
    }

    return point;
  }

  // Line curve is linear, so we can overwrite default getPointAt
  public getPointAt(u: number, optionalTarget?: vec2) {
    return this.getPoint(u, optionalTarget);
  }

  public getTangent(t: number, optionalTarget = vec2.create()) {
    // return optionalTarget.subVectors(this.v2, this.v1).normalize();
    vec2.sub(optionalTarget, this.v2, this.v1);
    vec2.normalize(optionalTarget, optionalTarget);

    return optionalTarget;
  }

  public getTangentAt(u: number, optionalTarget?: vec2) {
    return this.getTangent(u, optionalTarget);
  }

  public copy(source) {
    super.copy(source);

    vec2.copy(this.v1, source.v1);
    vec2.copy(this.v2, source.v2);

    return this;
  }

  public fromJSON(json) {
    super.fromJSON(json);

    vec2.set(this.v1, json.v1[0], json.v1[1]);
    vec2.set(this.v2, json.v2[0], json.v2[1]);

    return this;
  }
}

export { LineCurve };
