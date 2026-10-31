import { vec3 } from 'gl-matrix';
import { clamp } from 'ramda';

/**
 * Möller-Trumbore algorithm
 * @param out : Vec3 like data
 * @param pt  : rayOrigin
 * @param dir : rayDir
 * @param tri : [vector3, vector3, vector3], 3 points represent for a triangle
 */
export function intersectTriangle(out, pt, dir, tri, dimension?: vec3[]) {
  const EPSILON = 0.000001;
  const edge1 = vec3.create();
  const edge2 = vec3.create();
  const tvec = vec3.create();
  const pvec = vec3.create();
  const qvec = vec3.create();

  vec3.subtract(<vec3>edge1, tri[1], tri[0]);
  vec3.subtract(edge2, tri[2], tri[0]);

  vec3.cross(pvec, dir, edge2);

  const det = vec3.dot(edge1, pvec);
  if (det < EPSILON) {
    return null;
  }
  vec3.subtract(tvec, pt, tri[0]);
  const u = vec3.dot(tvec, pvec);
  if (u < 0 || u > det) {
    return null;
  }
  vec3.cross(qvec, tvec, edge1);
  const v = vec3.dot(dir, qvec);
  if (v < 0 || u + v > det) {
    return null;
  }

  const t = vec3.dot(edge2, qvec) / det;

  if (dimension) {
    const [minX, minY, minZ] = dimension[0];
    const [maxX, maxY, maxZ] = dimension[1];

    out[0] = clamp(minX, maxX - 1, pt[0] + t * dir[0]);
    out[1] = clamp(minY, maxY - 1, pt[1] + t * dir[1]);
    out[2] = clamp(minZ, maxZ - 1, pt[2] + t * dir[2]);
  } else {
    out[0] = pt[0] + t * dir[0];
    out[1] = pt[1] + t * dir[1];
    out[2] = pt[2] + t * dir[2];
  }
  return t;
}
