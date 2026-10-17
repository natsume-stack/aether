import { mat4, vec3 } from 'gl-matrix';
import {
  SkinMetaData,
  bodyPartSchemaToBytes,
  migrateProject,
  modelSchemaToBytes,
  projectSchemaToBytes,
  VOXA_SKIN_VERSION,
  projectV5,
} from '@box/voxa-project';
import type { ProjectDataTypes } from '@box/voxa-project/build/types/project/def';
import { shouldSaveAsMapModel } from './save-target';
import {
  BodyPartDataSchema,
  LOAD_TIMEOUT,
  ModelDataSchema,
  PaletteGroupsSchema,
  PaletteItemSchema,
  ProjectDataSchema,
  SAVE_TIMEOUT,
  SaveErrorType,
  Uint16Vec3Schema,
  Uint8Vec3Schema,
  Vec3Schema,
  Vec4Schema,
  Mat3Schema,
} from './defs';
import { Mesher } from '@box/mesher';
import {
  BODY_PART_DEFAULT_SCALE,
  BodyPart,
} from '@box/schema/player/player-schema';
import {
  CreativeMode,
  ModelSnapshotResp,
  ModelType,
  ModelErrorCode,
  ModelResp,
} from '@box/apis';
import { apis } from '../../apis';
import {
  DEFAULT_GROUP_ID,
  DEFAULT_PROJECT_NAME,
  ROOT_ID,
  ROOT_SKIN_ID,
} from '../../defs';
import { HierarchyData } from '../../redux/animator-slice';
import {
  EditType,
  creativeModeToEditTypeMap,
  setProjectId,
  setProjectName,
  setProjectType,
} from '../../redux/app-slice';
import {
  EMPTY_PALETTE_ITEM,
  PaletteGroup,
  PaletteItems,
  setPaletteState,
} from '../../redux/palette-slice';
import { store } from '../../redux/store';
import { voxelShapeToObjSize, SerializedVec3 } from '../../utils/math';
import type { AnimatorApp } from '../animator-app';
import type { EditingHistory } from '../editing-history';
import type {
  GetScreenshot,
  RestoreEditingState,
  StashEditingState,
  SwitchToAnimator,
  SwitchToVoxel,
} from '../interfaces';
import type { Palette } from '../palette';
import type { VoxelApp } from '../voxel-app';
import { isEmptyBounds } from '../voxel-model/util';
import type { IEvents } from '../events/interface';
import { DEFAULT_PROJECT } from './default-project';
import { ProjectDiffTool } from './diff';
import { getMesherTextureData, isPaletteItemValid } from '../palette/util';
import type {
  BasicModelData,
  ModelData,
  ModelMetaData,
  ProjectData,
  ProjectPaletteData,
  ProjectPaletteItems,
  ProjectVoxels,
  SaveProjectParams,
  SaveResult,
  MeshesIdDict,
  Vec3SchemaType,
} from './interfaces';
import { getMeshId } from '../voxel-app/voxel-manager';
import { everyNode, isSkinPart } from '../animator-app/util';
import { mat4SetFromMat3 } from '../rendering/utils/math';

type InitParams = {
  voxelApp: VoxelApp;
  animatorApp: AnimatorApp;
  history: EditingHistory;
  palette: Palette;
  events: IEvents;
  getScreenshot: GetScreenshot;
  switchToAnimator: SwitchToAnimator;
  switchToVoxel: SwitchToVoxel;
  stashEditingState: StashEditingState;
  restoreEditingState: RestoreEditingState;
};

const TEMP_VEC3 = vec3.create();
const TEMP_MAT4 = mat4.create();

/**
 * 管理工程文件的模块。
 */
export class ProjectManager {
  private voxelApp: VoxelApp;

  private animatorApp: AnimatorApp;

  private history: EditingHistory;

  private palette: Palette;

  private events: IEvents;

  private getScreenshot: GetScreenshot;

  private switchToAnimator: SwitchToAnimator;

  private switchToVoxel: SwitchToVoxel;

  private stashEditingState: StashEditingState;

  private restoreEditingState: RestoreEditingState;

  public readonly diffTool: ProjectDiffTool;

