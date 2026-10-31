import { createTool, EventsType, Children } from '@box/sdk';
import type { BodyPartName, defaultMotions } from '../defs';
import type { SkinPart } from '../skin-part';
import { apis } from '../apis';

export interface EmitEvents extends EventsType {
  loaded: undefined;
  skinLoaded: {
    isSuccess: boolean;
  };
  screenshot: {
    blob: Blob | undefined;
  };
  save: {
    skins: SkinBlob;
    screenshot: ScreenshotBlob;
  };
}

type SkinBlob = { [key in keyof typeof BodyPartName]: Blob };

export enum SuitList {
  Suit,
  Head,
  Shirt,
  Pants,
  Shoes,
}

type ScreenshotBlob = { [key in SuitList]: Blob };

export enum ScreenshotMode {
  Share,
  Avatar,
  Suit,
  Head,
  Shirt,
  Pants,
  Shoes,
}

export interface HandleEvents extends EventsType {
  loadSkin: Partial<{ [key in keyof typeof BodyPartName]: string }>;
  screenshot?: {
    /**
     * 截图模式
     * 0-分享页面
     * 1-头像
     * 2-套装
     * 3-头部
     * 4-上装
     * 5-下装
     * 6-鞋子
     * 默认为分享页面
     */
    mode?: ScreenshotMode;
  };
  playMotion: {
    /**
     * 播放表情名字
     */
    motionName: defaultMotions;
    /**
     * 播放次数。如果数字小于等于0则认为是无限循环播放
     * 默认为无限循环播放
     */
    iterations?: number;
  };
}

export class IframeTool {
  private tool = createTool<HandleEvents, EmitEvents>();
  private connection: Promise<boolean>;

  constructor(
    private skinParts: Map<string, SkinPart>,
    private getScreenshot: (mode?: ScreenshotMode) => Promise<Blob | undefined>,
    private playMotion: (
      motionName: defaultMotions,
      iterations?: number,
    ) => void,
  ) {
    this.connection = this.tool.connect(() => {});

    this.tool.eventOn('loadSkin', this.loadSkin);
    this.tool.eventOn('screenshot', this.screenshot);
    this.tool.eventOn('playMotion', (value) => {
      this.playMotion(value.motionName, value.iterations);
    });
  }

  /**
   * 当连接成功时，执行回调。
   */
  private ready(onReady: (tool: Children<HandleEvents, EmitEvents>) => void) {
    this.connection.then((isReady) => {
      if (isReady) {
        onReady(this.tool);
      } else {
        console.error('Iframe connection is not ready');
      }
    });
  }

  /**
   * 加载皮肤
   */
  private loadSkin = (params: HandleEvents['loadSkin']) => {
    const pending: Promise<void>[] = [];
    Object.keys(params).forEach((partName) => {
      const fileHash = params[partName];
      const skinPart = this.skinParts.get(partName);
      if (!skinPart || !fileHash) {
        return;
      }

      pending.push(
        new Promise((resolve, reject) => {
          apis.content
            .request({ url: fileHash, responseType: 'arraybuffer' })
            .then((res) => {
              skinPart.updateByFileData(new Uint8Array(res.data));
              resolve();
            })
            .catch(reject);
        }),
      );
    });

    Promise.allSettled(pending)
      .then(() => this.emitSkinLoaded(true))
      .catch(() => this.emitSkinLoaded(false));
  };

  /**
   * 截图
   */
  private screenshot = async (params: HandleEvents['screenshot']) => {
    const blob = await this.getScreenshot(params?.mode);
    this.ready((tool) => {
      tool.emitEvent('screenshot', { blob });
    });
  };

  private emitSkinLoaded(isSuccess: boolean) {
    this.ready((tool) => {
      tool.emitEvent('skinLoaded', {
        isSuccess,
      });
    });
  }

  public emitLoadEvent() {
    this.ready((tool) => {
      tool.emitEvent('loaded');
    });
  }

  public emitSaveEvent(params: EmitEvents['save']) {
    this.ready((tool) => {
      tool.emitEvent('save', params);
    });
  }
}
