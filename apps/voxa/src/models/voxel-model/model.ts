import { nextPow2 } from 'bit-twiddle';
import { vec3, vec4 } from 'gl-matrix';
import type { Buffer, DrawCommand, Regl } from '@box/regl';
import { allocEmptyVoxels } from '@box/utils/helper';
import { freeVoxels, getBoxBoundary, VoxelView } from '@box/utils/voxel';
import type { VEState } from '../voxel-app/state';
import { BoxBoundary } from '../editing/interfaces';
import { Axis } from '../rendering/def';
import { Voxels } from '../rendering/objects/voxels';
import { bakeMesh } from './bake';
import { translateVoxels } from './translate';
import fragmentShader from './ao-model/model-editor-frag.glsl';
import vertexShader from './ao-model/model-editor-vert.glsl';
import { loadRawMesh, updateRawMeshTexture } from './util';
import { VoxelDimensionType } from '../project/interfaces';
import { VoxelDimension } from '../project/defs';

export type VMOpts = {
  voxels: VoxelView | vec3;
  name?: string;
  wireFrameColor?: vec3;
  veState: VEState;
};

export type FitResult = {
  changed: boolean;
  start: vec3;
};

export type Props = {
  mesh: Buffer;
  inflate: boolean;
  wireFrameColor: vec3;
  showGrid: 1 | 0;
  count: number;
  faceLightness: number[];
};

export class Model extends Voxels {
  public forceBlockRender: boolean = false;

  public name: string = '';
  public faceLightness: number[];

  public regl: Regl;
  public wireFrameColor: vec3 = [0.6, 0.6, 0.6];
  /**
   * 肥仔参数，让模型的面在被渲染时，稍微膨胀一些。
   * 作用是当selection层和destination层重叠时，selection能盖住destination。
   */
  public inflate = false;

  private preserveRawMeshData: boolean = false;

  public voxelPoints: vec3[] | undefined = [];

  private _needBakeData = false;
  private _callbackList: Function[] = [];

  public _renderGrid: boolean = false;

  /**
   * 记录的是Mesh每个面的颜色id
   */
  public cIndexBuffer: Uint16Array;

  public lo: vec3;
  public hi: vec3;

  /**
   * 旋转盒，用于辅助旋转
   */
  public rotateBox: BoxBoundary = {
    start: [-1, -1, -1],
    end: [-1, -1, -1],
  };
  /**
   * 上一次旋转的轴
   */
  private lastRotateMain: Axis = Axis.X;
  public rawMeshBuffer = new Uint16Array(0);
  public meshBuffer: Buffer;
  public vertexCount = 0;

  public veState: VEState;

  private drawCmd: DrawCommand;

  constructor(regl: Regl, opts: VMOpts) {
    let voxels: VoxelView;

    if (opts.voxels instanceof VoxelView) {
      voxels = opts.voxels;
    } else {
      voxels = allocEmptyVoxels(opts.voxels[0], opts.voxels[1], opts.voxels[2]);
    }

    super(voxels);

    if (opts.name) {
      this.name = opts.name;
    }
    if (opts.wireFrameColor) {
      this.wireFrameColor = opts.wireFrameColor;
    }
    this.veState = opts.veState;
    this.meshBuffer = regl.buffer(4096);
    this.cIndexBuffer = new Uint16Array(0);

    this.voxelPoints = undefined;
    this.regl = regl;

    this.faceLightness = [0.6, 0.7, 0.75, 1, 0.5, 0.4, 0.1];
    this.lo = [Infinity, Infinity, Infinity];
    this.hi = [-Infinity, -Infinity, -Infinity];

    this.drawCmd = this.createDrawCommand();

    this.bakeData();

    regl.on('restore', () => {
      this.bakeData();
    });
  }

  /**
   * 获得模型三个维度上的半径
   * @param boundary
   */
  public static getRadius(boundary: BoxBoundary): vec3 {
    const { start, end } = boundary;
    return [
      Math.floor((end[0] - start[0] + 1) / 2),
      Math.floor((end[1] - start[1] + 1) / 2),
      Math.floor((end[2] - start[2] + 1) / 2),
    ];
  }

