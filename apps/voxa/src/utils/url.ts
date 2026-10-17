import { clientConfig } from '../config/client';

/**
 * 查询url中的query参数
 * @param url 地址文本
 * @param key 要查询的健
 * @returns 查询到的值文本或者undefined
 */
export function getQueryValue(url: string, key: string): string | undefined {
  const reg = new RegExp(`(^|[&?])${key}=([^&]*)(&|$)`, 'g');

  const arr = reg.exec(url);

  return arr ? arr[2] : undefined;
}

/**
 * 查询url中的query参数，返回值处理为数字
 * 如果是不合法的数字，返回undefined
 * @param url 地址文本
 * @param key 要查询的健
 * @returns 查询到的合法数字或者undefined
 */
export function getQueryValueNumber(
  url: string,
  key: string,
): number | undefined {
  const valueStr = getQueryValue(url, key);
  if (!valueStr) {
    return;
  }
  const valueNum = parseFloat(valueStr);
  return isNaN(valueNum) ? undefined : valueNum;
}

/**
 * 拼接hash生成完整的CDN地址
 */
export function getContentUrl(hash: string): string {
  return `${clientConfig.cdnPath}${hash}`;
}
