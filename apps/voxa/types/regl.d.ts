import { REGL } from '@box/regl';

// TODO Regl进仓库了，考虑后续搬过去
// TODO 顺便改下DrawConfig里depth、cull的类型
declare module '@box/regl' {
  export interface Regl {
    prop<Props extends {}>(
      name: keyof Props,
    ): DynamicVariable<Props[keyof Props]>;

    /**
     * 原版的类型会导致在attribute中使用NDArray数组时报错，但其实应该是支持的
     * 不知道为啥复制到这里以后就好了……没有任何改动
     */
    vao(
      attributes: REGL.AttributeState[] | REGL.VertexArrayOptions,
    ): REGL.VertexArrayObject;
  }

  /**
   * Shortcut for props function with types
   */
  export type ReglProps<Props extends {}> = (
    name: keyof Props,
  ) => DynamicVariable<Props[keyof Props]>;

  /**
   * 原版的类型会导致vec3数组报错，但其实应该是支持的
   * 不知道为啥复制到这里以后就好了……没有任何改动
   */
  interface VertexArrayObject extends REGL.Resource {
    (
      attributes: REGL.AttributeState[] | REGL.VertexArrayOptions,
    ): REGL.VertexArrayObject;
  }
}
