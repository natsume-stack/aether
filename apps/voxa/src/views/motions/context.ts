import { createContext } from 'react';

export type MotionsContextType = {
  /**
   * 从store的activeIds和relativeIds解析出的骨骼id
   */
  boneIds: string[];
  /**
   * 当前面板中选中的骨骼节点id
   */
  activeBoneIds: string[];
  /**
   * 面板的高度，传递给游标，设置游标高度
   */
  height: number;
};

export const MotionsContext = createContext<MotionsContextType>({
  boneIds: [],
  activeBoneIds: [],
  height: 0,
});
