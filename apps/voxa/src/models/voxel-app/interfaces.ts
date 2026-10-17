import type { Actions, EditingMode } from '@box/utils/helper';
import type { vec3 } from 'gl-matrix';
import type { VoxelView } from '@box/utils/voxel';
import type { AxisType } from '@box/box-design';
import type { VoxelDimensionType } from '../project/interfaces';

export type SetTool = (options: {
  toolType?: Actions;
  mode?: EditingMode;
}) => void;

/**
 * 调整模型空间大小，更新空间内模型，更新编辑器内的组件样式。
 * @param spaceSize 新空间大小
 * @param clearEditing 是否清理editing voxels 默认为true
 * @returns boolean 是否执行了改变
 */
export type UpdateSpaceSize = (
  spaceSize: vec3,
  clearEditing?: boolean,
) => boolean;

export type ApplyVoxels = (
  voxels: VoxelView[],
  dimension?: VoxelDimensionType,
) => void;

/**
 * 色板索引表，key是当前指向的颜色，value是需要更新的颜色
 * - 加载工程体素数据时，可能需要更新记录的颜色索引
 */
export type PaletteDict = Record<number, number>;

export const INDEX_TO_AXIS: { [key: number]: AxisType } = {
  0: 'X',
  1: 'Y',
  2: 'Z',
};
