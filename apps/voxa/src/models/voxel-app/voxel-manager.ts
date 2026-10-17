import { MuReadStream, MuWriteStream } from '@box/mudb/stream';
import { vec3 } from 'gl-matrix';
import { assoc, clone } from 'ramda';
import { nanoid } from 'nanoid';
import { allocEmptyVoxels } from '@box/utils/helper';
import {
  cloneVoxels,
  flipVoxels,
  isEmptyVoxels,
  restoreVoxels,
  storeVoxels,
  VoxelView,
} from '@box/utils/voxel';
import { getVertexCount, voxelToRectangles } from '@box/mesher';
import { ObjSizeToVoxelShape, SerializedVec3 } from '../../utils/math';
import type { Models } from '../voxel-model';
import { bakeMesh } from '../voxel-model/bake';
import type { Controller } from './controller';
import { INDEX_TO_AXIS } from './interfaces';
import type { ApplyVoxels, PaletteDict } from './interfaces';
import { store } from '../../redux/store';
import { isEmptyBounds, loadRawMesh } from '../voxel-model/util';
import { ProjectVoxel, VoxelDimensionType } from '../project/interfaces';
import { VoxelDimension } from '../project/defs';
import { ProjectNodeType } from '../../redux/animator-slice';
import { DEFAULT_SPACE_SIZE } from '../../defs';

export const DEFAULT_FLIP: SerializedVec3 = [0, 0, 0];

export const DEFAULT_FLIP_KEY: string = getFlipKey(DEFAULT_FLIP);

export function getFlipKey(flip: SerializedVec3) {
  return flip.join();
}

export function getMeshId(
  voxelId: string,
  flip: SerializedVec3 = DEFAULT_FLIP,
) {
  return `${voxelId}-${getFlipKey(flip)}`;
}

type MeshResource = {
  bounds: SerializedVec3;
  /**
   * 体素模型的最低点
   */
  boundaryStart: SerializedVec3;
  /**
   * 网格的颜色索引。长度为网格长度的 1 / 8
   */
  colorIndex: Uint16Array;
  /**
   * 已烘焙的网格数据。
   */
  rawMeshBuffer: Uint16Array;
  /**
   * 对应的翻转状态
   */
  flip: SerializedVec3;
};

/**
 * 体素资源格式
 */
export interface VoxelModelProp {
  /**
   * 体素模型ID
   */
  id: string;
  /**
   * 体素渲染维度
   */
  dimension: VoxelDimensionType;
  /**
   * 体素视图数据。
   * 包含了模型空间大小。
   */
  voxelView: VoxelView;
  /**
   * 不同翻转下的mesh数据。key的格式形如`1, 0, 0`
   */
  meshes: Record<string, MeshResource>;
  /**
   * 通过@box/mesher计算的面数
   * - 翻转不会真正改变体素的“内容”，顶点数不会变，因此一个体素存一个值即可
   */
  mesherFaces?: number;
}

type InitParams = {
  applyVoxels: ApplyVoxels;
  models: Models;
  controller: Controller;
};

export class VoxelManager {
  private models: Models;

  private controller: Controller;

  private applyVoxels: ApplyVoxels;

  /**
   * 记录体素模型ID对应的模型数据。
   */
  public map: Map<string, VoxelModelProp> = new Map();

  /**
   * 记录已删除的体素模型ID对应的模型数据
   * 数据为VoxelSchema转的Uint8Array
   */
  private removedMap: Map<string, ProjectVoxel> = new Map();

  constructor({ models, controller, applyVoxels }: InitParams) {
    this.models = models;

    this.controller = controller;

    this.applyVoxels = applyVoxels;
  }

  // 加载模型数据，
  public loadModel(id: string, size = DEFAULT_SPACE_SIZE) {
    let model = this.map.get(id);

    if (!model) {
      const { shape, dimension } = ObjSizeToVoxelShape(size);
      const [nx, ny, nz] = shape;

      const voxelView = allocEmptyVoxels(nx, ny, nz);

      model = this.createModel(id, voxelView, dimension);

      this.map.set(id, model);
    }

    this.applyVoxels([model.voxelView], model.dimension);
    return model;
  }

  /**
   * 新增体素模型
   * @param id 体素模型id
   * @param voxelView 体素视图
   * @returns
   */
  public addModel(id: string, voxelView: VoxelView): VoxelModelProp {
    const newModel = this.createModel(id, voxelView);

    this.map.set(id, newModel);

    return newModel;
  }