  constructor({
    voxelApp,
    animatorApp,
    history,
    palette,
    events,
    getScreenshot,
    switchToAnimator,
    switchToVoxel,
    stashEditingState,
    restoreEditingState,
  }: InitParams) {
    this.voxelApp = voxelApp;

    this.animatorApp = animatorApp;

    this.getScreenshot = getScreenshot;

    this.switchToAnimator = switchToAnimator;

    this.switchToVoxel = switchToVoxel;

    this.stashEditingState = stashEditingState;

    this.restoreEditingState = restoreEditingState;

    this.history = history;

    this.palette = palette;

    this.events = events;

    this.diffTool = new ProjectDiffTool(this);
  }

  /**
   * 生成ProjectData数据。
   */
  public async getData(): Promise<ProjectData> {
    await this.stashEditingState();

    const projectData = ProjectDataSchema.alloc();

    projectData.nodes = this.animatorApp.exporter.getProjectNodes();

    projectData.animations = this.animatorApp.exporter.getProjectAnimations();

    projectData.hitBox = this.animatorApp.exporter.getProjectHitBox();

    projectData.voxels = this.getVoxels();

    projectData.palette = this.getPalette();

    projectData.modelPivot = this.animatorApp.exporter.getProjectModelPivot();

    this.restoreEditingState();

    return projectData;
  }

  /**
   * 加载数据之前的一些准备工作。
   */
  private beforeLoadingData() {
    const { veController, voxelManager } = this.voxelApp;

    veController.abortAction();

    this.palette.clear();

    this.animatorApp.destroyNodes();

    voxelManager.destroyModels();

    // 切回多部件页面
    store.getState().permission.editParts && this.switchToAnimator();

    // 清空历史记录
    this.history.clear();
  }

  /**
   * 加载数据。加载时需要注意，进行数据校验。
   */
  private loadData(projectData: ProjectData, projectName: string) {
    this.events.emit('abort');

    const { palette, voxels, nodes, animations, hitBox, modelPivot } =
      projectData;

    this.beforeLoadingData();

    // 先加载色板，后续voxels要查
    this.loadPalette(palette);

    // 先加载voxels，后续skinPart要查。
    this.loadVoxels(voxels);

    // 加载nodes
    this.animatorApp.loader.loadNodesData(nodes);

    // 加载动画数据
    this.animatorApp.loader.loadMotions(animations);

    // 加载物理碰撞框数据
    this.animatorApp.loader.loadHitBoxData(hitBox);

    let pivot: Vec3SchemaType;
    // 加载模型锚点
    if (modelPivot) {
      pivot = modelPivot;
    } else {
      pivot = this.animatorApp.loader.calculateModelPivot();
    }
    this.animatorApp.loader.loadModelPivot(pivot);

    // 设置文件名称
    store.dispatch(setProjectName(projectName));

    // 设置当前工程文件快照
    this.diffTool.setSnapshot({
      projectData: projectData,
      projectName,
    });

    this.onDataLoaded();
  }

  /**
   * 加载数据后的处理
   */
  private onDataLoaded() {
    // 默认选中根目录下第一个部件/多部件，该操作不能被撤销
    const { hierarchyData } = store.getState().animator;

    if (store.getState().permission.editParts) {
      // 重置摄像机默认视角
      this.animatorApp.scene.updateMatrixWorld(true);
      this.animatorApp.resetCamera();

      const childrenIds = hierarchyData[ROOT_SKIN_ID].childrenIds;
      const firstId = childrenIds ? childrenIds[0] : undefined;
      firstId && this.animatorApp.nodeManager.setActiveIds([firstId], false);

      this.animatorApp.modelPivotManager.updateTransformPos();
    } else {
      let fistSkinPartId = this.getFirstSkinPartNode(ROOT_ID, hierarchyData);

      if (!fistSkinPartId) {
        // 增加一个部件
        fistSkinPartId = this.animatorApp.nodeManager.addSkinPart({
          toRename: false,
          toSetActive: false,
        }).uuid;
      }

      this.history.setStateRecordingEnabled(false);

      this.switchToVoxel(fistSkinPartId);

      this.history.setStateRecordingEnabled(true);
    }
  }

  private getVoxels(): ProjectVoxels {
    const voxels: ProjectVoxels = {};

    this.voxelApp.voxelManager.map.forEach((voxelModel) => {
      voxels[voxelModel.id] =
        this.voxelApp.voxelManager.getVoxelData(voxelModel);
    });

    return voxels;
  }

