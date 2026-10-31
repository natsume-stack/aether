interface Window {
  /**
   * rusty_box定制的输入框元素
   * rusty_box 定制的输入框元素
   */
  RustyInputElement?: RustyInputElement;
  /**
   * rusty_box定制的绘制gif方法
   * rusty_box 定制的 GIF 绘制方法
   */
  rustyDrawGIF?: (
    image: HTMLImageElement,
    frameIdx: number,
    x: number,
    y: number,
    width?: number,
    height?: number,
    dx?: number,
    dy?: number,
    dWidth?: number,
    dHeight?: number,
  ) => void;
  /**
   * rusty_box定制的加载音频资源方法
   * @param audioContext 音频上下文
   * @param url 音频资源地址
   * @returns 类似AudioBuffer的对象，但不是真正的AudioBuffer
   */
  rustyLoadAudio?: (
    audioContext: AudioContext,
    url: string,
  ) => Promise<AudioBuffer>;
  /**
   * rusty_box定制的FontFaceSet，相当于document.fonts
   */
  rustyFonts?: FontFaceSet;
  /**
   * rusty_box定制接口，清理资源（主动close）
   * @param resources 在rusty_box中通过op创建的资源
   */
  cleanupResources?: (resources: any[]) => void;
}

/**
 * rusty_box定制的输入框元素
 * rusty_box 定制的输入框元素
 */
interface RustyInputElement extends EventTarget {
  new (): RustyInputElement;

  readonly value: string;

  /**
   * 打开rusty_box输入框
   * @param value 输入框初始文本值
   * @param placeholder 输入框提示文本
   * @param singleLine 是否为单行输入文本
   */
  open(value: string, placeholder: string, singleLine: boolean): void;

  close(): void;
}

interface HTMLCanvasElement {
  /**
   * rusty_box定制接口，调用后才能正常进行gpu绘制
   */
  present?: () => void;
}
