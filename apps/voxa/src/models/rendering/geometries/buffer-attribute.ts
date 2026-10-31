import { vec3 } from 'gl-matrix';
import ndarray, { NdArray, TypedArray } from 'ndarray';

export class BufferAttribute {
  public readonly array: NdArray<TypedArray>;
  public readonly count: number;
  constructor(arrayData: TypedArray, itemSize: number) {
    this.array = ndarray(arrayData, [arrayData.length / itemSize, itemSize]);
    this.count = this.array.shape[0];
  }

  public getArray = () => {
    return this.array;
  };

  /**
   * Get the data as TypedArray
   * @returns typed array
   */
  public getTypedArray() {
    return this.array.data;
  }

  public get(...dimensions: number[]) {
    return this.array.get(...dimensions);
  }

  public getItem(index: number) {
    const item: number[] = [];
    for (let i = 0; i < this.array.shape[0]; i++) {
      item.push(this.array.get(index, i));
    }
    return item;
  }

  public getVec3(index: number) {
    return vec3.fromValues(
      this.array.get(index, 0),
      this.array.get(index, 1),
      this.array.get(index, 2),
    );
  }
}

export class Uint32BufferAttribute extends BufferAttribute {
  constructor(array: Iterable<number>, itemSize: number) {
    super(new Uint32Array(array), itemSize);
  }
}

export class Uint16BufferAttribute extends BufferAttribute {
  constructor(array: Iterable<number>, itemSize: number) {
    super(new Uint16Array(array), itemSize);
  }
}
