import { vec2 } from 'gl-matrix';

export type Point = vec2;

// TODO 理论上同时支持vec3和vec2，不过ts中处理类型判定会比较麻烦，先只支持vec2
/**
 * 曲线基类
 * An abstract base class for creating a Curve object that contains methods for interpolation.
 *
 */
export class Curve {
  public type = 'Curve';

  public arcLengthDivisions = 200;

  public cacheArcLengths?: number[];

  public needsUpdate = false;

  // Virtual base class method to overwrite and implement in subclasses
  //	- t [0 .. 1]
  public getPoint(t: number, optionalTarget?: Point): Point {
    throw new Error('THREE.Curve: .getPoint() not implemented.');
  }

  // Get point at relative position in curve according to arc length
  // - u [0 .. 1]
  public getPointAt(u: number, optionalTarget?: Point): Point {
    const t = this.getUtoTmapping(u);
    return this.getPoint(t, optionalTarget);
  }

  // Get sequence of points using getPoint( t )
  public getPoints(divisions = 5) {
    const points: Point[] = [];

    for (let d = 0; d <= divisions; d++) {
      points.push(this.getPoint(d / divisions));
    }

    return points;
  }

  // Get sequence of points using getPointAt( u )

  public getSpacedPoints(divisions = 5) {
    const points: Point[] = [];

    for (let d = 0; d <= divisions; d++) {
      points.push(this.getPointAt(d / divisions));
    }

    return points;
  }

  // Get total curve arc length

  public getLength() {
    const lengths = this.getLengths();
    return lengths[lengths.length - 1];
  }

  // Get list of cumulative segment lengths

  public getLengths(divisions = this.arcLengthDivisions) {
    if (
      this.cacheArcLengths &&
      this.cacheArcLengths.length === divisions + 1 &&
      !this.needsUpdate
    ) {
      return this.cacheArcLengths;
    }

    this.needsUpdate = false;

    const cache: number[] = [];
    let current,
      last = this.getPoint(0);
    let sum = 0;

    cache.push(0);

    for (let p = 1; p <= divisions; p++) {
      current = this.getPoint(p / divisions);
      // sum += current.distanceTo(last);
      sum += vec2.dist(current, last as any);
      cache.push(sum);
      last = current;
    }

    this.cacheArcLengths = cache;

    return cache; // { sums: cache, sum: sum }; Sum is in the last element.
  }

  public updateArcLengths() {
    this.needsUpdate = true;
    this.getLengths();
  }

  // Given u ( 0 .. 1 ), get a t to find p. This gives you points which are equidistant

  public getUtoTmapping(u: number, distance?: number) {
    const arcLengths = this.getLengths();

    let i = 0;
    const il = arcLengths.length;

    let targetArcLength; // The targeted u distance value to get

    if (distance) {
      targetArcLength = distance;
    } else {
      targetArcLength = u * arcLengths[il - 1];
    }

    // binary search for the index with largest value smaller than target u distance

    let low = 0,
      high = il - 1,
      comparison;

    while (low <= high) {
      i = Math.floor(low + (high - low) / 2); // less likely to overflow, though probably not issue here, JS doesn't really have integers, all numbers are floats

      comparison = arcLengths[i] - targetArcLength;

      if (comparison < 0) {
        low = i + 1;
      } else if (comparison > 0) {
        high = i - 1;
      } else {
        high = i;
        break;

        // DONE
      }
    }

    i = high;

    if (arcLengths[i] === targetArcLength) {
      return i / (il - 1);
    }

    // we could get finer grain at lengths, or use simple interpolation between two points

    const lengthBefore = arcLengths[i];
    const lengthAfter = arcLengths[i + 1];

    const segmentLength = lengthAfter - lengthBefore;

    // determine where we are between the 'before' and 'after' points

    const segmentFraction = (targetArcLength - lengthBefore) / segmentLength;

    // add that fractional amount to t

    const t = (i + segmentFraction) / (il - 1);

    return t;
  }

  // Returns a unit vector tangent at t
  // In case any sub curve does not implement its tangent derivation,
  // 2 points a small delta apart will be used to find its gradient
  // which seems to give a reasonable approximation

  public getTangent(t: number, optionalTarget?: Point) {
    const delta = 0.0001;
    let t1 = t - delta;
    let t2 = t + delta;

    // Capping in case of danger

    if (t1 < 0) t1 = 0;
    if (t2 > 1) t2 = 1;

    const pt1 = this.getPoint(t1);
    const pt2 = this.getPoint(t2);

    let tangent: Point;

    if (optionalTarget) {
      tangent = optionalTarget;
    } else {
      tangent = vec2.create();
    }

    if (isVector2(pt1) && isVector2(pt2) && isVector2(tangent)) {
      vec2.sub(tangent, pt2, pt1);

      return vec2.normalize(tangent, tangent);
    }
    throw new Error('Point not matching');
  }

  public getTangentAt(u: number, optionalTarget?: Point) {
    const t = this.getUtoTmapping(u);
    return this.getTangent(t, optionalTarget);
  }

  public clone() {
    return new (this.constructor as typeof Curve)().copy(this);
  }

  public copy(source) {
    this.arcLengthDivisions = source.arcLengthDivisions;

    return this;
  }

  public fromJSON(json) {
    this.arcLengthDivisions = json.arcLengthDivisions;

    return this;
  }
}

export function isVector2(p: Point): p is vec2 {
  return p.length === 2;
}

export function equalPoint(a: Point, b: Point) {
  if (isVector2(a) && isVector2(b)) {
    return vec2.equals(a, b);
  }

  return false;
}
