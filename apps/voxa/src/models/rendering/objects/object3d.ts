import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { nanoid } from 'nanoid';
import { getEuler } from '../math/quat';
import type { DrawConfig } from '@box/regl';
import type { Camera } from '../camera/base';
import { OrthographicCamera } from '../camera/orthographic';
import type { PerspectiveCamera } from '../camera/perspective';
import type { Geometry } from '../geometry';
import type { Material } from '../materials/material';
import type { Intersection, Raycaster } from '../raycast';
import type { Line } from './line';
import type { LineLoop } from './line-loop';
import type { Mesh } from './mesh';
import type { Scene } from './scene';
import type { Voxels } from './voxels';
import type { Group } from './group';
import type { Bone } from './bone';
import { mat4SetFromMat3 } from '../utils/math';

const TEMP_POS = vec3.create();
const TEMP_QUAT = quat.create();
const TEMP_VEC3 = vec3.create();
const TEMP_MAT4 = mat4.create();
const TEMP_MAT3 = mat3.create();

export const enum Object3DType {
  Basic,
  Mesh,
  Line,
  LineLoop,
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  Voxels,
  Group,
  Bone,
}

type DefaultUniforms = {
  matrixWorld: () => mat4;
  modelViewMatrix: () => mat4;
};

export interface DefaultDrawConfig extends DrawConfig<DefaultUniforms> {
  attributes: {};
  uniforms: DefaultUniforms;
}

export class Object3D {
  private static totalID = 0;
  public static DefaultUp = vec3.fromValues(0, 1, 0);
  public readonly type: Object3DType = Object3DType.Basic;
  public isMesh(): this is Mesh {
    return this.type === Object3DType.Mesh;
  }

  public isLine(): this is Line {
    return this.type === Object3DType.Line;
  }

  public isLineLoop(): this is LineLoop {
    return this.type === Object3DType.LineLoop;
  }

  public isScene(): this is Scene {
    return this.type === Object3DType.Scene;
  }

  public isCamera(): this is Camera {
    return (
      this.type === Object3DType.PerspectiveCamera ||
      this.type === Object3DType.OrthographicCamera
    );
  }

  public isPerspectiveCamera(): this is PerspectiveCamera {
    return this.type === Object3DType.PerspectiveCamera;
  }

  public isOrthographicCamera(): this is OrthographicCamera {
    return this.type === Object3DType.OrthographicCamera;
  }

  public isVoxels(): this is Voxels {
    return this.type === Object3DType.Voxels;
  }

  public isGroup(): this is Group {
    return this.type === Object3DType.Group;
  }

  public isBone(): this is Bone {
    return this.type === Object3DType.Bone;
  }

  private readonly id = Object3D.totalID++;

  public readonly uuid: string;
  constructor(uuid?: string) {
    this.uuid = uuid || nanoid();
  }

  public name = '';
  public parent?: Object3D;
  public children: Object3D[] = [];

  public up = vec3.clone(Object3D.DefaultUp);
  public visible = true;

  public position = vec3.create();
  public quaternion = quat.create();
  public scale = vec3.fromValues(1, 1, 1);
  public pivot = vec3.create();
  /**
   * 世界轴(父级)缩放矩阵数据
   * 在合成matrix的时候左乘RTS矩阵即可
   */
  public parentScaleMat3 = mat3.create();

  /**
   * 欧拉角数据，仅显示使用，并非靠谱数据
   * 需要外部自行设置
   */
  public rotateAngles = vec3.create();
  /**
   * 世界坐标的欧拉角数据
   * 跟随updateMatrixWorld方法，根据四元数quaternionWorld转换
   */
  public worldRotateAngles = vec3.create();
  /**
   * 世界坐标四元数旋转数据
   * 跟随updateMatrixWorld方法更新
   */
  public quaternionWorld = quat.create();

  /**
   * 结合position，quaternion，scale，pivot，以及parentScaleMat3合成的偏移矩阵
   * 为此obj真实所见的偏移矩阵
   */
  public matrix = mat4.create();
  public matrixWorld = mat4.create();
  /**
   * 用于将本地坐标转换为摄像机坐标
   */
  public modelViewMatrix = mat4.create();

  protected matrixAutoUpdate = true;
  public matrixWorldNeedsUpdate = false;

  protected frustumCulled = true;
  protected renderOrder = 0;
  public geometry?: Geometry;
  public material?: Material;

  /**
   * Abstract (empty) method to get intersections between a casted ray and this object. Subclasses such as Mesh, Line, and Points implement this method in order to use raycasting.
   * @param out modifed intersects array
   * @param raycaster
   */
  public raycast(out: Intersection[], raycaster: Raycaster) {}

