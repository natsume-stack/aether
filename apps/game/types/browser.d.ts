/// <reference path="./i18n.d.ts" />

declare module '*.css';
// 处理 Script API 的类型文件，用于在编辑器提供代码提示
declare module '*.dts';

declare module '*.otf';
declare module '*.ttf';
declare module '*.ttc';
declare module '*.woff';
declare module '*.woff2';

declare module '*.glb';
declare module '*.gltf';

// 处理 WGSL语言文件
declare module '*.wgsl' {
  const content: string;
  export default content;
}

type OrientationLockType =
  | 'any'
  | 'landscape'
  | 'landscape-primary'
  | 'landscape-secondary'
  | 'natural'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary';
interface ScreenOrientation {
  /**
   * see:
   * - https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock#orientation
   * - https://github.com/microsoft/TypeScript-DOM-lib-generator/issues/1615#issuecomment-1898849841
   */
  lock(orientation: OrientationLockType): Promise<void>;
}

/**
 * dynamic publicPath with webpack
 * see: https://webpack.js.org/guides/public-path/#on-the-fly
 */
declare let __webpack_public_path__: string;

interface HTMLElement {
  scrollIntoViewIfNeeded?: () => void;
}
