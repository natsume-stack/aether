import { quat, vec3 } from 'gl-matrix';
import type { Regl } from '@box/regl';
import { store } from '../../../redux/store';
import { ShaderMaterial } from '../../rendering/materials/shader';
import { Mesh } from '../../rendering/objects/mesh';
import { Object3D } from '../../rendering/objects/object3d';
import {
  basicFragmentShader,
  basicVertexShader,
} from '../../rendering/shaders';
import { Geometry } from '../../rendering/geometry';
import { BufferAttribute } from '../../rendering/geometries/buffer-attribute';
import { setFromUnitVectors } from '../../rendering/math/quat';
import type { BoneNode } from '../../bone';
import { RenderOrder } from '../util';
import { ROOT_BONE_ID } from '../../../defs';
import { AppMode } from 'apps/voxa/src/redux/app-slice';
import { AnimatorMode } from 'apps/voxa/src/redux/animator-slice';

export class SkeletonHelper extends Object3D {
  // 骨骼的geometry，自创的
  private skeletonMesh: SkeletonMesh;

  constructor(regl: Regl, private map: Map<string, BoneNode>) {
    super();
    this.skeletonMesh = new SkeletonMesh(regl);
    this.add(this.skeletonMesh);
  }

  public updateMatrixWorld(force?: boolean): void {
    this.updateVisible();

    if (!this.visible) {
      return;
    }

    const { hierarchyData } = store.getState().animator;

    const rootBone = hierarchyData[ROOT_BONE_ID];
    if (!rootBone.childrenIds?.length) {
      this.skeletonMesh.update([]);
      return;
    }

    // 构造骨骼geometry需要的数据
    const skeletonData: SkeletonOptions = [];
    const ids = [...rootBone.childrenIds];
    while (ids.length) {
      const id = ids.shift();
      if (!id) {
        break;
      }
      const topBone = this.map.get(id);
      const childrenIds = hierarchyData[id]?.childrenIds;
      if (!topBone || !childrenIds?.length) {
        continue;
      }

      childrenIds.forEach((childId) => {
        const bottomBone = this.map.get(childId);
        if (!bottomBone) {
          return;
        }
        skeletonData.push({
          top: [
            topBone.matrixWorld[12],
            topBone.matrixWorld[13],
            topBone.matrixWorld[14],
          ],
          bottom: [
            bottomBone.matrixWorld[12],
            bottomBone.matrixWorld[13],
            bottomBone.matrixWorld[14],
          ],
        });
      });

      ids.push(...childrenIds);
    }
    this.skeletonMesh.update(skeletonData);

    super.updateMatrixWorld(force);
  }

  private updateVisible() {
    const { app, animator } = store.getState();

    // 体素模式下/物理编辑模式下不显示骨骼helper
    if (app.mode === AppMode.Voxel || animator.mode === AnimatorMode.HitBox) {
      this.visible = false;
      return;
    }
    this.visible = animator.skeletonVisible;
  }
}

/**
 * 骨骼Mesh
 */
class SkeletonMesh extends Mesh {
  /**
   * 骨骼的geometry，自创的
   */
  private skeletonGeometry: SkeletonGeometry;
  protected renderOrder = RenderOrder.bone;

  public raycast = () => {};
  constructor(regl: Regl) {
    const shader = new ShaderMaterial({
      vertexShader: basicVertexShader,
      fragmentShader: basicFragmentShader,
      uniforms: {
        // 骨骼永恒的颜色 #56BB35
        color: [0.34, 0.73, 0.21],
        alpha: 1,
      },
      depth: {
        enable: false,
        mask: false,
      },
      cull: {
        enable: false,
      },
      transparent: true,
    });
    const skeletonGeometry = new SkeletonGeometry();
    super(regl, skeletonGeometry, shader);
    this.skeletonGeometry = skeletonGeometry;
  }

  public update(options: SkeletonOptions) {
    this.skeletonGeometry.update(options);
  }
}

type SkeletonOptions = {
  /**
   * 骨骼内一根骨头的起始点
   */
  top: [number, number, number];
  /**
   * 骨骼内一根骨头的结束点
   */
  bottom: [number, number, number];
}[];

/**
 * 一根骨头8个面的索引值
 * 一根骨头一共6个顶点，第0个为顶点，第5个为底点，中间四个为横截面的点
 * 通过6个顶点构造8个三角形，indices一共是 3 * 8 = 24个元素
 */
const BASIC_INDICES = [
  1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 0, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1, 5,
];

/**
 * 索引值步长 = 一根骨头的顶点数量
 */
const INDICES_PTR = 6;

/**
 * 横截面定宽1.8
 */
const WIDTH = 1.8;

/**
 * 初始法向量，用于计算骨头旋转量
 */
const ORIGIN_NORMAL = vec3.fromValues(0, -1, 0);

const TEMP_NORMAL = vec3.create();
const TEMP_VERTEX = vec3.create();
const TEMP_QUAT = quat.create();

/**
 * 自定义骨骼geometry
 * 通过参数SkeletonOptions构造出整个骨架的的顶点坐标
 * 参数为数组，一个数组元素代表一根骨头
 * 一跟骨头由两个四棱锥拼接而成，一共需要6个顶点，8个面
 * 骨头上半截和下半截的长度比例为 1:14
 * 横截面为恒定宽度WIDTH
 */
class SkeletonGeometry extends Geometry {
  constructor() {
    super();
    this.buildGeometry([]);
  }
  public update(options: SkeletonOptions) {
    this.buildGeometry(options);
    super.updateBounding();
  }
  private buildGeometry(options: SkeletonOptions) {
    const indices: number[] = [];
    const vertices: number[] = [];

    generateTorso({
      options: options,
      indices,
      vertices,
    });

    this.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(vertices), 3),
    );

    this.setElementsByArray(indices, 3);
  }
}

type TorsoParams = {
  options: SkeletonOptions;
  vertices: number[];
  indices: number[];
};

function generateTorso(params: TorsoParams) {
  const { options, vertices, indices } = params;

  options.forEach((bone, index) => {
    const { top, bottom } = bone;
    const len = vec3.distance(top, bottom);
    const topHeight = len / 15;
    const halfWidth = WIDTH / 2;

    // 顶点
    vertices.push(...top);

    // 中间的正方形四个顶点
    for (let i = 1; i <= 4; i++) {
      const u = i / 4;
      const theta = u * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      TEMP_VERTEX[0] = halfWidth * sinTheta;
      TEMP_VERTEX[1] = -topHeight;
      TEMP_VERTEX[2] = halfWidth * cosTheta;

      vec3.sub(TEMP_NORMAL, bottom, top);
      vec3.normalize(TEMP_NORMAL, TEMP_NORMAL);
      setFromUnitVectors(TEMP_QUAT, ORIGIN_NORMAL, TEMP_NORMAL);
      vec3.transformQuat(TEMP_VERTEX, TEMP_VERTEX, TEMP_QUAT);

      TEMP_VERTEX[0] += top[0];
      TEMP_VERTEX[1] += top[1];
      TEMP_VERTEX[2] += top[2];
      vertices.push(...TEMP_VERTEX);
    }

    // 底点
    vertices.push(...bottom);

    // generate indices
    indices.push(...BASIC_INDICES.map((i) => i + INDICES_PTR * index));
  });
}
