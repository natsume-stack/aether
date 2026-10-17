import type { vec3 } from 'gl-matrix';
import { log2, nextPow2 } from './bits';
import { dupe } from './dup';

// TODO 这个文件的注释大概率以后会用到，就不删了，git里也没有。

const POOL = {
  UINT8: dupe([32, 0]),
  UINT16: dupe([32, 0]),
  UINT32: dupe([32, 0]),
  INT8: dupe([32, 0]),
  INT16: dupe([32, 0]),
  INT32: dupe([32, 0]),
  FLOAT: dupe([32, 0]),
  DOUBLE: dupe([32, 0]),
  DATA: dupe([32, 0]),
};

// var POOL = global.__TYPEDARRAY_POOL;
const UINT8: { [key: string]: Uint8Array[] } = POOL.UINT8,
  UINT16: { [key: string]: Uint16Array[] } = POOL.UINT16,
  UINT32 = POOL.UINT32,
  INT8 = POOL.INT8,
  INT16 = POOL.INT16,
  INT32: { [key: string]: Int32Array[] } = POOL.INT32,
  FLOAT = POOL.FLOAT,
  DOUBLE = POOL.DOUBLE,
  DATA = POOL.DATA;

/**
 * 检测数组并释放回对象池，性能会差一点，能不用就不用
 * @param array
 */
// export function free(
//   array:
//     | Uint16Array
//     | Uint32Array
//     | Int8Array
//     | Int16Array
//     | Int32Array
//     | Float32Array
//     | Float64Array,
// ) {
//   if (array instanceof ArrayBuffer) {
//     const n = array.byteLength | 0,
//       log_n = log2(n);
//     DATA[log_n].push(array);
//   } else {
//     const n = array.length | 0,
//       log_n = log2(n);
//     if (array instanceof Uint8Array) {
//       UINT8[log_n].push(array);
//     } else if (array instanceof Uint16Array) {
//       UINT16[log_n].push(array);
//     } else if (array instanceof Uint32Array) {
//       UINT32[log_n].push(array);
//     } else if (array instanceof Int8Array) {
//       INT8[log_n].push(array);
//     } else if (array instanceof Int16Array) {
//       INT16[log_n].push(array);
//     } else if (array instanceof Int32Array) {
//       INT32[log_n].push(array);
//     } else if (array instanceof Float32Array) {
//       FLOAT[log_n].push(array);
//     } else if (array instanceof Float64Array) {
//       DOUBLE[log_n].push(array);
//     }
//   }
// }

export function freeUint8(array: Uint8Array) {
  UINT8[log2(array.length)].push(array);
}

export function freeUint16(array: Uint16Array) {
  UINT16[log2(array.length)].push(array);
}

// exports.freeUint32 = function freeUint32(array) {
//   UINT32[bits.log2(array.length)].push(array);
// };

// exports.freeInt8 = function freeInt8(array) {
//   INT8[bits.log2(array.length)].push(array);
// };

// exports.freeInt16 = function freeInt16(array) {
//   INT16[bits.log2(array.length)].push(array);
// };

export function freeInt32(array: Int32Array) {
  INT32[log2(array.length)].push(array);
}

// exports.freeFloat32 = exports.freeFloat = function freeFloat(array) {
//   FLOAT[bits.log2(array.length)].push(array);
// };

// exports.freeFloat64 = exports.freeDouble = function freeDouble(array) {
//   DOUBLE[bits.log2(array.length)].push(array);
// };

// exports.freeArrayBuffer = function freeArrayBuffer(array) {
//   DATA[bits.log2(array.length)].push(array);
// };

// exports.malloc = function malloc(n, dtype) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   if (dtype === undefined) {
//     var d = DATA[log_n];
//     if (d.length > 0) {
//       var r = d[d.length - 1];
//       d.pop();
//       return r;
//     }
//     return new ArrayBuffer(n);
//   } else {
//     switch (dtype) {
//       case 'uint8':
//         var u8 = UINT8[log_n];
//         if (u8.length > 0) {
//           return u8.pop();
//         }
//         return new Uint8Array(n);
//         break;

