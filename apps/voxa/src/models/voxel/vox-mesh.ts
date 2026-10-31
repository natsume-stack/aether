export function normalCode(nx, ny, nz) {
  if (nx < 128) {
    return 0;
  } else if (nx > 128) {
    return 1;
  } else if (ny < 128) {
    return 2;
  } else if (ny > 128) {
    return 3;
  } else if (nz < 128) {
    return 4;
  } else if (nz > 128) {
    return 5;
  }
  return 0;
}

