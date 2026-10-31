import { Scene } from './objects/scene';
import { WebGLRenderer } from './webgl-renderer';

/**
 * 背景渲染模块，外部不需要使用
 */
export class WebGLBackground {
  constructor(private renderer: WebGLRenderer) {}

  public render(scene: Scene) {
    this.renderer.clear(scene.backgroundColor);
  }
}
