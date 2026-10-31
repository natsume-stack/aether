import { vec3 } from 'gl-matrix';

const POS = vec3.create();

/**
 * 绘制直线。基于Bresenham的算法实现。
 * see:
 * https://zh.wikipedia.org/zh-hans/%E5%B8%83%E9%9B%B7%E6%A3%AE%E6%BC%A2%E5%A7%86%E7%9B%B4%E7%B7%9A%E6%BC%94%E7%AE%97%E6%B3%95
 */
export function drawLine(params: {
  start: vec3;
  end: vec3;
  operation: ({ pos }) => void;
}) {
  const { start, end, operation } = params;

  const [sx, sy, sz] = start;
  const [ex, ey, ez] = end;

  const dx = ex - sx;
  const dy = ey - sy;
  const dz = ez - sz;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const absDz = Math.abs(dz);

  const incX = Math.sign(dx);
  const incY = Math.sign(dy);
  const incZ = Math.sign(dz);

  vec3.copy(POS, start);

  // 另外两条轴的步长偏差
  let delta1 = 0;
  let delta2 = 0;

  // 另外两条轴的当前偏差
  let error1 = 0;
  let error2 = 0;

  if (absDx >= absDy && absDx >= absDz) {
    // 沿着x走
    delta1 = absDy;
    delta2 = absDz;
    error1 = absDx / 2;
    error2 = absDx / 2;

    for (let i = 0; i <= absDx; i++) {
      operation({ pos: POS });

      error1 -= delta1;
      error2 -= delta2;

      if (error1 < 0) {
        POS[1] += incY;
        error1 += absDx;
      }

      if (error2 < 0) {
        POS[2] += incZ;
        error2 += absDx;
      }

      POS[0] += incX;
    }
  } else if (absDy >= absDx && absDy >= absDz) {
    // 沿着y走
    delta1 = absDx;
    delta2 = absDz;
    error1 = absDy / 2;
    error2 = absDy / 2;

    for (let i = 0; i <= absDy; i++) {
      operation({ pos: POS });

      error1 -= delta1;
      error2 -= delta2;

      if (error1 < 0) {
        POS[0] += incX;
        error1 += absDy;
      }

      if (error2 < 0) {
        POS[2] += incZ;
        error2 += absDy;
      }

      POS[1] += incY;
    }
  } else {
    // 沿着z走
    delta1 = absDx;
    delta2 = absDy;
    error1 = absDz / 2;
    error2 = absDz / 2;

    for (let i = 0; i <= absDz; i++) {
      operation({ pos: POS });

      error1 -= delta1;
      error2 -= delta2;

      if (error1 < 0) {
        POS[0] += incX;
        error1 += absDz;
      }

      if (error2 < 0) {
        POS[1] += incY;
        error2 += absDz;
      }

      POS[2] += incZ;
    }
  }
}

/**
 * 绘制平行于方向轴的直线
 */
export function drawForceStraightLine(params: {
  start: vec3;
  end: vec3;
  operation: ({ pos }) => void;
}) {
  const { start, end, operation } = params;

  const [sx, sy, sz] = start;
  const [ex, ey, ez] = end;

  const dx = ex - sx;
  const dy = ey - sy;
  const dz = ez - sz;

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const absDz = Math.abs(dz);

  const incX = Math.sign(dx);
  const incY = Math.sign(dy);
  const incZ = Math.sign(dz);

  vec3.copy(POS, start);

  const plot = (idx: number, inc: number, dist: number) => {
    for (let i = 0; i <= dist; i++) {
      operation({ pos: POS });

      POS[idx] += inc;
    }
  };

  if (absDx >= absDy && absDx >= absDz) {
    // 沿着x走
    plot(0, incX, absDx);
  } else if (absDy >= absDx && absDy >= absDz) {
    // 沿着y走
    plot(1, incY, absDy);
  } else {
    // 沿着z走
    plot(2, incZ, absDz);
  }
}
