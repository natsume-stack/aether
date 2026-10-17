export const DEFAULT_PROJECT_NAME = 'New-model';
export const DEFAULT_SPACE_SIZE: [number, number, number] = [40, 40, 40];

export const DEFAULT_GROUP_ID = 'default';
export const ROOT_ID = 'ROOT';
export const ROOT_BONE_ID = 'ROOT_BONE';
export const ROOT_SKIN_ID = 'ROOT_SKIN';

export const MAX_STRING_LENGTH = 64;

// 长按间隔
export const LONG_PRESS_DURATION = 300;

/**
 * 命名的最大长度。适用于作品名称、动作名称。
 */
export const MAX_NAME_LENGTH = 32;

/**
 * 是否是合法的名称。适用于项目名称、动作名称。
 */
export function isValidName(text: string) {
  // 不允许输入连续空格
  if (text.match(/\s{2,}/g)) {
    return false;
  }

  // 命名中允许使用的字符：中文、大小写英文、数字、空格和部分符号
  const validName = new RegExp(
    "^[\\p{Unified_Ideograph}\\w_ ()'（）-]+$",
    'gu',
  );
  return validName.test(text);
}

/**
 * 最小的体素模型的单边长度
 */
export const MIN_VOXEL_SIZE = 1;

/**
 * 最大的体素模型的单边长度
 */
export const MAX_VOXEL_SIZE = 255;