//       case 'uint16':
//         var u16 = UINT16[log_n];
//         if (u16.length > 0) {
//           return u16.pop();
//         }
//         return new Uint16Array(n);
//         break;

//       case 'uint32':
//         var u32 = UINT32[log_n];
//         if (u32.length > 0) {
//           return u32.pop();
//         }
//         return new Uint32Array(n);
//         break;

//       case 'int8':
//         var i8 = INT8[log_n];
//         if (i8.length > 0) {
//           return i8.pop();
//         }
//         return new Int8Array(n);
//         break;

//       case 'int16':
//         var i16 = INT16[log_n];
//         if (i16.length > 0) {
//           return i16.pop();
//         }
//         return new Int16Array(n);
//         break;

//       case 'int32':
//         var i32 = INT32[log_n];
//         if (i32.length > 0) {
//           return i32.pop();
//         }
//         return new Int32Array(n);
//         break;

//       case 'float':
//       case 'float32':
//         var f = FLOAT[log_n];
//         if (f.length > 0) {
//           return f.pop();
//         }
//         return new Float32Array(n);
//         break;

//       case 'double':
//       case 'float64':
//         var dd = DOUBLE[log_n];
//         if (dd.length > 0) {
//           return dd.pop();
//         }
//         return new Float64Array(n);
//         break;

//       default:
//         return null;
//     }
//   }
//   return null;
// };

export function mallocUint8(length: number) {
  length = nextPow2(length);
  const log_n = log2(length);
  const cache = UINT8[log_n];
  if (cache.length > 0) {
    return cache.pop()!;
  }
  return new Uint8Array(length);
}

export function mallocUint16(length: number) {
  length = nextPow2(length);
  const log_n = log2(length);
  const cache = UINT16[log_n];
  if (cache.length > 0) {
    return cache.pop()!;
  }
  return new Uint16Array(length);
}

// export function mallocUint32(length: number) {
//   length = nextPow2(length);
//   const log_n = log2(length);
//   const cache = UINT32[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new Uint32Array(length);
// }

// exports.mallocInt8 = function mallocInt8(n) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   var cache = INT8[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new Int8Array(n);
// };

// exports.mallocInt16 = function mallocInt16(n) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   var cache = INT16[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new Int16Array(n);
// };

/**
 * Memory Allocation for an Int32Array
 * @param n size
 * @returns empty array
 */
export function mallocInt32(n: number) {
  n = nextPow2(n);
  var log_n = log2(n);
  var cache = INT32[log_n];
  if (cache.length > 0) {
    return cache.pop()!;
  }
  return new Int32Array(n);
}

// exports.mallocFloat32 = exports.mallocFloat = function mallocFloat(n) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   var cache = FLOAT[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new Float32Array(n);
// };

// exports.mallocFloat64 = exports.mallocDouble = function mallocDouble(n) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   var cache = DOUBLE[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new Float64Array(n);
// };

// exports.mallocArrayBuffer = function mallocArrayBuffer(n) {
//   n = bits.nextPow2(n);
//   var log_n = bits.log2(n);
//   var cache = DATA[log_n];
//   if (cache.length > 0) {
//     return cache.pop();
//   }
//   return new ArrayBuffer(n);
// };

// exports.clearCache = function clearCache() {
//   for (var i = 0; i < 32; ++i) {
//     UINT8[i].length = 0;
//     UINT16[i].length = 0;
//     UINT32[i].length = 0;
//     INT8[i].length = 0;
//     INT16[i].length = 0;
//     INT32[i].length = 0;
//     FLOAT[i].length = 0;
//     DOUBLE[i].length = 0;
//     DATA[i].length = 0;
//   }
// };

/**
 * 根据传入数组判断需要建立的TypedArray类型
 * @param array
 * @returns
 */
export function arrayNeedsUint32(array: number[]) {
  // assumes larger values usually on last

  for (let i = array.length - 1; i >= 0; --i) {
    if (array[i] > 65535) return true;
  }

  return false;
}