  private loadVoxels(voxels?: ProjectVoxels) {
    if (!voxels) {
      console.error('Failed to load voxels');
      return;
    }

    Object.keys(voxels).forEach((voxelId) => {
      const voxelData = voxels[voxelId];

      const voxelModel = this.voxelApp.voxelManager.loadVoxelData(voxelData);

      this.voxelApp.voxelManager.map.set(voxelModel.id, voxelModel);
    });
  }

  private getPalette(): ProjectPaletteData {
    const { items, groupList, groups } = store.getState().palette;

    const projectItems: ProjectPaletteItems = [];

    items.forEach((item, idx) => {
      if (isPaletteItemValid(item)) {
        const projectItem = PaletteItemSchema.alloc();
        projectItem.id = idx;
        projectItem.rgb = Uint8Vec3Schema.fromJSON(item.rgb);
        projectItem.hsv = Uint16Vec3Schema.fromJSON(item.hsv);
        projectItem.material.emissive = item.material.emissive;

        projectItems.push(projectItem);
      }
    });

    const validGroups: Record<string, PaletteGroup> = {};
    groupList.forEach((groupId) => {
      const group = groups[groupId];

      if (group) {
        validGroups[groupId] = group;
      }
    });

    return {
      items: projectItems,
      groupList,
      groups: validGroups,
    };
  }

  private loadPalette(paletteData?: ProjectPaletteData) {
    if (!paletteData) {
      console.error('Failed to load palette data');
      return;
    }

    const {
      items: projectItems,
      groups: projectGroups,
      groupList,
    } = paletteData;

    const items: PaletteItems = [];

    let idx = 0;

    for (let i = 0; i < projectItems.length; i++) {
      const cur = projectItems[i];

      const { id, rgb, hsv, material } = cur;

      for (let j = idx; j < id; j++) {
        items[j] = EMPTY_PALETTE_ITEM;
      }

      const [r, g, b] = rgb;
      const [h, s, v] = hsv;
      items[id] = {
        rgb: [r, g, b],
        hsv: [h, s, v],
        material: {
          emissive: material.emissive,
        },
      };

      idx = id + 1;
    }

    /**
     * 取默认分组的首个id作为默认选中id
     */
    const [selectedId] = paletteData.groups[DEFAULT_GROUP_ID].itemIds;

    store.dispatch(
      setPaletteState({
        selectedId,
        items,
        groupList,
        groups: PaletteGroupsSchema.toJSON(projectGroups),
      }),
    );
  }

