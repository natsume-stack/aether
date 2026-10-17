import { vec2 } from 'gl-matrix';
import { CurvePath } from './extra/curve-path';
import { LineCurve } from './extra/line-curve';
import { EllipseCurve } from './extra/ellipse-curve';
import { equalPoint } from './extra/curve';

type Point = vec2;

/**
 * A 2D path representation. The class provides methods for creating paths and contours of 2D shapes similar to the 2D Canvas API.
 */
class Path extends CurvePath {
  public type = 'Path';

  public currentPoint = vec2.create();

  constructor(points?: Point[]) {
    super();

    this.type = 'Path';

    if (points) {
      this.setFromPoints(points);
    }
  }

  public setFromPoints(points: Point[]) {
    this.moveTo(points[0][0], points[0][1]);

    for (let i = 1, l = points.length; i < l; i++) {
      this.lineTo(points[i][0], points[i][1]);
    }

    return this;
  }

  public moveTo(x: number, y: number) {
    // TODO consider referencing vectors instead of copying?
    this.currentPoint[0] = x;
    this.currentPoint[1] = y;

    return this;
  }

  public lineTo(x, y) {
    const curve = new LineCurve(
      vec2.clone(this.currentPoint),
      vec2.fromValues(x, y),
    );
    this.curves.push(curve);

    vec2.set(this.currentPoint, x, y);

    return this;
  }

  /**
   * 生成圆弧
   */
  public absarc(
    aX?: number,
    aY?: number,
    aRadius?: number,
    aStartAngle?: number,
    aEndAngle?: number,
    aClockwise?: boolean,
  ) {
    this.absellipse(
      aX,
      aY,
      aRadius,
      aRadius,
      aStartAngle,
      aEndAngle,
      aClockwise,
    );

    return this;
  }

  /**
   * 生成圆弧，可以是椭圆弧
   */
  public absellipse(
    aX?: number,
    aY?: number,
    xRadius?: number,
    yRadius?: number,
    aStartAngle?: number,
    aEndAngle?: number,
    aClockwise?: boolean,
    aRotation?: number,
  ) {
    const curve = new EllipseCurve(
      aX,
      aY,
      xRadius,
      yRadius,
      aStartAngle,
      aEndAngle,
      aClockwise,
      aRotation,
    );

    if (this.curves.length > 0) {
      // if a previous curve is present, attempt to join
      const firstPoint = curve.getPoint(0);

      if (!equalPoint(firstPoint, this.currentPoint)) {
        this.lineTo(firstPoint[0], firstPoint[1]);
      }
    }

    this.curves.push(curve);

    const lastPoint = curve.getPoint(1);
    vec2.copy(this.currentPoint, lastPoint);

    return this;
  }

  public copy(source) {
    super.copy(source);

    vec2.copy(this.currentPoint, source.currentPoint);

    return this;
  }
}

export { Path };
