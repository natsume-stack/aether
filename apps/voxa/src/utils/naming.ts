/**
 * 自动增量生成名字的方法。会补位。
 * @param root 名字的本体
 * @param lookup 查找重名的数组
 * @param isNotDuplicate 判断名字不重名的条件
 * @param initialInc 初始的增量值，默认从0开始计算。
 */
export function incrementalNaming<T>(
  root: string,
  lookup: (T | undefined)[],
  isNotDuplicate: (val: T, newName: string) => boolean,
  initialInc: number = 0,
) {
  let inc = initialInc;
  let name = inc === 0 ? root : `${root}-${inc}`;

  const arr = lookup.slice();

  while (arr.length) {
    const idx = arr.findIndex((val) => !!val && !isNotDuplicate(val, name));

    if (idx < 0) {
      break;
    }

    arr.splice(idx, 1);

    inc++;

    name = `${root}-${inc}`;
  }

  return name;
}

export const ROOT_NAME = 'Root';
export const PALETTE_GROUP_NAME = 'Group';

export const ROOT_SKIN_NAME = 'Root';
export const SKIN_PART_GROUP_NAME = 'Group';
export const SKIN_PART_NAME = 'Object';

export const ROOT_BONE_NAME = 'Root';
export const BONE_NAME = 'Bone';

export const MOTION_NAME = 'Motion';