  /**
   * 保存皮肤文件，并返回保存成功的hash值
   * 同时还需要生成并返回模型文件数据，和整体的bounds值。【仅仅是为了渲染封面图用】
   * TODO: 等到voxa player支持渲染皮肤文件后就不用生成没用的modelData了，可以直接渲染皮肤文件哦
   * @returns
   */
  private async saveSkinData(): Promise<{
    hash: string;
    modelData: ModelData;
    modelBounds: SerializedVec3;
  }> {
    await this.stashEditingState();

    // 画板数据公用，先解析
    const { paletteList, emissiveList } = getMesherTextureData(
      store.getState().palette.items,
    );

    // 构造metaData
    const metaData: SkinMetaData = {
      version: VOXA_SKIN_VERSION,
    };

    // 遍历BodyPart，解析每个骨骼上面的皮肤数据
    await Promise.all(
      Object.values(BodyPart).map((boneName) => {
        const setBodyPartHash = async () => {
          if (typeof boneName === 'number') {
            return;
          }
          const parsedData = this.animatorApp.exporter.parseBone(boneName);
          if (!parsedData) {
            return;
          }
          const { voxelIds, skinNodes, skinId } = parsedData;
          const bodyPartData = BodyPartDataSchema.clone(
            BodyPartDataSchema.identity,
          );
          bodyPartData.partId = BodyPart[boneName];

          // 获取当前皮肤部件相关的mesh数据
          const { mesher, meshesIdDict, meshCount } = this.getMesher(voxelIds);

          // 计算当前皮肤部件的bounds
          const { bounds } = this.animatorApp.exporter.getModelBounds(
            meshesIdDict,
            skinNodes,
          );
          bodyPartData.bounds[0] = bounds[0];
          bodyPartData.bounds[1] = bounds[1];
          bodyPartData.bounds[2] = bounds[2];

          // 以skinId为根节点获取nodes数据
          const { nodes } = this.animatorApp.exporter.getModelNodes(
            meshesIdDict,
            undefined,
            skinId,
          );
          bodyPartData.nodes = nodes;

          // 计算绑骨偏移量和nodes数据
          // 取第一个节点(直绑到骨骼的部件/部件组)的偏移量，加上皮肤默认缩放值，为整体皮肤部件的偏移矩阵
          // 并且清空第一个节点的偏移数据
          vec3.scale(
            bodyPartData.nodes[0].translation,
            bodyPartData.nodes[0].translation,
            BODY_PART_DEFAULT_SCALE,
          );

          vec3.scale(
            TEMP_VEC3,
            bodyPartData.nodes[0].scale,
            BODY_PART_DEFAULT_SCALE,
          );
          mat4.fromRotationTranslationScale(
            bodyPartData.bindMat,
            bodyPartData.nodes[0].rotation,
            bodyPartData.nodes[0].translation,
            TEMP_VEC3,
          );
          mat4SetFromMat3(TEMP_MAT4, bodyPartData.nodes[0].parentScaleMat3);
          mat4.mul(bodyPartData.bindMat, TEMP_MAT4, bodyPartData.bindMat);

          bodyPartData.nodes[0].rotation = Vec4Schema.fromJSON([0, 0, 0, 1]);
          bodyPartData.nodes[0].translation = Vec3Schema.fromJSON([0, 0, 0]);
          bodyPartData.nodes[0].scale = Vec3Schema.fromJSON([1, 1, 1]);
          bodyPartData.nodes[0].parentScaleMat3 = Mat3Schema.fromJSON([
            1, 0, 0, 0, 1, 0, 0, 0, 1,
          ]);

          // 生成顶点数据 和 uv texture
          if (meshCount > 0) {
            const meshes = mesher.getMeshes();
            const texture = await mesher.getTexture(paletteList, emissiveList);

            bodyPartData.meshes = meshes;
            bodyPartData.texture = texture;
          }

          // 先存部件hash值
          const partHash = await apis.upload.fileUploadPost({
            file: new Blob([bodyPartSchemaToBytes(bodyPartData)]),
          });
          metaData[boneName] = partHash;
        };
        return setBodyPartHash();
      }),
    );

    const modelData = ModelDataSchema.clone(ModelDataSchema.identity);

    // 生成整体的modelData，仅为了渲染截图
    const { mesher, meshesIdDict, meshCount } = this.getMesher();

    const { bounds, rootPartOffset } =
      this.animatorApp.exporter.getModelBounds(meshesIdDict);

    if (meshCount > 0) {
      modelData.meshes = mesher.getMeshes();
      modelData.texture = await mesher.getTexture(paletteList, emissiveList);
    }
    modelData.nodes = this.animatorApp.exporter.getModelNodes(
      meshesIdDict,
      rootPartOffset,
    ).nodes;

    this.restoreEditingState();

    const hash = await apis.upload.fileUploadPost({
      file: new Blob([JSON.stringify(metaData)]),
    });

    return {
      hash,
      modelData,
      modelBounds: bounds,
    };
  }

  /**
   * 生成基础的模型数据。
   * 该数据结构可用于生成Voxa模型数据、GLTF数据
   */
  public async getBasicModelData(): Promise<BasicModelData> {
    await this.stashEditingState();

    const { mesher, meshesIdDict, meshCount } = this.getMesher();

    const { modelPivot } = store.getState().animator;

    const { bounds, boundsCenter, rootPartOffset } =
      this.animatorApp.exporter.getModelBounds(meshesIdDict);

    const renderBoxOffset = this.animatorApp.exporter.getModelRenderBoxOffset({
      boundsCenter,
      modelPivot,
    });

    /**
     * 自定义物理框的offset是相对于”锚点“的距离
     */
    const { customBounds, useCustomBounds } =
      this.animatorApp.exporter.getModelCustomHitBox(modelPivot);

    let paletteList: SerializedVec3[] = [];
    let emissiveList: number[] = [];

    if (meshCount > 0) {
      const textureData = getMesherTextureData(store.getState().palette.items);

      paletteList = textureData.paletteList;
      emissiveList = textureData.emissiveList;
    }

    const { nodes, hierarchies, idToIndex } =
      this.animatorApp.exporter.getModelNodes(meshesIdDict, rootPartOffset);
    const { animations, motionList } =
      this.animatorApp.exporter.getModelAnimations(idToIndex, rootPartOffset);

    this.restoreEditingState();

    return {
      meshCount,
      mesher,
      bounds,
      paletteList,
      emissiveList,
      nodes,
      hierarchies,
      animations,
      motionList,
      useCustomBounds,
      customBounds,
      renderBoxOffset,
    };
  }

