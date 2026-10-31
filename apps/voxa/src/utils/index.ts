import { isMac } from './devices';

/**
 * 功能键是否按下。
 * mac上功能键为Command，对应metaKey属性。
 * 其他系统上功能键为Ctrl，对应ctrlKey属性。
 */
export function isMetaKeyPressed(evt: KeyboardEvent) {
  return isMac() ? evt.metaKey : evt.ctrlKey;
}
