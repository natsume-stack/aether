/**************************************************************
 *	Curved Path - a curve path is simply a array of connected
 *  curves, but retains the api of a curve
 **************************************************************/

import { vec2 } from 'gl-matrix';
import { Curve, equalPoint, isVector2, Point } from './curve';
import { LineCurve } from './line-curve';

class CurvePath extends Curve {
  public type = 'CurvePath';

  public curves: Curve[] = [];

  public cacheLengths: number[] | null = null;

  // Automatically closes the path
  public autoClose: boolean = false;

  constructor() {
    super();
  }

  public add(curve: Curve) {
    this.curves.push(curve);
  }

  public closePath() {
    // Add a line curve if start and end of lines are not connected
    const startPoint = this.curves[0].getPoint(0);
    const endPoint = this.curves[this.curves.length - 1].getPoint(1);

    if (!equalPoint(startPoint, endPoint)) {
      this.curves.push(new LineCurve(endPoint, startPoint));
    }

    return this;
  }

  // To get accurate point with reference to
  // entire path distance at time t,
  // following has to be done:

  // 1. Length of each sub path have to be known
  // 2. Locate and identify type of curve
  // 3. Get t for the curve
  // 4. Return curve.getPointAt(t')
  public getPoint(t: number, optionalTarget?: vec2) {
    const d = t * this.getLength();
    const curveLengths = this.getCurveLengths();
    let i = 0;

    // To think about boundaries points.

    while (i < curveLengths.length) {
      if (curveLengths[i] >= d) {
        const diff = curveLengths[i] - d;
        const curve = this.curves[i];

        const segmentLength = curve.getLength();
        const u = segmentLength === 0 ? 0 : 1 - diff / segmentLength;

        return curve.getPointAt(u, optionalTarget);
      }

      i++;
    }

    throw new Error('Error when getPoint');

    // loop where sum != 0, sum > d , sum+1 <d
  }

  // We cannot use the default THREE.Curve getPoint() with getLength() because in
  // THREE.Curve, getLength() depends on getPoint() but in THREE.CurvePath
  // getPoint() depends on getLength
  public getLength() {
    const lens = this.getCurveLengths();
    return lens[lens.length - 1];
  }

  // cacheLengths must be recalculated.
  public updateArcLengths() {
    this.needsUpdate = true;
    this.cacheLengths = null;
    this.getCurveLengths();
  }

  // Compute lengths and cache them
  // We cannot overwrite getLengths() because UtoT mapping uses it.

  public getCurveLengths() {
    // We use cache values if curves and cache array are same length

    if (this.cacheLengths && this.cacheLengths.length === this.curves.length) {
      return this.cacheLengths;
    }

    // Get length of sub-curve
    // Push sums into cached array

    const lengths: number[] = [];
    let sums = 0;

    for (let i = 0, l = this.curves.length; i < l; i++) {
      sums += this.curves[i].getLength();
      lengths.push(sums);
    }

    this.cacheLengths = lengths;

    return lengths;
  }

  public getSpacedPoints(divisions = 40) {
    const points: Point[] = [];

    for (let i = 0; i <= divisions; i++) {
      points.push(this.getPoint(i / divisions));
    }

    if (this.autoClose) {
      points.push(points[0]);
    }

    return points;
  }

  public getPoints(divisions = 12) {
    const points: Point[] = [];
    let last;

    for (let i = 0, curves = this.curves; i < curves.length; i++) {
      const curve = curves[i];

      // TODO 现在只有LineCurve跟EllipseCurve
      // const resolution = curve.isEllipseCurve
      //   ? divisions * 2
      //   : curve.isLineCurve || curve.isLineCurve3
      //   ? 1
      //   : curve.isSplineCurve
      //   ? divisions * curve.points.length
      //   : divisions;
      let resolution = divisions;

      if (curve['isEllipseCurve']) {
        resolution = divisions * 2;
      } else if (curve['isLineCurve']) {
        resolution = 1;
      }

      const pts = curve.getPoints(resolution);

      for (let j = 0; j < pts.length; j++) {
        const point = pts[j];

        if (last && last.equals(point)) continue; // ensures no consecutive points are duplicates

        points.push(point);
        last = point;
      }
    }

    const a = points[points.length - 1];
    const b = points[0];

    if (this.autoClose && points.length > 1 && !equalPoint(a, b)) {
      points.push(points[0]);
    }

    return points;
  }

  public copy(source) {
    super.copy(source);

    this.curves = [];

    for (let i = 0, l = source.curves.length; i < l; i++) {
      const curve = source.curves[i];

      this.curves.push(curve.clone());
    }

    this.autoClose = source.autoClose;

    return this;
  }
}

export { CurvePath };
