interface EventMap {
  /**
   * “中断操作”
   * 发出该事件后，所有监听该事件的模块自行处理中断
   */
  abort: undefined;

  /**
   * “删除”
   * 比如删除部件、删除体素。
   */
  delete: undefined;

  /**
   * “全选”
   */
  selectAll: undefined;

  /**
   * ”取消选中“
   */
  deSelect: undefined;
}

type OptionalIfUndefined<T> = undefined extends T ? [param?: T] : [param: T];

export interface IEvents {
  emit<K extends keyof EventMap>(
    type: K,
    ...[param]: OptionalIfUndefined<EventMap[K]>
  ): boolean;
  addListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ): this;
  removeListener<K extends keyof EventMap>(
    type: K,
    listener: (e: EventMap[K]) => void,
  ): this;
}
