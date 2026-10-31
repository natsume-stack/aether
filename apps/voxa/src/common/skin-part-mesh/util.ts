export const BIG_ELEMENT_SIZE = 3 << 20;
export const SMALL_ELEMENT_SIZE = 3 << 15;

export function initQuad(buffer: Uint16Array | Uint32Array) {
  for (let i = 0, ptr = 0; ptr < buffer.length; i += 4) {
    buffer[ptr++] = i;
    buffer[ptr++] = i + 1;
    buffer[ptr++] = i + 2;
    buffer[ptr++] = i + 2;
    buffer[ptr++] = i + 1;
    buffer[ptr++] = i + 3;
  }
  return buffer;
}
