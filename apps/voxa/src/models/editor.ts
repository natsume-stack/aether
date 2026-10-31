import { nanoid } from 'nanoid';
import type { IntlShape } from 'react-intl';
import EventEmitter from 'events';
import type { Regl } from '@box/regl';
import { ContentType, ModelType, Permissions } from '@box/apis';
import { Toast, Modal } from '@box/box-design';
import {
  AppMode,
  LaunchState,
  PointerAction,
  setAppMode,
  setEditingSkinPartId,
  setEditingVoxelId,
  setLaunchState,
  setParentType,
  SaveState,
  setSaveState,
  setPublishing,
  setProjectId,
  setProjectType,
  setEditType,
  EditType,
  setSourceMapId,
  setProfilerEnabled,
  setEditLock,
} from '../redux/app-slice';
import { store } from '../redux/store';
import { AnimatorApp } from './animator-app';
import { MotionPlayer } from './motion-player';
import { VoxelApp } from './voxel-app';
import { EditingHistory } from './editing-history';
import { Stage } from './stage';
import { ProjectManager } from './project';
import { IframeTool } from './iframe';
import type {
  GetScreenshot,
  RestoreEditingState,
  StashEditingState,
  SwitchToAnimator,
  SwitchToVoxel,
  ManualSaveParams,
  AutoSaveBeforePublishParams,
} from './interfaces';
import type { CameraSnapshot } from './rendering/camera/base';
import type { VoxelModelProp } from './voxel-app/voxel-manager';
import { SelectBox } from './select-box';
import { getQueryValue } from '../utils/url';
import { Palette } from './palette';
import type { IEvents } from './events/interface';
import { isMetaKeyPressed } from '../utils';
import { apis } from '../apis';
import { clientConfig } from '../config/client';
import { setPermissions } from '../redux/permission-slice';
import type { IResult } from './result/interfaces';
import { GLTFTool } from './file-tools/gltf';
import { VoxTool } from './file-tools/vox';
import {
  AnimatorMode,
  PivotMode,
  ProjectNodeType,
} from '../redux/animator-slice';
import { AIModel } from './ai-model';
import { ShapELoader } from './shap-e-loader';
import { ROOT_SKIN_ID } from '../defs';
import { everyNode } from './animator-app/util';
import { SkinPart } from './skin-part';
import { isSkinPart } from './animator-app/util';
import { SaveErrorType } from './project/defs';
import { Loader } from '../common/loader';
import { Scene } from './rendering/objects/scene';
import {
  DIMENSION_CAMERA_DIR,
  serializeVec3,
  voxelShapeToObjSize,
} from '../utils/math';
import { VoxaProfiler } from './profiler';
import { startEditSession, type EditSession } from '../utils/edit-session';
import { getEditActor } from '../utils/edit-lock';

export type VoxelEditorOptions = {
  regl: Regl;
};

export class VoxelEditor {
  private intl: IntlShape | undefined;

  public readonly events: IEvents;

  public readonly stage: Stage;

  /**
   * 当前执行的渲染函数。随着appMode切换。
   */
  private renderFn: () => void = () => undefined;

  /**
   * 恢复编辑状态的暂存函数
   */
  private restoreEditingStateFns?: (() => void)[];

  public readonly voxelApp: VoxelApp;

  public readonly animatorApp: AnimatorApp;

  public readonly motionPlayer: MotionPlayer;

  public readonly selectBox: SelectBox;

  public readonly projectManager: ProjectManager;

  public readonly iframeTool: IframeTool;
  /**
   * 发生切换时的摄像机快照，用于还原animator的视角
   */
  private cameraSnapshot: CameraSnapshot;

  public readonly history: EditingHistory;

  public readonly palette: Palette;

  public readonly voxTool: VoxTool;

  public readonly shapELoader: ShapELoader;

  public readonly gltfTool: GLTFTool;

  public readonly aiModel: AIModel;

  private readonly modelLoader: Loader;

  public readonly profiler: VoxaProfiler;

