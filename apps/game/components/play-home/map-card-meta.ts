/**
 * 地图卡片的 dao3 风格元信息行（「7月25日 更新」 · 「9.72K 浏览」）。
 *
 * updatedAt / browseCount 是 D2 泳道按契约 additive 补到 PlayWorld 上的**可选**字段：
 * updatedAt 由 manifest.createdAt（回退 manifest.json mtime）解析，
 * browseCount 引擎侧暂无存储来源、D2 明确不提供（保持 undefined）——
 * 所以这里必须对两者都做缺失兜底：缺就不显示那一段，绝不报错、绝不让卡片消失。
 * 真实地图对象上还挂着几十个未声明自定义属性，因此只读不写、绝不 freeze/seal。
 */
import type { PlayWorld } from '../../server/play-worlds';

export type PlayWorldMeta = {
  updated: string;
  browse: string;
  /** 两个片段都缺失时为空数组，调用方据此决定整行是否渲染。 */
  parts: string[];
};

function readRaw(world: PlayWorld, key: 'updatedAt' | 'browseCount'): unknown {
  // 唯一读取入口：按开放对象读取可选字段，不做任何写入或类型收窄。
  return (world as unknown as Record<string, unknown>)[key];
}

export function formatPlayUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    // 不用 Intl.DateTimeFormat('zh-CN', {month:'numeric', day:'numeric'})：
    // 本机 Node（ICU 78.3）实测输出 "7/25" 而非 "7月25日"，各端 ICU 版本不一致会漂。
    // dao3 实测形态是「7月25日 更新」，所以直接按本地时区的月/日数字拼。
    return `${date.getMonth() + 1}月${date.getDate()}日 更新`;
  } catch {
    return '';
  }
}

export function formatPlayBrowseCount(value: unknown): string {
  if (typeof value === 'boolean' || value === null) return '';
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return '';
  if (raw >= 1_000_000) return `${(raw / 1_000_000).toFixed(2)}M 浏览`;
  if (raw >= 1_000) return `${(raw / 1_000).toFixed(2)}K 浏览`;
  return `${Math.round(raw)} 浏览`;
}

export function readPlayWorldMeta(world: PlayWorld): PlayWorldMeta {
  const updated = formatPlayUpdatedAt(readRaw(world, 'updatedAt'));
  const browse = formatPlayBrowseCount(readRaw(world, 'browseCount'));
  return { updated, browse, parts: [updated, browse].filter(Boolean) };
}
