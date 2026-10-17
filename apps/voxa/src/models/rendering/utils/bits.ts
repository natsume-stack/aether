/**
 * Bit twiddling hacks for JavaScript.
 * https://github.com/mikolalysenko/bit-twiddle
 *
 * Ported from Stanford bit twiddling hack library:
 *    http://graphics.stanford.edu/~seander/bithacks.html
 */

//Computes log base 2 of v
export function log2(v: number) {
  let r: number, shift: number;
  r = Number(v > 0xffff) << 4;
  v >>>= r;
  shift = Number(v > 0xff) << 3;
  v >>>= shift;
  r |= shift;
  shift = Number(v > 0xf) << 2;
  v >>>= shift;
  r |= shift;
  shift = Number(v > 0x3) << 1;
  v >>>= shift;
  r |= shift;
  return r | (v >> 1);
}

//Rounds to next power of 2
export function nextPow2(v: number) {
  v += Number(v === 0);
  --v;
  v |= v >>> 1;
  v |= v >>> 2;
  v |= v >>> 4;
  v |= v >>> 8;
  v |= v >>> 16;
  return v + 1;
}