  private editSession?: EditSession;

  constructor(options: VoxelEditorOptions) {
    const { regl } = options;

    this.events = new EventEmitter();

    this.stage = new Stage({ regl });

    this.history = new EditingHistory();

    this.voxelApp = new VoxelApp({
      regl,
      history: this.history,
      stage: this.stage,
      events: this.events,
      getIntl: this.getIntl,
      getSkinPart: this.getSkinPart,
    });

    this.profiler = new VoxaProfiler();

    this.animatorApp = new AnimatorApp({
      history: this.history,
      stage: this.stage,
      voxelManager: this.voxelApp.voxelManager,
      switchToVoxel: this.switchToVoxel,
      events: this.events,
      profiler: this.profiler,
    });

    this.motionPlayer = new MotionPlayer({
      events: this.events,
      history: this.history,
      animatorApp: this.animatorApp,
    });

    this.palette = new Palette({
      history: this.history,
      voxelApp: this.voxelApp,
      animatorApp: this.animatorApp,
    });

    this.voxTool = new VoxTool({
      voxelApp: this.voxelApp,
      animatorApp: this.animatorApp,
      palette: this.palette,
      history: this.history,
      stage: this.stage,
      switchToAnimator: this.switchToAnimator,
      getIntl: this.getIntl,
    });

    this.shapELoader = new ShapELoader({
      palette: this.palette,
      voxelApp: this.voxelApp,
      history: this.history,
    });

    this.selectBox = new SelectBox({
      stage: this.stage,
      voxelApp: this.voxelApp,
      animatorApp: this.animatorApp,
    });

    this.projectManager = new ProjectManager({
      voxelApp: this.voxelApp,
      animatorApp: this.animatorApp,
      history: this.history,
      palette: this.palette,
      events: this.events,
      getScreenshot: this.getScreenshot,
      switchToAnimator: this.switchToAnimator,
      switchToVoxel: this.switchToVoxel,
      stashEditingState: this.stashEditingState,
      restoreEditingState: this.restoreEditingState,
    });

    this.iframeTool = new IframeTool({
      project: this.projectManager,
      manualSave: this.manualSave,
    });

    this.gltfTool = new GLTFTool({ project: this.projectManager });

    this.cameraSnapshot = this.stage.getCamera().getSnapshot();

    this.history.registerActionCallback('setAppMode', () => {
      const { mode, editingSkinPartId } = store.getState().app;

      if (mode === AppMode.Animator) {
        this.toAnimator();
      } else if (editingSkinPartId) {
        this.toVoxel(editingSkinPartId);
      }
    });

    this.events.addListener('abort', () => {
      this.stage.setPointerAction(PointerAction.Idle);
    });

    this.toggleEventListeners(true);

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        void this.editSession?.close();
      });
    }

    this.switchToAnimator();

    this.aiModel = new AIModel();

    this.modelLoader = new Loader({ regl: regl });
  }

  private getSkinPart = (id: string) => {
    const skinPart = this.animatorApp.nodeManager.getSkinNode(id);
    if (!skinPart || !isSkinPart(skinPart)) {
      return;
    }
    return skinPart;
  };

  public setIntl(intl: IntlShape) {
    this.intl = intl;
  }

  public getIntl = () => {
    return this.intl;
  };

  public render() {
    this.renderFn();
  }

  private toVoxel(editingSkinPartId: string) {
    const { hierarchyData } = store.getState().animator;
    const node = hierarchyData[editingSkinPartId];
    const skinPart =
      this.animatorApp.nodeManager.getSkinNode(editingSkinPartId);

    if (
      node.type !== ProjectNodeType.SkinPart ||
      !skinPart ||
      !isSkinPart(skinPart)
    ) {
      return;
    }

    // 清空animator状态，关闭事件
    this.animatorApp.nodeManager.setActiveIds([], false);
    this.animatorApp.disable();

    // 记录animator的摄像机快照
    this.cameraSnapshot = this.stage.getCamera().getSnapshot();

    // 开启voxel事件
    this.voxelApp.enable();

    let editingVoxelId: string;

    const { size } = skinPart.skinPartBox.geometry;
    let voxelModel: VoxelModelProp;
    if (node.voxelId) {
      // 如果有voxel id
      // 加载已有voxel模型
      voxelModel = this.voxelApp.voxelManager.loadModel(
        node.voxelId,
        serializeVec3(size),
      );

      editingVoxelId = node.voxelId;
    } else {
      // 如果没有voxel id
      // 新建voxel模型，并更新当前蒙皮对应的模型ID
      const newVoxelId = nanoid();
      voxelModel = this.voxelApp.voxelManager.loadModel(
        newVoxelId,
        serializeVec3(size),
      );
      this.animatorApp.nodeManager.updateSkinPart(
        editingSkinPartId,
        {
          voxelId: newVoxelId,
        },
        false,
      );

      editingVoxelId = newVoxelId;
    }

    this.stage.resetCamera({
      cameraDir: DIMENSION_CAMERA_DIR[voxelModel.dimension],
    });

    this.voxelApp.pointer.update();

    this.voxelApp.setModelBackground(skinPart, [
      this.animatorApp.nodeManager.skinManager.skin,
      this.animatorApp.nodeManager.boneManager.rootBone,
    ]);

    this.renderFn = () =>
      this.stage.renderer.render(this.voxelApp.scene, this.stage.getCamera());

    return editingVoxelId;
  }

  private toAnimator() {
    const { app } = store.getState();
    const { editingSkinPartId } = app;

    this.animatorApp.scene.add(
      this.animatorApp.nodeManager.skinManager.skin,
      this.animatorApp.nodeManager.boneManager.rootBone,
    );
    this.animatorApp.scene.updateMatrixWorld(true);

    // 从voxel中导出体素数据
    // 关闭voxel事件
    const voxelModel = this.voxelApp.voxelManager.updateEditingVoxel();
    this.voxelApp.disable();

    // 开启animator事件
    this.animatorApp.enable();

    // 还原animator的摄像机视角
    this.stage.getCamera().sync(this.cameraSnapshot);
    this.stage.orbitControls.reset();

    if (editingSkinPartId) {
      if (voxelModel) {
        const { shape } = voxelModel.voxelView;
        this.animatorApp.nodeManager.updateSkinPart(
          editingSkinPartId,
          {
            size: voxelShapeToObjSize(shape, voxelModel.dimension),
            voxelId: voxelModel.id,
          },
          false,
        );
      }
      // 重新激活animator选中状态
      // 清除正在编辑的部件
      this.animatorApp.nodeManager.setActiveIds([editingSkinPartId], false);
    }

    this.renderFn = () =>
      this.stage.renderer.render(
        this.animatorApp.scene,
        this.stage.getCamera(),
        this.animatorApp.getRenderConfig(),
      );
  }

  public switchToVoxel: SwitchToVoxel = (editingSkinPartId: string) => {
    const editingVoxelId = this.toVoxel(editingSkinPartId);
    if (editingVoxelId === undefined) {
      return;
    }

    this.history.setGroup();
    this.voxelApp.saveHistory();
    this.history.saveAction({
      action: setEditingSkinPartId(editingSkinPartId),
    });
    this.history.saveAction({
      action: setEditingVoxelId(editingVoxelId),
    });
    this.history.saveAction({ action: setAppMode(AppMode.Voxel) });
    this.history.unsetGroup();
  };

  public switchToAnimator: SwitchToAnimator = () => {
    this.toAnimator();

    this.history.setGroup();
    this.history.saveAction({ action: setAppMode(AppMode.Animator) });
    this.history.saveAction({ action: setEditingSkinPartId(undefined) });
    this.history.saveAction({ action: setEditingVoxelId(undefined) });
    this.history.unsetGroup();
  };

  /**
   * 中断操作，暂存编辑状态，以便获取正确的部件数据
   */
  public stashEditingState: StashEditingState = async () => {
    this.events.emit('abort');

    this.restoreEditingStateFns = [];

    const camera = this.stage.getCamera();

    const snapshot = camera.getSnapshot();

    this.restoreEditingStateFns.unshift(() => {
      // 恢复相机
      camera.sync(snapshot);
      this.stage.orbitControls.reset();
    });

    const { mode: appMode, editingSkinPartId } = store.getState().app;
    if (appMode === AppMode.Voxel) {
      const coverImg = await this.setCoverImg();
      this.toAnimator();

      this.restoreEditingStateFns.unshift(() => {
        editingSkinPartId && this.toVoxel(editingSkinPartId);

        if (coverImg) {
          URL.revokeObjectURL(coverImg.src);

          coverImg.remove();
        }
      });
    }

    const { mode: animatorMode } = store.getState().animator;
    if (animatorMode !== AnimatorMode.Setup) {
      const { mode: animatorMode } = store.getState().animator;
      this.animatorApp.toMode(AnimatorMode.Setup);

      this.restoreEditingStateFns.unshift(() => {
        this.animatorApp.toMode(animatorMode);
      });
    }

    const { activeIds } = store.getState().animator;
    if (activeIds.length) {
      this.animatorApp.nodeManager.clearTempGroup(activeIds);

      this.restoreEditingStateFns.unshift(() => {
        this.animatorApp.nodeManager.makeTempGroup(activeIds);
      });
    }
  };

  /**
   * 恢复被暂存的编辑状态
   */
  public restoreEditingState: RestoreEditingState = () => {
    if (this.restoreEditingStateFns) {
      this.restoreEditingStateFns.forEach((fn) => fn());

      this.restoreEditingStateFns = undefined;
    }
  };

  /**
   * 放置一个盖在canvas上的图片。
   * 在截图时会使用该图片盖住canvas，悄咪咪调整视角，重新渲染进行截图。
   * @returns 盖上去的图片文件。如果有要记得不用这个图片的时候移除
   */
  private async setCoverImg() {
    const coverImageBlob = await this.canvasToBlob();

    let coverImageUrl: string | undefined;
    let coverImg: HTMLImageElement | undefined;

    if (coverImageBlob) {
      coverImageUrl = URL.createObjectURL(coverImageBlob);

      coverImg = await this.loadCoverImg(coverImageUrl);

      if (coverImg) {
        this.stage.renderer.domElement.insertAdjacentElement(
          'afterend',
          coverImg,
        );
      }
    }
    return coverImg;
  }

  /**
   * 根据modelData渲染并截图
   */
  public getScreenshot: GetScreenshot = async (modelData, bounds) => {
    this.events.emit('abort');
    const coverImg = await this.setCoverImg();

    const scene = new Scene();

    if (modelData.meshes.length) {
      const glTexture = this.modelLoader.loadTexture(modelData.texture);
      this.modelLoader.loadNodes({
        parent: scene,
        nodes: modelData.nodes,
        glTexture,
        meshes: modelData.meshes,
      });
    }

    const camera = this.stage.getCamera();
    const snapshot = camera.getSnapshot();
    // 调整摄像机位置，看向模型中间
    this.stage.resetCamera({ max: bounds });
    this.stage.renderer.render(scene, this.stage.getCamera(), {
      postProcess: true,
      ssaoEnabled: true,
      bloomEnabled: true,
    });

    const previewImageBlob = await this.canvasToBlob();

    // 恢复相机
    camera.sync(snapshot);
    this.stage.orbitControls.reset();

    if (coverImg) {
      URL.revokeObjectURL(coverImg.src);

      coverImg.remove();
    }

    return previewImageBlob;
  };

  /**
   * 封装成异步函数的canvas.toBlob()。
   */
  private async canvasToBlob(
    options: {
      /**
       * 图片的类型，默认为image/jpeg
       */
      mime?: string;
    } = {},
  ): Promise<Blob | undefined> {
    const { mime = 'image/jpeg' } = options;

    return new Promise<Blob | undefined>((resolve) => {
      this.stage.renderer.domElement.toBlob((blob) => {
        if (!blob) {
          resolve(undefined);

          console.error('Failed to get blob of canvas');
          return;
        }

        resolve(blob);
      }, mime);
    });
  }

  private async loadCoverImg(
    url: string,
  ): Promise<HTMLImageElement | undefined> {
    const img = new Image();

    return new Promise<HTMLImageElement | undefined>((resolve) => {
      img.src = url;
      img.style.left = '0';
      img.style.top = '0';
      img.style.position = 'absolute';
      img.style.width = '100%';
      img.style.height = '100%';
      img.draggable = false;

      img.onload = () => {
        resolve(img);
      };

      // 超时也失败
      setTimeout(resolve, 100);
    });
  }

  /**
   * 根据url初始化工程
   */
  public launch = async (): Promise<IResult<undefined, string>> => {
    if (store.getState().app.launchState === LaunchState.Launching) {
      return { isSuccess: false, body: 'launching' };
    }

    store.dispatch(setLaunchState(LaunchState.Launching));

    const result = await this.launchEditor();

    if (result.isSuccess) {
      const projectId = store.getState().app.projectId;
      if (projectId > 0) this.startModelEditSession(projectId);

      store.dispatch(setLaunchState(LaunchState.Success));

      if (this.iframeTool.isInIframe()) {
        this.iframeTool.emitLoadEvent({
          isSuccess: true,
        });
      }
    } else {
      store.dispatch(setLaunchState(LaunchState.Fail));

      console.error('Editor failed to launch', result.body);

      if (this.iframeTool.isInIframe()) {
        this.iframeTool.emitLoadEvent({
          isSuccess: false,
          body: result.body,
        });
      }
    }

    return result;
  };

  private launchEditor = async (): Promise<IResult<undefined, string>> => {
    const token = getQueryValue(window.location.href, 'token');

    const parentType = getQueryValue(window.location.href, 'parentType');

    const isValidEditType = (editType: unknown) => {
      if (editType === undefined) {
        return false;
      }
      return [EditType.Normal, EditType.Skin].includes(Number(editType));
    };

    const editType = getQueryValue(window.location.href, 'editType');
    if (isValidEditType(editType)) {
      store.dispatch(setEditType(Number(editType)));
    }

    if (parentType && parentType === 'engine') {
      store.dispatch(setParentType(parentType));
    }

    // 仅在传入token时，执行update cookie的操作
    if (token) {
      try {
        await apis.openApisUser.authToCookie({ token });
      } catch (err) {
        console.error('Failed to set cookie', err);

        return {
          isSuccess: false,
          body: 'unauthorized',
        };
      }
    }

    // 先进行权限判定
    await this.updatePermissions();

    if (!store.getState().permission.edit) {
      return {
        isSuccess: false,
        body: 'notPermitted',
      };
    }

    const loadResult = await this.loadProjectOnLaunch();

    const launchState = loadResult.isSuccess
      ? LaunchState.Success
      : LaunchState.Fail;

    store.dispatch(setLaunchState(launchState));

    return loadResult;
  };

  /**
   * Holds the model edit lock and follows the revision feed for the life of
   * the tab. The engine-side CLI writes through the same API, so a human tab
   * sees those commits without a manual refresh.
   */
  private startModelEditSession(modelId: number) {
    void this.editSession?.close();
    this.editSession = startEditSession({
      modelId,
      actor: getEditActor(),
      reload: () => this.projectManager.load({ id: modelId }),
      onLock: (lock) => store.dispatch(setEditLock(lock)),
      onConflict: (lock) => {
        Toast.info({
          content: `模型正在由 ${lock.actor || '其他编辑者'} 编辑，当前只读同步`,
        });
      },
      onReloaded: (event) => {
        Toast.info({
          content: `模型已被 ${event.actor} 更新（revision ${event.revision}），已重新载入`,
        });
      },
      onError: (error) => console.error('Model edit session failed', error),
    });
  }

  public closeEditSession = async () => {
    const session = this.editSession;
    this.editSession = undefined;
    await session?.close();
    store.dispatch(setEditLock(null));
  };

  /**
   * 在启动（launch）过程中，加载作品的流程。
   */
  private async loadProjectOnLaunch(): Promise<IResult<undefined, string>> {
    const contentId = getQueryValue(window.location.href, 'contentId');

    /**
     * 如果contentId存在，仅解析contentId
     */
    if (contentId) {
      try {
        const info = await apis.openApisContent.getContentInfoByToken(
          contentId,
        );

        if (info.contentType !== 1) {
          return {
            isSuccess: false,
            body: 'invalidContentType',
          };
        }

        const { modelType, modelId, projectFileHash, modelName } =
          info.modelInfo;

        store.dispatch(setProjectId(modelId));
        store.dispatch(setProjectType(modelType));

        await this.projectManager.loadProjectFile({
          projectFileHash,
          projectName: modelName,
        });

        return { isSuccess: true };
      } catch (err) {
        console.error('Failed to get content info', err);

        return {
          isSuccess: false,
          body: 'getContentInfoError',
        };
      }
    }

    const mapId = getQueryValue(window.location.href, 'mapId');
    let parsedMapId = mapId ? Number(mapId) : undefined;

    if (parsedMapId !== undefined) {
      store.dispatch(setSourceMapId(parsedMapId));
    }

    const modelId = getQueryValue(window.location.href, 'modelId');

    let parsedModelId = modelId ? Number(modelId) : undefined;

    if (parsedModelId !== undefined) {
      try {
        await this.projectManager.load({
          id: parsedModelId,
        });

        return { isSuccess: true };
      } catch (err) {
        console.error('Load error when init', err);

        return {
          isSuccess: false,
          body: 'loadContentError',
        };
      }
    }

    const modelType = getQueryValue(window.location.href, 'modelType');
    let parsedModelType = modelType ? Number(modelType) : undefined;

    if (
      parsedModelType !== undefined &&
      [
        ModelType.Private,
        ModelType.Project,
        ModelType.Public,
        ModelType.ExtensionLib,
      ].includes(parsedModelType)
    ) {
      store.dispatch(setProjectType(parsedModelType));
    }

    await this.projectManager.loadDefaultProject();

    return { isSuccess: true };
  }

  /**
   * 手动保存作品
   * - 成功后会有Toast提示
   * - 失败时会弹出重试的弹窗
   */
  public manualSave = async (params: ManualSaveParams = {}) => {
    const {
      saveState,
      editType,
    } = store.getState().app;

    const { hierarchyData } = store.getState().animator;

    if (
      editType === EditType.Skin &&
      hierarchyData[ROOT_SKIN_ID].childrenIds?.length
    ) {
      return this.showFreeSkinPartModal();
    }

    if (saveState === SaveState.Saving) {
      return;
    }

    store.dispatch(setSaveState(SaveState.Saving));

    const { onSuccess, onFail } = params;

    const { isSuccess, result } = await this.projectManager.saveProject({
      autoSave: false,
    });

    // 手动保存流程中，不管失败还是成功，都重置回Idle，只有在自动保存中，需要设置Failed
    store.dispatch(setSaveState(SaveState.Idle));

    if (isSuccess) {
      this.showSaveSuccessToast();

      onSuccess?.({
        ...result,
      });

      return;
    }

    if (result.type === SaveErrorType.NameAlreadyExists) {
      this.showSaveSkinFailedToast();
      return;
    }

    return this.showRetrySavingModal({
      onConfirm: () => {
        return this.manualSave(params);
      },
      onCancel: onFail
        ? () =>
            onFail({
              ...result,
            })
        : undefined,
    });
  };

  /**
   * 自动保存作品，用于发布
   * - 失败后会弹出重试的弹窗
   */
  public async autoSaveBeforePublish(params: AutoSaveBeforePublishParams = {}) {
    const {
      isPublishing,
      editType,
    } = store.getState().app;
    const { hierarchyData } = store.getState().animator;

    if (isPublishing) {
      return;
    }

    if (
      editType === EditType.Skin &&
      hierarchyData[ROOT_SKIN_ID].childrenIds?.length
    ) {
      return this.showFreeSkinPartModal();
    }

    store.dispatch(setPublishing(true));

    const { onSuccess, onFail } = params;

    const { isSuccess, result } = await this.projectManager.saveProject({
      autoSave: true,
    });

    store.dispatch(setPublishing(false));

    if (isSuccess) {
      onSuccess?.({
        ...result,
      });

      return;
    }

    return this.showRetrySavingModal({
      onConfirm: () => {
        return this.autoSaveBeforePublish(params);
      },
      onCancel: onFail
        ? () =>
            onFail({
              ...result,
            })
        : undefined,
    });
  }

  /**
   * 展示手动保存成功的Toast
   */
  private showSaveSuccessToast() {
    if (!this.intl) {
      console.error('Error: this.intl is undefined');
      return;
    }
    Toast.success({
      content: this.intl.formatMessage({
        description: 'Save model successfully',
        defaultMessage: 'Successfully saved',
      }),
    });
  }

  /**
   * 展示手动保存重名儿失败的Toast
   */
  private showSaveSkinFailedToast() {
    if (!this.intl) {
      console.error('Error: this.intl is undefined');
      return;
    }
    Toast.error({
      content: this.intl.formatMessage({
        description: 'Failed to save',
        defaultMessage: 'Name is already existed, failed to save',
      }),
    });
  }

  /**
   * 展示存储失败的模态框。
   */
  private showRetrySavingModal(params: {
    onConfirm?: () => void;
    onCancel?: () => void;
  }) {
    const { onConfirm: paramConfirm, onCancel: paramCancel } = params;
    if (!this.intl) {
      console.error('Error: this.intl is undefined');
      return;
    }
    const destroy = Modal.show({
      title: this.intl.formatMessage({
        description: 'Title of failing to save model',
        defaultMessage: 'Save failed',
      }),
      content: this.intl.formatMessage({
        description: 'Content of failing to save model',
        defaultMessage: 'Please check your network connection',
      }),
      confirmText: this.intl.formatMessage({
        description: 'Retry saving model',
        defaultMessage: 'Retry',
      }),
      onConfirm: () => {
        paramConfirm?.();
        destroy();
      },
      cancelText: this.intl.formatMessage({
        description: 'Cancel retrying saving model',
        defaultMessage: 'Cancel',
      }),
      onCancel: () => {
        paramCancel?.();
        destroy();
      },
      buttonSort: 'rtl',
    });
  }

  /**
   * 展示保存定向创作皮肤时有游离部件时的模态框。
   */
  private showFreeSkinPartModal() {
    const { hierarchyData } = store.getState().animator;
    const freeSkinPartNodes: SkinPart[] = [];
    everyNode(ROOT_SKIN_ID, hierarchyData, (node) => {
      const part = this.animatorApp.nodeManager.getSkinNode(node.id);
      if (part && isSkinPart(part)) {
        freeSkinPartNodes.push(part);
      }
      return true;
    });

    if (!this.intl) {
      console.error('Error: this.intl is undefined');
      return;
    }
    const destroy = Modal.show({
      title: this.intl.formatMessage({
        description: 'Title of free skin saving',
        defaultMessage: 'Save failed',
      }),
      content: this.intl.formatMessage(
        {
          description: 'Content of free skin saving',
          defaultMessage:
            'There are {count} components without bound skeletons. Unable to save this skin.',
        },
        {
          count: freeSkinPartNodes.length,
        },
      ),
      confirmText: this.intl.formatMessage({
        description: 'Go to handle',
        defaultMessage: 'Go to handle',
      }),
      cancelText: this.intl.formatMessage({
        description: 'Cancel retrying saving model',
        defaultMessage: 'Cancel',
      }),
      // 游离部件闪烁
      onConfirm: () => {
        this.animatorApp.resetCamera();
        freeSkinPartNodes.forEach((skinPart) => skinPart.setHighlight());
        destroy();
      },
      onCancel: () => {
        destroy();
      },
      buttonSort: 'ltr',
    });
  }

  /**
   * 监听window的事件，并执行操作。
   * 比如触发快捷键操作、或者转发快捷键事件。
   */
  private toggleEventListeners(toAdd: boolean) {
    if (toAdd) {
      window.addEventListener('keydown', this.onKeyDown);
    } else {
      window.removeEventListener('keydown', this.onKeyDown);
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (
      e.target &&
      (e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement)
    ) {
      return;
    }

    // 避免掉一些坑。比如 shift + z = Z
    const key = e.key.toLowerCase();

    switch (key) {
      case 'a':
        this.onKeyADown(e);
        break;
      case 'd':
        this.onKeyDDown(e);
        break;
      case 'z':
        this.onKeyZDown(e);
        break;
      case 'backspace':
        this.onKeyBackspaceDown(e);
        break;
    }
  };

  private onKeyZDown(e: KeyboardEvent) {
    if (!isMetaKeyPressed(e)) {
      return;
    }

    // 屏蔽cmd+z触发的浏览器撤销功能
    e.preventDefault();

    const { pointerAction, motionPanel } = store.getState().app;

    // 动作播放时不能撤销重做和打断
    if (motionPanel.playing) {
      return;
    }

    // 如果需要执行打断，不进行撤销重做。
    if (pointerAction !== PointerAction.Idle) {
      this.events.emit('abort');

      return;
    }

    e.shiftKey ? this.history.redo() : this.history.undo();
  }

  private onKeyBackspaceDown(e: KeyboardEvent) {
    e.preventDefault();

    const { app, animator } = store.getState();
    /**
     * 以下场景不可触发删除
     * - 鼠标在操作（拖拽之类）中
     * - 任意中心点模式
     */
    if (
      app.pointerAction !== PointerAction.Idle ||
      animator.pivotMode !== PivotMode.None
    ) {
      return;
    }

    this.events.emit('delete');
  }

  private onKeyADown(e: KeyboardEvent) {
    if (!isMetaKeyPressed(e)) {
      return;
    }

    // 防止默认选中当前页面所有的输入框文本
    e.preventDefault();

    if (store.getState().app.pointerAction !== PointerAction.Idle) {
      return;
    }

    this.events.emit('selectAll');
  }

  private onKeyDDown(e: KeyboardEvent) {
    if (!isMetaKeyPressed(e)) {
      return;
    }

    // 屏蔽cmd+d触发的chrome添加标签功能
    e.preventDefault();

    if (store.getState().app.pointerAction !== PointerAction.Idle) {
      return;
    }

    this.events.emit('deSelect');
  }

  private async updatePermissions() {
    if (!clientConfig.toCheckPermissions) {
      store.dispatch(
        setPermissions({
          edit: true,
          editParts: true,
          editAnimations: true,
        }),
      );

      return;
    }

    try {
      const permissions = await apis.openApisAuth.checkPermission({
        permissions: [
          Permissions.UserVoxelEditor,
          Permissions.UserVoxelEditorMultiObj,
          Permissions.UserVoxelEditorMultiObjAnimation,
        ],
      });

      const edit = permissions.includes(Permissions.UserVoxelEditor);
      const editParts = permissions.includes(
        Permissions.UserVoxelEditorMultiObj,
      );
      const editAnimations = permissions.includes(
        Permissions.UserVoxelEditorMultiObjAnimation,
      );

      store.dispatch(
        setPermissions({
          edit,
          editParts,
          editAnimations,
        }),
      );
    } catch (err) {
      console.error('Failed to get permissions', err);
    }
  }

  public toggleProfiler = (enabled: boolean) => {
    // TODO 开启时，统计一遍当前已有的mesher数据

    store.dispatch(setProfilerEnabled(enabled));
  };
}
