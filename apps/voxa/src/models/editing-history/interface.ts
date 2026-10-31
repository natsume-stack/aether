export interface CommonHistory<SaveData> {
  /**
   * 撤销
   */
  undo: () => void;

  /**
   * 重做
   */
  redo: () => void;

  /**
   * 清理历史记录
   */
  emptyHistory: () => void;

  /**
   * 存储历史记录，对比当前数据与上次数据变化
   * 如果发生变化，更新撤销重做栈。
   * @returns 是否发生变化
   */
  saveHistory: (data: SaveData) => boolean;
}