  public add(...objects: Object3D[]) {
    if (objects.length > 1) {
      for (let i = 0; i < objects.length; i++) {
        this.add(objects[i]);
      }

      return this;
    }

    const object = objects[0];

    if (object === this) {
      console.error(
        "THREE.Object3D.add: object can't be added as a child of itself.",
        object,
      );
      return this;
    }

    if (object.parent !== undefined) {
      object.parent.remove(object);
    }

    object.parent = this;
    this.children.push(object);

    return this;
  }

  public remove(object: Object3D) {
    if (arguments.length > 1) {
      for (let i = 0; i < arguments.length; i++) {
        this.remove(arguments[i]);
      }

      return this;
    }

    const index = this.children.indexOf(object);

    if (index !== -1) {
      object.parent = undefined;
      this.children.splice(index, 1);
    }

    return this;
  }

  /**
   * 清理自身的所有子节点
   */
  public clear() {
    this.children.forEach((child) => {
      child.parent = undefined;
    });

    this.children.length = 0;

    return this;
  }

  /**
   * 更新本地坐标系下的变换矩阵
   */
  public updateMatrix() {
    this.getRTSMatrix(this.matrix);

    mat4SetFromMat3(TEMP_MAT4, this.parentScaleMat3);
    mat4.mul(this.matrix, TEMP_MAT4, this.matrix);

    this.matrixWorldNeedsUpdate = true;
  }

  public getRTSMatrix(out: mat4) {
    this.getTransformedPivot(TEMP_POS);
    vec3.add(TEMP_POS, TEMP_POS, this.position);
    return mat4.fromRotationTranslationScale(
      out,
      this.quaternion,
      TEMP_POS,
      this.scale,
    );
  }

  /**
   * 根据情况更新世界坐标系下自身的变换矩阵
   * @param force
   */
  public updateMatrixWorld(force = false) {
    if (this.matrixAutoUpdate) this.updateMatrix();

    if (this.matrixWorldNeedsUpdate || force) {
      if (this.parent === undefined) {
        mat4.copy(this.matrixWorld, this.matrix);
        quat.copy(this.quaternionWorld, this.quaternion);
      } else {
        mat4.mul(this.matrixWorld, this.parent.matrixWorld, this.matrix);
        quat.mul(
          this.quaternionWorld,
          this.parent.quaternionWorld,
          this.quaternion,
        );
      }

      getEuler(this.worldRotateAngles, this.quaternionWorld);

      this.matrixWorldNeedsUpdate = false;

      force = true;
    }

    // update children

    const children = this.children;

    for (let i = 0, l = children.length; i < l; i++) {
      children[i].updateMatrixWorld(force);
    }
  }

  /**
   * 强制更新世界坐标系下与相关对象的变换矩阵
   * @param updateParents
   * @param updateChildren
   */
  public updateWorldMatrix(updateParents: boolean, updateChildren: boolean) {
    const parent = this.parent;

    if (updateParents === true && parent !== undefined) {
      parent.updateWorldMatrix(true, false);
    }

    if (this.matrixAutoUpdate) this.updateMatrix();

    if (this.parent === undefined) {
      mat4.copy(this.matrixWorld, this.matrix);
      quat.copy(this.quaternionWorld, this.quaternion);
    } else {
      mat4.mul(this.matrixWorld, this.parent.matrixWorld, this.matrix);
      quat.mul(
        this.quaternionWorld,
        this.parent.quaternionWorld,
        this.quaternion,
      );
    }

    // update children

    if (updateChildren === true) {
      const children = this.children;

      for (let i = 0, l = children.length; i < l; i++) {
        children[i].updateWorldMatrix(false, true);
      }
    }
  }

  public lookAt(target: vec3) {
    const parent = this.parent;

    this.updateWorldMatrix(true, false);

    const _position = vec3.create();
    mat4.getTranslation(_position, this.matrixWorld);

    const _m1 = mat4.create();
    if (this.isCamera()) {
      /**
       * 当eye和target相等时
       * 直接使用targetTo会算出quaternion为NaN，从而引发各种奇怪的bug（gl-matrix没有做这个容错）
       * 因此当eye和target相等时，quaternion为0,0,0,1，直接将矩阵位移即可
       * 不相等时再使用targetTo计算
       */
      if (vec3.equals(_position, target)) {
        mat4.translate(_m1, _m1, _position);
      } else {
        mat4.targetTo(_m1, _position, target, this.up); // 这里要拿到的是相机的坐标变换矩阵而不是 LookAt矩阵
      }
    } else {
      mat4.lookAt(_m1, target, _position, this.up);
    }

    mat4.getRotation(this.quaternion, _m1);

    if (parent) {
      const _q1 = quat.create();
      quat.copy(_q1, parent.quaternionWorld);
      quat.invert(_q1, _q1);
      quat.multiply(this.quaternion, this.quaternion, _q1);
    }
  }

