import {
  Children,
  createTool,
  EventsType,
  AuthEventType,
  ErrorType,
} from '@box/sdk';
import { ModelResp, ModelType } from '@box/apis';

import { apis, onApiUnauthorized } from '../apis';
import { store } from '../redux/store';
import { setProjectName } from '../redux/app-slice';
import type { ProjectManager } from './project';
import type { ManualSave } from './interfaces';
import type { IResult } from './result/interfaces';
import type { ModelMetaData } from './project/interfaces';

interface EmitEvents extends EventsType {
  onClickClose: {
    modelChanged: boolean;
  };
  onClickSave: {
    modelChanged: boolean;
    modelName: string;
  };
  save: {
    isSuccess: boolean;
    modelResp: ModelResp;
    modelType: ModelType;
    modelMetaData?: ModelMetaData;
  };
  publish: {
    modelId: number;
    modelName: string;
    modelPreviewFileUrl: string;
    modelType: ModelType;
  };
}

interface HandleEvents extends EventsType {
  save: {
    /**
     * 保存时，可以通过该参数更新保存的名字。
     */
    modelName?: string;
  };
  setInfo: {
    /**
     * 允许外部传入名字
     */
    modelName?: string;
  };
}

type InitParams = {
  project: ProjectManager;
  manualSave: ManualSave;
};

export class IframeTool {
  private tool = createTool<HandleEvents, EmitEvents>();

  private connection: Promise<boolean>;

  private project: ProjectManager;

  private manualSave: ManualSave;

  constructor(params: InitParams) {
    const { project, manualSave } = params;

    this.project = project;

    this.connection = this.tool
      .connect(() => {})
      .then((value) => {
        return !!value;
      });

    this.tool.eventOn('save', this.save);
    this.tool.eventOn('auth', this.onAuthEvent);
    this.tool.eventOn('setInfo', this.onSetInfo);

    this.manualSave = manualSave;

    this.interceptAxiosResponse();
  }

  /**
   * 当连接成功时，执行回调。
   */
  public ready(onReady: (tool: Children<HandleEvents, EmitEvents>) => void) {
    this.connection.then((isReady) => {
      if (isReady) {
        onReady(this.tool);
      } else {
        console.error('Iframe connection is not ready');
      }
    });
  }

  public isInIframe() {
    return this.tool.isInIframe();
  }

  /**
   * 发送点击“关闭”按钮的事件。
   * 并携带参数，用于判断当前模型是否发生变化。
   */
  public emitCloseEvent() {
    this.ready((tool) => {
      this.project.diffTool.hasChanged().then((modelChanged) => {
        tool.emitEvent('onClickClose', {
          modelChanged,
        });
      });
    });
  }

  /**
   * 发送点击“保存”按钮的事件。
   * 并携带参数，用于判断当前模型是否发生变化，以及当前模型名。
   */
  public emitSaveEvent() {
    this.ready((tool) => {
      this.project.diffTool.hasChanged().then((modelChanged) => {
        tool.emitEvent('onClickSave', {
          modelChanged,
          modelName: store.getState().app.projectName,
        });
      });
    });
  }

  /**
   * 发送编辑器“加载模型”的结果。
   */
  public emitLoadEvent(params: IResult<undefined, string>) {
    this.ready((tool) => {
      if (params.isSuccess) {
        tool.emitEvent('loaded');
      } else {
        tool.emitEvent('error', {
          type: ErrorType.LoadError,
          msg: params.body,
        });
      }
    });
  }

  /**
   * iframe中的保存方法。流程与“手动保存”一致。
   */
  private save = (params: HandleEvents['save'] = {}) => {
    const { modelName } = params;

    if (modelName) {
      store.dispatch(setProjectName(modelName));
    }

    this.manualSave({
      onSuccess: ({ modelResp, modelType, modelMetaData }) => {
        this.ready((tool) => {
          tool.emitEvent('save', {
            isSuccess: true,
            modelResp,
            modelType,
            modelMetaData,
          });
        });
      },
    });
  };

  private onAuthEvent = async (params: HandleEvents['auth']) => {
    if (params.type === AuthEventType.UpdateToken) {
      try {
        await apis.openApisUser.authToCookie({ token: params.value });
      } catch (err) {
        console.error('Failed to update token', err);
      }
    }
  };

  /** 将统一 API 客户端发现的 401 作为 unauthorized 事件发送给宿主。 */
  private interceptAxiosResponse() {
    onApiUnauthorized(() => {
      this.tool.emitEvent('auth', { type: AuthEventType.Unauthorized });
    });
  }

  public emitPublishEvent(params: EmitEvents['publish']) {
    this.tool.emitEvent('publish', params);
  }

  private onSetInfo = (params: HandleEvents['setInfo']) => {
    const { modelName } = params;

    if (modelName) {
      store.dispatch(setProjectName(modelName));

      this.project.diffTool.setSnapshotName(modelName);
    }
  };
}