  /**
   * 存储模型文件到后端
   * 并返回hash值和相关数据
   * @returns
   */
  private async saveModelData(): Promise<{
    hash: string;
    metaData: ModelMetaData;
    modelData: ModelData;
  }> {
    const modelData = ModelDataSchema.clone(ModelDataSchema.identity);

    const {
      meshCount,
      mesher,
      bounds,
      paletteList,
      emissiveList,
      nodes,
      animations,
      motionList,
      useCustomBounds,
      customBounds,
      renderBoxOffset,
    } = await this.getBasicModelData();

    modelData.nodes = nodes;

    if (meshCount > 0) {
      const meshes = mesher.getMeshes();
      const texture = await mesher.getTexture(paletteList, emissiveList);

      modelData.meshes = meshes;
      modelData.texture = texture;
      modelData.animations = animations;
    }

    // 先存modelData
    const dataHash = await apis.upload.fileUploadPost({
      file: new Blob([modelSchemaToBytes(modelData)]),
    });

    // 构造metaData
    const metaData: ModelMetaData = {
      version: modelData.version,
      bounds,
      dataHash,
      motionList,
      useCustomBounds,
      customBounds,
      renderBoxOffset,
    };

    const hash = await apis.upload.fileUploadPost({
      file: new Blob([JSON.stringify(metaData)]),
    });
    return {
      hash,
      metaData,
      modelData,
    };
  }

  /**
   * 存储工程文件到后端
   * 并返回hash值和相关数据
   * @returns
   */
  public async saveProjectData(): Promise<{
    hash: string;
    projectData: ProjectData;
  }> {
    const projectData = await this.getData();
    const projectFile = new Blob([projectSchemaToBytes(projectData)]);
    const hash = await apis.upload.fileUploadPost({
      file: projectFile,
    });
    return {
      hash,
      projectData,
    };
  }

  /**
   * 生成Mesher，并添加体素视图数据。
   * @returns 返回Mesher实例、有效mesh个数、体素视图id与索引的映射关系
   */
  private getMesher(voxelIds?: string[]) {
    const meshesIdDict: MeshesIdDict = {};
    const mesher: Mesher = new Mesher(true, true, false);
    let meshCount = 0;

    this.voxelApp.voxelManager.clearUnusedFlippedMesh();

    (voxelIds || Array.from(this.voxelApp.voxelManager.map.keys())).forEach(
      (voxelId) => {
        const voxelRes = this.voxelApp.voxelManager.map.get(voxelId);
        if (!voxelRes) {
          return;
        }

        Object.values(voxelRes.meshes).forEach(
          ({ bounds, boundaryStart, flip }) => {
            if (isEmptyBounds(bounds)) {
              // 此时为空体素，不计算mesh数据
              return;
            }
            const { voxelManager } = this.voxelApp;

            const flippedVoxelView = voxelManager.getFlippedVoxelView(
              voxelRes.voxelView,
              flip,
            );

            const newBounds = voxelShapeToObjSize(bounds, voxelRes.dimension);

            meshesIdDict[getMeshId(voxelRes.id, flip)] = {
              index: meshCount,
              newBounds,
              boundaryStart: boundaryStart,
            };

            meshCount++;

            mesher.addModel(flippedVoxelView, voxelRes.dimension);
          },
        );
      },
    );

    return {
      mesher,
      meshesIdDict,
      meshCount,
    };
  }