  private createModel(
    newId: string,
    voxelView: VoxelView,
    dimension = VoxelDimension.XYZ,
  ): VoxelModelProp {
    return {
      id: newId,
      voxelView,
      dimension,
      meshes: {
        [DEFAULT_FLIP_KEY]: {
          bounds: [0, 0, 0],
          boundaryStart: [0, 0, 0],
          rawMeshBuffer: new Uint16Array(0),
          colorIndex: new Uint16Array(0),
          flip: [...DEFAULT_FLIP],
        },
      },
    };
  }

  /**
   * 更新当前正在编辑体素数据
   */
  public updateEditingVoxel() {
    const currentId = store.getState().app.editingVoxelId;

    if (!currentId) {
      return;
    }

    const voxelRes = this.map.get(currentId);

    if (!voxelRes) {
      return;
    }

    const { meshes } = voxelRes;

    this.controller.deSelect();

    const { destination } = this.models;

    destination.updateMesh();

    const voxelView = cloneVoxels(destination.voxels);

    voxelRes.voxelView = voxelView;

    voxelRes.dimension = store.getState().editing.dimension;

    Object.values(meshes).forEach(({ flip }) => {
      const flipKey = getFlipKey(flip);

      // 无翻转，直接从destination取值
      if (vec3.exactEquals(flip, DEFAULT_FLIP)) {
        const { lo, hi } = destination;

        const { bounds, boundaryStart } = this.getBounds(lo, hi);

        const rawMeshBuffer = destination.rawMeshBuffer.slice();
        const colorIndex = destination.cIndexBuffer.slice();

        voxelRes.meshes[flipKey] = {
          rawMeshBuffer,
          colorIndex,
          boundaryStart,
          bounds,
          flip,
        };
        return;
      }

      const res = this.getFlippedRawMesh(voxelView, flip);

      if (!res) {
        return;
      }

      const { mesh: rawMeshBuffer, colorIndex, lo, hi } = res;

      const { boundaryStart, bounds } = this.getBounds(lo, hi);

      voxelRes.meshes[flipKey] = {
        rawMeshBuffer,
        colorIndex,
        boundaryStart,
        bounds,
        flip,
      };
    });

    if (store.getState().app.profilerEnabled) {
      voxelRes.mesherFaces = this.getMesherFaces(
        voxelRes.voxelView,
        voxelRes.dimension,
      );
    }

    return voxelRes;
  }

  /**
   * 获取实际模型内容的边界大小。以及边界的起点。
   * @param voxelId voxel id
   * @returns Boundary
   */
  private getBounds(
    lo: vec3,
    hi: vec3,
  ): {
    bounds: SerializedVec3;
    boundaryStart: SerializedVec3;
  } {
    const [lx, ly, lz] = lo;
    const [hx, hy, hz] = hi;

    const bounds: vec3 = [0, 0, 0];

    const boundaryStart: vec3 = [0, 0, 0];

    if (hx < lx || hy < ly || hz < lz) {
      return {
        bounds,
        boundaryStart,
      };
    }

    vec3.sub(bounds, hi, lo);
    vec3.copy(boundaryStart, lo);

    return { bounds, boundaryStart };
  }

  /**
   * 销毁当前存储的所有体素模型数据
   */
  public destroyModels() {
    this.map.clear();
    this.removedMap.clear();
  }

  public getFlippedVoxelView(voxelView: VoxelView, flip: SerializedVec3) {
    let tempVoxelView = voxelView;

    if (!vec3.exactEquals(flip, [0, 0, 0])) {
      tempVoxelView = cloneVoxels(voxelView);

      // TODO 处理成一次执行完翻转
      flip.forEach((flag, axis) => {
        if (!flag) {
          return;
        }
        flipVoxels(tempVoxelView, INDEX_TO_AXIS[axis], {
          start: [0, 0, 0],
          end: tempVoxelView.getDimension(),
        });
      });
    }
    return tempVoxelView;
  }

  /**
   * 根据体素视图和翻转信息计算新的mesh数据
   */
  private getFlippedRawMesh(voxelView: VoxelView, flip: SerializedVec3) {
    const { mesh, isEmptyVoxels } = bakeMesh(
      this.getFlippedVoxelView(voxelView, flip),
    );

    if (mesh && !isEmptyVoxels) {
      return loadRawMesh(mesh);
    }
  }