  /**
   * 获得模型三个维度上的直径
   * @param boundary
   * @returns
   */
  public static getDiameters(boundary: BoxBoundary): vec3 {
    const { start, end } = boundary;
    return [
      end[0] - start[0] + 1,
      end[1] - start[1] + 1,
      end[2] - start[2] + 1,
    ];
  }

  /**
   * 更新旋转盒
   * 根据model的最低点扩展生成
   * 平行于旋转轴的平面为正方形
   * @param options
   */
  public updateRotateBox(options: {
    main: Axis;
    cross1: Axis;
    cross2: Axis;
    boundary?: BoxBoundary;
  }) {
    const { main, cross1, cross2 } = options;

    const boundary = options.boundary ?? getBoxBoundary(this.voxels);
    const diameters = Model.getDiameters(boundary);

    const { start, end } = boundary;
    const { start: rotateStart, end: rotateEnd } = this.rotateBox;

    // 旋转轴发生变化
    const mainDiff = main !== this.lastRotateMain;

    // 旋转盒低点发生变化
    const startDiff =
      start[cross1] !== rotateStart[cross1] &&
      start[cross2] !== rotateStart[cross2];

    // 旋转盒高点发生变化
    const endDiff =
      end[cross1] !== rotateEnd[cross1] && end[cross2] !== rotateEnd[cross2];

    // 上述三种变化任一发生都需要更新旋转盒
    if (mainDiff || startDiff || endDiff) {
      diameters[cross1] = diameters[cross2] = Math.max(
        diameters[cross1],
        diameters[cross2],
      );

      vec3.copy(rotateStart, start);
      vec3.add(rotateEnd, rotateStart, diameters);
      vec3.add(rotateEnd, rotateEnd, [-1, -1, -1]);

      this.lastRotateMain = main;
    }
  }

  /**
   * 判断当前体素模型是否为空
   */
  public isEmpty() {
    return !this.voxels.data.find((data) => data !== 0);
  }

  /**
   * 更新当前rawMeshBuffer和MeshBuffer中的颜色信息
   * 如果传入textureId，则只更新对应textureId的颜色。
   * @param params 更细
   * @returns
   */
  public updateMeshColor(textureId?: number) {
    if (!this.cIndexBuffer) {
      return;
    }

    updateRawMeshTexture(this.rawMeshBuffer, this.cIndexBuffer, textureId);

    this.meshBuffer(this.rawMeshBuffer);
  }

  /**
   * 拼接两个Model的Mesh数据
   * @param otherMeshBuffer 要拼接的rawMeshBuffer
   * @param otherCIndexBuffer 要拼接的Mesh颜色索引
   * @param otherColorGroup 要拼接的Mesh的本地颜色组
   */
  public concatMeshBuffers(
    otherMeshBuffer: Uint16Array,
    otherCIndexBuffer: Uint16Array,
  ) {
    const tempMeshBuffer = new Uint16Array(
      this.rawMeshBuffer.length + otherMeshBuffer.length,
    );
    tempMeshBuffer.set(this.rawMeshBuffer, 0);
    tempMeshBuffer.set(otherMeshBuffer, this.rawMeshBuffer.length);

    this.rawMeshBuffer = tempMeshBuffer;

    if (this.meshBuffer['_buffer'].byteLength < tempMeshBuffer.byteLength) {
      this.meshBuffer({ length: nextPow2(tempMeshBuffer.byteLength) });

      this.meshBuffer(this.rawMeshBuffer);
    }

    this.vertexCount = this.rawMeshBuffer.length / 9;

    const tempCIndexBuffer = new Uint16Array(
      this.cIndexBuffer.length + otherCIndexBuffer.length,
    );

    tempCIndexBuffer.set(this.cIndexBuffer, 0);
    tempCIndexBuffer.set(
      new Uint16Array(otherCIndexBuffer),
      this.cIndexBuffer.length,
    );

    this.cIndexBuffer = tempCIndexBuffer;
  }

  public blockRender(flag: boolean) {
    this.forceBlockRender = flag;
  }

  /**
   * 标记需要烘焙网格，并记录烘焙后的回调。
   */
  public bakeData(callback?: Function) {
    this._needBakeData = true;
    if (callback) {
      this._callbackList.push(callback);
    }
  }