  /**
   * 存储工程、模型、预览图等信息到后端。
   */
  private async save(params: {
    /**
     * 传入已有id为覆盖。不传入为新建。
     */
    id?: number;
    /**
     * 模型类型。
     */
    modelType: ModelType;
    /**
     * 是否为自动保存类型。
     */
    autoSave: boolean;
  }): Promise<SaveResult> {
    if (!navigator.onLine) {
      return {
        isSuccess: false,
        result: {
          type: SaveErrorType.Offline,
        },
      };
    }

    const { id, modelType, autoSave } = params;

    const { projectName, sourceMapId } = store.getState().app;

    let error: unknown;

    try {
      const isSkinMode = store.getState().app.editType === EditType.Skin;
      const projectResult = await this.saveProjectData();

      let modelFileHash: string;
      let modelData: ModelData;
      let modelBounds: SerializedVec3;
      let modelMetaData: ModelMetaData | undefined;

      if (isSkinMode) {
        const skinResult = await this.saveSkinData();
        modelFileHash = skinResult.hash;
        modelData = skinResult.modelData;
        modelBounds = skinResult.modelBounds;
      } else {
        const modelResult = await this.saveModelData();
        modelFileHash = modelResult.hash;
        modelMetaData = modelResult.metaData;
        modelData = modelResult.modelData;
        modelBounds = modelResult.metaData.bounds;
      }

      const modelPreviewFile = await this.getScreenshot(modelData, modelBounds);

      if (!modelPreviewFile) {
        console.error('Failed to get screenshot');

        return {
          isSuccess: false,
          result: {
            type: SaveErrorType.GetDataError,
          },
        };
      }

      const previewFileHash = await apis.upload.fileUploadPost({
        file: modelPreviewFile,
      });

      const saveParam = {
        modelId: id || undefined,
        animated: !!projectResult.projectData.animations.length,
        modelFileHash,
        modelProjectFileHash: projectResult.hash,
        modelPreviewFileHash: previewFileHash,
        modelName: projectName,
        modelType,
        autoSave,
        // 1, 自由模式； 2，定向创作
        creativeMode: isSkinMode ? CreativeMode.Skin : CreativeMode.Model,
      };
      let result: ModelResp;
      // 如果有sourceMapId，说明是从 Arena 打开的内嵌voxa
      // 目前可能从内嵌 voxa 编辑的有：共享皮肤、共享模型、项目模型
      // 等项目模型全部迁移结束，就只有共享皮肤和共享模型可以从内嵌 voxa 编辑
      const embeddedInEngine =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('parentType') ===
          'engine';
      if (
        shouldSaveAsMapModel(sourceMapId, embeddedInEngine) &&
        (modelType === ModelType.ExtensionLib ||
          modelType === ModelType.Project)
      ) {
        if (isSkinMode) {
          // 共享皮肤
          result = await apis.model.saveSharedSkinUsingPost(
            { ...saveParam, mapId: sourceMapId },
            { timeout: SAVE_TIMEOUT },
          );
        } else {
          // 共享模型
          result = await apis.model.saveProjectSharedModelUsingPost(
            { ...saveParam, mapId: sourceMapId },
            {
              timeout: SAVE_TIMEOUT,
            },
          );
        }
      } else {
        // 个人
        // 个人皮肤、个人模型
        result = await apis.model.saveModelUsingPostV1(saveParam, {
          timeout: SAVE_TIMEOUT,
        });
      }

      if (result) {
        return {
          isSuccess: true,
          result: {
            modelResp: result,
            modelData,
            modelMetaData,
            projectData: projectResult.projectData,
            modelType,
          },
        };
      }
    } catch (err) {
      const isSkinMode = store.getState().app.editType === EditType.Skin;
      console.error(`Failed to save ${isSkinMode ? 'skin' : 'model'}`, err);

      error = err;
    }

    return {
      isSuccess: false,
      result: { type: this.getSaveErrorType(error) },
    };
  }

  /**
   * 解析保存抛出的错误，生成对应的保存错误类型
   * @param error save流程中抛出的错误
   */
  private getSaveErrorType(error: any): SaveErrorType {
    let type: SaveErrorType | undefined;

    if (error && typeof error.message === 'string') {
      const lowerCaseMsg = error.message.toLowerCase();

      if (lowerCaseMsg.includes('timeout')) {
        type = SaveErrorType.Timeout;
      } else if (lowerCaseMsg.includes('unauthorized')) {
        type = SaveErrorType.Unauthorized;
      }
    } else if (error && error.code === ModelErrorCode.NameExisted) {
      type = SaveErrorType.NameAlreadyExists;
    }

    if (!type) {
      type = SaveErrorType.Unknown;
    }

    return type;
  }