  public cloneModel(voxelId: string) {
    const voxelModelProp = this.map.get(voxelId);

    if (!voxelModelProp) {
      return;
    }

    const { meshes, voxelView, dimension } = voxelModelProp;

    const newId = nanoid();

    const newProp: VoxelModelProp = {
      id: newId,
      dimension,
      voxelView: cloneVoxels(voxelView),
      meshes: clone(meshes),
    };

    this.map.set(newId, newProp);

    return newProp;
  }

  public removeVoxel(voxelId: string) {
    // TODO: 正常流程删除的时候
    // 需要检查voxelId在多部件的引用情况
    // 无引用再删除
    // 但现在无控件复制功能，voxelId与部件是一一对应的
    // 不需要查找
    const voxelModel = this.map.get(voxelId);
    if (!voxelModel) {
      return;
    }
    const projectVoxel = this.getVoxelData(voxelModel);
    this.removedMap.set(voxelId, projectVoxel);
    this.map.delete(voxelId);
  }

  public restoreModel(voxelId: string) {
    const projectVoxel = this.removedMap.get(voxelId);
    if (!projectVoxel) {
      return;
    }
    const voxelModel = this.loadVoxelData(projectVoxel);
    this.map.set(voxelModel.id, voxelModel);
    this.removedMap.delete(voxelId);
  }

  /**
   * 把运行时体素数据，转换成存储数据。
   */
  public getVoxelData(voxelModel: VoxelModelProp): ProjectVoxel {
    const { editingVoxelId } = store.getState().app;

    if (editingVoxelId === voxelModel.id) {
      this.updateEditingVoxel();
    }

    const { id, dimension, voxelView, meshes } = voxelModel;

    let encodedView: number[] = [];

    const writeStream = new MuWriteStream(12);

    const [mesh] = Object.values(meshes);

    const isEmpty = mesh
      ? isEmptyBounds(mesh.bounds)
      : isEmptyVoxels(voxelView);

    storeVoxels(voxelView, writeStream, isEmpty);

    encodedView = Array.from(writeStream.bytes());

    writeStream.destroy();

    return {
      id,
      dimension,
      encodedView,
    };
  }

  /**
   * 加载工程格式存储的体素，并生成未翻转的网格数据
   * @param voxelData 工程格式存储的体素
   * @param paletteDict 色板索引字典，如果传入，会在生成网格前，替换体素点的颜色索引
   */
  public loadVoxelData(
    voxelData: ProjectVoxel,
    paletteDict?: PaletteDict,
  ): VoxelModelProp {
    const { id, dimension, encodedView } = voxelData;

    const readStream = new MuReadStream(new Uint8Array(encodedView));

    const { isEmpty, voxels } = restoreVoxels(readStream);

    if (paletteDict) {
      voxels.data.forEach((v, idx) => {
        voxels.data[idx] = paletteDict[v];
      });
    }

    let rawMeshBuffer: Uint16Array | undefined;

    let colorIndex: Uint16Array | undefined;

    let boundaryStart: SerializedVec3 | undefined;

    let bounds: SerializedVec3 | undefined;

    if (!isEmpty) {
      const { mesh, isEmptyVoxels } = bakeMesh(voxels);

      if (mesh && !isEmptyVoxels) {
        const result = loadRawMesh(mesh);

        rawMeshBuffer = result.mesh;

        colorIndex = result.colorIndex;

        boundaryStart = result.lo;

        bounds = result.bounds;
      }
    }

    if (!rawMeshBuffer || !colorIndex || !boundaryStart || !bounds) {
      rawMeshBuffer = new Uint16Array(0);

      colorIndex = new Uint16Array(0);

      boundaryStart = [0, 0, 0];

      bounds = [0, 0, 0];
    }

    return {
      id,
      voxelView: voxels,
      dimension,
      meshes: {
        [DEFAULT_FLIP_KEY]: {
          rawMeshBuffer,
          colorIndex,
          bounds,
          boundaryStart,
          flip: [...DEFAULT_FLIP],
        },
      },
    };
  }