  /**
   * 更新网格
   */
  public updateMesh() {
    if (this._needBakeData) {
      const { isEmptyVoxels, mesh } = bakeMesh(this.voxels);

      if (isEmptyVoxels) {
        this.cleanMeshData();
      }

      if (mesh) {
        this.loadMesh(mesh);
      }

      this._needBakeData = false;
    }
  }

  private loadMesh(meshData: Uint16Array) {
    if (this.preserveRawMeshData && this._callbackList.length) {
      this._callbackList[0](meshData);
      return;
    }

    this.cIndexBuffer = new Uint16Array(meshData.length / 8);

    const { mesh, lo, hi, colorIndex } = loadRawMesh(meshData);

    this.rawMeshBuffer = mesh;
    this.cIndexBuffer = colorIndex;

    vec3.copy(this.lo, lo);
    vec3.copy(this.hi, hi);

    if (this.meshBuffer['_buffer'].byteLength < this.rawMeshBuffer.byteLength) {
      this.meshBuffer.destroy();
      this.meshBuffer = this.regl.buffer(nextPow2(this.rawMeshBuffer.length));
    }
    this.meshBuffer(this.rawMeshBuffer);

    this.vertexCount = this.rawMeshBuffer.length / 9;

    while (this._callbackList.length) {
      this._callbackList[0]();
      this._callbackList.shift();
    }
  }

  public showGrid(flag: boolean) {
    this._renderGrid = flag;
  }

  public translate(shift: vec3) {
    if (vec3.exactEquals(shift, [0, 0, 0])) {
      return;
    }

    translateVoxels(this.voxels, shift);

    this.bakeData();
  }

  /**
   * Set voxel data to the model and bake it.
   * @param voxels
   */
  public setVoxels(voxels: VoxelView) {
    freeVoxels(this.voxels);
    this.voxels = voxels;
    this.bakeData();
  }

  public reAlloc(size: vec3) {
    freeVoxels(this.voxels);
    this.voxels = allocEmptyVoxels(size[0], size[1], size[2]);
  }

  /**
   * 清空voxels
   * @returns 是否有voxel被清空
   */
  public clearVoxel() {
    let doClear = false;
    for (let i = 0; i < this.voxels.data.length; i++) {
      if (!doClear && this.voxels.data[i]) {
        doClear = true;
      }
      this.voxels.data[i] = 0;
    }
    doClear && this.cleanMeshData();
    return doClear;
  }

  public cleanMeshData() {
    this.rawMeshBuffer = new Uint16Array(0);
    this.cIndexBuffer = new Uint16Array(0);

    this.vertexCount = 0;

    /**
     * Reinitialize
     * see https://github.com/regl-project/regl/blob/gh-pages/API.md#buffer-update
     */
    this.meshBuffer({ length: 4096 });

    vec3.set(this.lo, Infinity, Infinity, Infinity);
    vec3.set(this.hi, -Infinity, -Infinity, -Infinity);
  }

  /**
   * 销毁体素模型
   * - 释放体素点数据占用的内存
   * - 清理Mesh缓存
   */
  public destroy() {
    freeVoxels(this.voxels);

    this.cleanMeshData();
  }

  /**
   * 根据模型大小调整空间大小，裁剪没有体素的空间
   * @returns
   */
  public trim(): FitResult {
    const lo: vec3 = [Infinity, Infinity, Infinity];
    const hi: vec3 = [-Infinity, -Infinity, -Infinity];
    /**
     * 记录所有体素点的4维向量
     */
    const voxelPoints: vec4[] = [];
    for (let i = 0; i < this.voxels.shape[0]; i++) {
      for (let j = 0; j < this.voxels.shape[1]; j++) {
        for (let k = 0; k < this.voxels.shape[2]; k++) {
          const c = this.voxels.getVoxel(i, j, k);
          if (c > 0) {
            lo[0] = Math.min(i, lo[0]);
            lo[1] = Math.min(j, lo[1]);
            lo[2] = Math.min(k, lo[2]);

            hi[0] = Math.max(i, hi[0]);
            hi[1] = Math.max(j, hi[1]);
            hi[2] = Math.max(k, hi[2]);
            voxelPoints.push([i, j, k, c]);
          }
        }
      }
    }
    const _x = hi[0] - lo[0] + 1;
    const _y = hi[1] - lo[1] + 1;
    const _z = hi[2] - lo[2] + 1;

    // 如果空间没有发生变化或者维度数值出现错误(小于0)则提前返回
    if (
      vec3.equals([_x, _y, _z], this.voxels.shape) ||
      _x < 0 ||
      _y < 0 ||
      _z < 0
    ) {
      return { changed: false, start: lo };
    }

    this.reAlloc([_x, _y, _z]);

    for (let i = 0; i < voxelPoints.length; i++) {
      this.voxels.setVoxel(
        voxelPoints[i][0] - lo[0],
        voxelPoints[i][1] - lo[1],
        voxelPoints[i][2] - lo[2],
        voxelPoints[i][3],
      );
    }

    this.bakeData();

    return { changed: true, start: lo };
  }