  public copy(source: Object3D, recursive = true) {
    this.name = source.name;

    vec3.copy(this.up, source.up);
    vec3.copy(this.position, source.position);
    quat.copy(this.quaternion, source.quaternion);
    vec3.copy(this.scale, source.scale);
    vec3.copy(this.pivot, source.pivot);
    mat3.copy(this.parentScaleMat3, source.parentScaleMat3);
    mat4.copy(this.matrix, source.matrix);
    mat4.copy(this.matrixWorld, source.matrixWorld);
    quat.copy(this.quaternionWorld, source.quaternionWorld);
    vec3.copy(this.rotateAngles, source.rotateAngles);
    vec3.copy(this.worldRotateAngles, source.worldRotateAngles);

    this.matrixAutoUpdate = source.matrixAutoUpdate;
    this.matrixWorldNeedsUpdate = source.matrixWorldNeedsUpdate;

    this.visible = source.visible;

    this.frustumCulled = source.frustumCulled;
    this.renderOrder = source.renderOrder;

    if (recursive === true) {
      for (let i = 0; i < source.children.length; i++) {
        const child = source.children[i];
        this.add(child.clone());
      }
    }

    return this;
  }

  public clone(recursive?: boolean): Object3D {
    return new (this.constructor as typeof Object3D)().copy(this, recursive);
  }

  public setPosition(position: vec3): void;
  public setPosition(x: number, y: number, z: number): void;
  public setPosition(positionOrX: number | vec3, y?: number, z?: number) {
    if (typeof positionOrX !== 'number') {
      vec3.copy(this.position, positionOrX);
    } else {
      vec3.set(this.position, positionOrX, y!, z!);
    }
  }

  public setPositionByWorldPosition(worldPosition: vec3) {
    // 获取刨除RTSMatrix以外的世界坐标
    this.getRTSMatrix(TEMP_MAT4);
    mat4.invert(TEMP_MAT4, TEMP_MAT4);
    mat4.mul(TEMP_MAT4, this.matrixWorld, TEMP_MAT4);

    mat3.fromMat4(TEMP_MAT3, TEMP_MAT4);
    mat4.getTranslation(TEMP_POS, TEMP_MAT4);

    // 与要设置的世界坐标偏移量
    vec3.sub(TEMP_POS, worldPosition, TEMP_POS);
    // 转换为部件本地坐标系中的坐标
    mat3.invert(TEMP_MAT3, TEMP_MAT3);
    vec3.transformMat3(TEMP_POS, TEMP_POS, TEMP_MAT3);

    vec3.copy(this.position, TEMP_POS);
  }

  public setQuaternion(quaternion: quat): void;
  public setQuaternion(x: number, y: number, z: number): void;
  public setQuaternion(quaternionOrX: number | quat, y?: number, z?: number) {
    if (typeof quaternionOrX !== 'number') {
      quat.copy(this.quaternion, quaternionOrX);
    } else {
      quat.fromEuler(this.quaternion, quaternionOrX, y, z);
    }
  }

  public setQuaternionByWorldQuaternion(quaternion: quat) {
    this.parent
      ? quat.copy(TEMP_QUAT, this.parent.quaternionWorld)
      : quat.identity(TEMP_QUAT);
    quat.invert(TEMP_QUAT, TEMP_QUAT);
    quat.mul(this.quaternion, TEMP_QUAT, quaternion);
  }

  /**
   * 获取中心点在经过本部件缩放+旋转后的偏移量
   * @param out
   * @returns
   */
  public getTransformedPivot(out: vec3) {
    vec3.mul(out, this.scale, this.pivot);
    return vec3.transformQuat(out, out, this.quaternion);
  }

  /**
   * 获取中心点的世界坐标位置
   */
  public getWorldPivot() {
    // 计算中心点偏移量
    mat3.fromMat4(TEMP_MAT3, this.matrixWorld);
    vec3.transformMat3(TEMP_VEC3, this.pivot, TEMP_MAT3);

    // 获取世界坐标位置，减去中心点偏移量
    mat4.getTranslation(TEMP_POS, this.matrixWorld);
    vec3.sub(TEMP_POS, TEMP_POS, TEMP_VEC3);
    return vec3.clone(TEMP_POS);
  }

  /**
   * Object3D 啥也不渲染
   */
  public draw() {}

  /**
   * 生成默认的绘制参数，携带一些默认属性。
   * 比如object3D自身的matrixWorld、modelViewMatrix。
   * @returns 基础的绘制参数
   */
  protected createDrawConfig(): DefaultDrawConfig {
    return {
      attributes: {},
      uniforms: {
        matrixWorld: () => this.matrixWorld,
        modelViewMatrix: () => this.modelViewMatrix,
      },
    };
  }

  public getRenderOrder() {
    return this.renderOrder;
  }

  public getFrustumCulled() {
    return this.frustumCulled;
  }
}