  /**
   * 获取对应翻转的体素mesh
   */
  public getVoxelMesh(
    voxelId: string,
    flip: SerializedVec3 = DEFAULT_FLIP,
  ): MeshResource | undefined {
    const voxelRes = this.map.get(voxelId);

    if (!voxelRes) {
      return;
    }

    const flipKey = getFlipKey(flip);

    if (!voxelRes.meshes[flipKey]) {
      const res = this.getFlippedRawMesh(voxelRes.voxelView, flip);

      if (res) {
        const { bounds, boundaryStart } = this.getBounds(res.lo, res.hi);

        voxelRes.meshes[flipKey] = {
          rawMeshBuffer: res.mesh,
          colorIndex: res.colorIndex,
          boundaryStart,
          bounds,
          flip: [...flip],
        };
      }
    }

    // 如果渲染维度为2D，需要重新bake mesh，让部件渲染为真正的2D
    if (voxelRes.dimension !== VoxelDimension.XYZ) {
      const { mesh, isEmptyVoxels } = bakeMesh(
        this.getFlippedVoxelView(voxelRes.voxelView, flip),
        voxelRes.dimension,
      );

      if (mesh && !isEmptyVoxels) {
        voxelRes.meshes[flipKey].rawMeshBuffer = loadRawMesh(mesh).mesh;
      }
    }

    return voxelRes.meshes[flipKey];
  }

  /**
   * 清理掉不再被使用的翻转体素数据。
   * - 减少内存占用
   * - 生成作品数据时，提前清理掉无用的数据
   */
  public clearUnusedFlippedMesh() {
    const { hierarchyData } = store.getState().animator;

    const meshInUse: Record<string, Record<string, true>> = {};

    // 从节点树中整理出在使用的voxelId及对应翻转的mesh
    Object.values(hierarchyData).forEach((node) => {
      if (!node || node.type !== ProjectNodeType.SkinPart || !node.voxelId) {
        return;
      }

      const flip = node.flip || DEFAULT_FLIP;

      const flipKey = getFlipKey(flip);

      if (!meshInUse[node.voxelId]) {
        meshInUse[node.voxelId] = {};
      }

      meshInUse[node.voxelId][flipKey] = true;
    });

    this.map.forEach((voxelRes: VoxelModelProp) => {
      const { id, meshes } = voxelRes;

      if (meshInUse[id] === undefined) {
        return;
      }

      let newMeshes: Record<string, MeshResource> = {};

      Object.keys(meshes).forEach((key) => {
        // 没有被使用，进行删除
        if (meshInUse[id][key]) {
          newMeshes = assoc(key, meshes[key], newMeshes);
        }
      });

      voxelRes.meshes = newMeshes;
    });
  }

  /**
   * 更新对应体素模型数据
   * @param id 体素模型ID
   */
  public updateVoxelModel(id: string, voxelView: VoxelView) {
    const voxelModel = this.map.get(id);

    if (!voxelModel) {
      return;
    }

    voxelModel.voxelView = voxelView;

    Object.values(voxelModel.meshes).forEach(({ flip }) => {
      const flipKey = getFlipKey(flip);

      const res = this.getFlippedRawMesh(voxelModel.voxelView, flip);

      if (!res) {
        return;
      }

      voxelModel.meshes[flipKey] = {
        rawMeshBuffer: res.mesh,
        colorIndex: res.colorIndex,
        boundaryStart: res.lo,
        bounds: res.bounds,
        flip,
      };
    });

    if (store.getState().app.profilerEnabled) {
      voxelModel.mesherFaces = this.getMesherFaces(
        voxelModel.voxelView,
        voxelModel.dimension,
      );
    }
  }

  /**
   * 获取特定体素内容和维度在mesher计算得到的面数
   * @param voxels 体素内容
   * @param dimension 模型维度
   * @returns 面数
   */
  private getMesherFaces(voxels: VoxelView, dimension: number) {
    const rectangles = voxelToRectangles(
      voxels,
      new Map(),
      true,
      true,
      false,
      dimension,
    );

    return getVertexCount(rectangles) / 3;
  }

  /**
   * 如果当前体素数据没有mesher面数，则进行计算更新，并返回面数
   */
  public updateMesherFaces(voxelId: string): number | undefined {
    const voxelRes = this.map.get(voxelId);

    if (!voxelRes) {
      return;
    }

    if (voxelRes.mesherFaces === undefined) {
      voxelRes.mesherFaces = this.getMesherFaces(
        voxelRes.voxelView,
        voxelRes.dimension,
      );
    }

    return voxelRes.mesherFaces;
  }
}