  /**
   * 通过id和模型类型加载项目
   * @param params
   * @returns
   */
  public async load(params: { id: number }): Promise<void> {
    const { id } = params;

    const { editType, parentType } = store.getState().app;

    const { projectFileHash, modelName, modelType, creativeMode } =
      await apis.model.getModelDetailUsingGet(id, { timeout: LOAD_TIMEOUT });

    if (creativeModeToEditTypeMap[creativeMode] !== editType) {
      throw new Error(
        `cannot load model creative ${creativeMode} in edit ${editType}`,
      );
    }

    if (
      [ModelType.ExtensionLib, ModelType.Project].includes(modelType) &&
      parentType !== 'engine'
    ) {
      throw new Error('cannot load project model outside game');
    }

    await this.loadProjectFile({
      projectFileHash,
      projectName: modelName,
    });

    store.dispatch(setProjectId(id));
    store.dispatch(setProjectType(modelType));
  }

  /**
   * 存储当前作品，如果当前id有效，更新作品，否则创建新作品。
   */
  public async saveProject(params: SaveProjectParams): Promise<SaveResult> {
    const { autoSave } = params;

    const { projectId, projectType: modelType } = store.getState().app;

    const saveResult = await this.save({
      id: projectId,
      modelType,
      autoSave,
    });

    const { isSuccess, result } = saveResult;

    if (isSuccess) {
      if (projectId === 0) {
        store.dispatch(setProjectId(result.modelResp.modelId));
        if (typeof window !== 'undefined') {
          const url = new URL(window.location.href);
          url.searchParams.set('modelId', String(result.modelResp.modelId));
          window.history.replaceState({}, '', url);
        }
      }

      this.diffTool.setSnapshot({
        projectData: result.projectData,
        projectName: store.getState().app.projectName,
      });
    }

    return saveResult;
  }

  /**
   * 加载工程文件
   * @param projectFileHash
   */
  public async loadProjectFile(params: {
    projectFileHash: string;
    projectName: string;
  }) {
    const { projectFileHash, projectName } = params;

    const { data: buffer } = await apis.content.request<Uint8Array>({
      url: projectFileHash,
      responseType: 'arraybuffer',
      timeout: LOAD_TIMEOUT,
    });

    const projectData = migrateProject(new Uint8Array(buffer));
    if (!projectData) {
      console.error('Failed to load project data');
      return;
    }

    this.loadData(projectData, projectName);
  }

  /**
   * 从本地工程文件载入一个可继续编辑的新工程。
   * 导入后清除原模型 ID，避免后续保存覆盖导出方或当前已打开的模型。
   */
  public loadImportedProject(projectData: ProjectData, projectName: string) {
    this.loadData(projectData, projectName);
    store.dispatch(setProjectId(0));

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('modelId');
      window.history.replaceState({}, '', url);
    }
  }

  public async loadDefaultProject() {
    const project = await this.getDefaultProject();
    this.loadData(project, DEFAULT_PROJECT_NAME);
  }

  private async getDefaultProject(): Promise<ProjectData> {
    let originProject: ProjectDataTypes;

    const { editType } = store.getState().app;

    if (editType === EditType.Skin) {
      const value = await import('./avatar.json');

      originProject = projectV5.ProjectDataV5Schema.fromJSON(value.default);
      const bytes = projectSchemaToBytes(originProject);

      const latestProject = migrateProject(bytes);

      if (latestProject) {
        return latestProject;
      }

      console.error('Failed to load default project data');
    }

    return DEFAULT_PROJECT;
  }

  /**
   * 获取工程的历史版本
   */
  public async getSnapshotList(params: {
    id?: number;
    autoSave?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelSnapshotResp[] | undefined> {
    const { id, autoSave = false, signal } = params;

    const projectId = id === undefined ? store.getState().app.projectId : id;

    // 如果尚未保存过，则不获取历史版本列表
    if (projectId === 0) {
      return [];
    }

    let snapshots: ModelSnapshotResp[] | undefined;

    try {
      snapshots = await apis.model.getSnapshotsUsingGet(
        projectId,
        {
          autoSave,
        },
        { signal },
      );
    } catch (err) {
      // TODO: 错误处理
      return;
    }

    return snapshots;
  }

  /**
   * 查找首个部件节点
   * @param nodeId 起点的节点id
   * @param hierarchyData
   * @returns
   */
  private getFirstSkinPartNode(nodeId: string, hierarchyData: HierarchyData) {
    let firstSkinPartNodeId: string | undefined;

    everyNode(nodeId, hierarchyData, ({ id }) => {
      const skinNode = this.animatorApp.nodeManager.getSkinNode(id);

      if (skinNode && isSkinPart(skinNode)) {
        firstSkinPartNodeId = id;

        return false;
      }

      return true;
    });

    return firstSkinPartNodeId;
  }
}