  /**
   * 体素内空间投射到对应0轴向面（轴正方向往负方向投射），形成2D内容
   * 被压缩的轴向厚度为1
   * @param dimension
   * @returns
   */
  public squashToTwoDimension(dimension: VoxelDimensionType): boolean {
    if (dimension === VoxelDimension.XYZ) {
      return false;
    }

    const newShape = this.voxels.shape.slice();
    if (newShape[dimension] === 1) {
      return false;
    }

    newShape[dimension] = 1;
    const newVoxels = allocEmptyVoxels(newShape[0], newShape[1], newShape[2]);

    const axisOrder = [
      [1, 2],
      [0, 2],
      [0, 1],
    ];
    const [firstAxis, secondAxis] = axisOrder[dimension];

    const firstShape = this.voxels.shape[firstAxis];
    const secondShape = this.voxels.shape[secondAxis];
    const squashShape = this.voxels.shape[dimension];

    const xyz: number[] = [];
    for (let i = 0; i < firstShape; i++) {
      for (let j = 0; j < secondShape; j++) {
        for (let k = squashShape - 1; k >= 0; k--) {
          xyz[firstAxis] = i;
          xyz[secondAxis] = j;
          xyz[dimension] = k;
          const [x, y, z] = xyz;
          const b = this.voxels.getVoxel(x, y, z);
          if (b) {
            xyz[dimension] = 0;
            const [x, y, z] = xyz;
            newVoxels.setVoxel(x, y, z, b);
            break;
          }
        }
      }
    }

    freeVoxels(this.voxels);
    this.voxels = newVoxels;
    this.bakeData();

    return true;
  }

  public draw() {
    this.updateMesh();

    if (this.forceBlockRender || !this.rawMeshBuffer) {
      return;
    }

    this.drawCmd({
      mesh: this.meshBuffer,
      faceLightness: this.faceLightness,
      wireFrameColor: this.wireFrameColor,
      inflate: this.inflate,
      showGrid: Number(this._renderGrid),
      count: this.vertexCount,
    });
  }

  private createDrawCommand() {
    const { prop } = this.regl;

    const config = this.createDrawConfig();

    const uniforms = config.uniforms;

    Object.assign(uniforms, {
      'Lightness[0]': prop('faceLightness[0]'),
      'Lightness[1]': prop('faceLightness[1]'),
      'Lightness[2]': prop('faceLightness[2]'),
      'Lightness[3]': prop('faceLightness[3]'),
      'Lightness[4]': prop('faceLightness[4]'),
      'Lightness[5]': prop('faceLightness[5]'),
      'Lightness[6]': prop('faceLightness[6]'),
    });

    Object.assign(uniforms, {
      inflate: prop<Props, 'inflate'>('inflate'),
      wireFrameColor: prop<Props, 'wireFrameColor'>('wireFrameColor'),
      showGrid: prop<Props, 'showGrid'>('showGrid'),
    });

    const buffer = prop<Props, 'mesh'>('mesh');

    return this.regl({
      ...config,
      frag: fragmentShader,
      vert: vertexShader,
      cull: {
        enable: true,
        face: 'back',
      },
      attributes: {
        s0: {
          buffer,
          offset: 0,
          stride: 18,
          size: 4,
          divisor: 0,
          normalized: false,
        },
        s1: {
          buffer,
          offset: 8,
          stride: 18,
          size: 4,
          divisor: 0,
          normalized: false,
        },
      },
      primitive: 'triangles',
      count: prop<Props, 'count'>('count'),
    });
  }
}
