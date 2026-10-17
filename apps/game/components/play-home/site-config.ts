/**
 * play 首页「站级展示配置」的读取与归一化（D1 泳道）。
 *
 * 接口契约（由 D2 泳道提供服务端实现，本文件只消费）：
 *   GET /api/play-site-config   公开只读，返回不含任何密钥的 JSON
 *   { schema: 1,
 *     banner: { images: [{ src, href, title, subtitle }], heightPx, autoplayMs },
 *     announcement: { text, href },
 *     tabs: [{ key, label, match }],
 *     footer: { text } }
 *
 * 兜底原则（兼容底线）：配置缺失、404、非 JSON、字段类型错误、schema 不认识——
 * 一律返回 null，由首页退回「无 banner、无 tab」的纯地图列表，绝不抛错。
 *
 * 首屏配置由 index.tsx 的 getServerSideProps 直接取（banner 不迟到、不顶版）；
 * 本模块的 loadPlaySiteConfig 是 SSR 没拿到时的兜底通道（走公开端点）。
 *
 * 为什么兜底用 globalThis.fetch 而不是 @box/apis 的生成客户端：
 * scripts/platform-api-removal.test.js 规定 apps/game/pages/index.tsx 内
 * 不得出现任何 fetch 调用（必须走 ApiClient），而生成的 ApiClient 归上游维护，
 * 因此把这一处只读请求收敛到本组件目录内，路径与错误处理都在这里闭环。
 */
import type { PlayWorld } from '../../server/play-worlds';

export const PLAY_SITE_CONFIG_PATH = '/api/play-site-config';

export type PlayBannerImage = {
  src: string;
  href: string;
  title: string;
  subtitle: string;
};

export type PlaySiteTab = {
  key: string;
  label: string;
  match: Record<string, unknown>;
};

export type PlaySiteConfig = {
  schema: number;
  banner: {
    images: PlayBannerImage[];
    heightPx: number;
    autoplayMs: number;
  };
  announcement: { text: string; href: string };
  tabs: PlaySiteTab[];
  footer: { text: string };
};

/** 首页地图组的最小形状（与 index.tsx 的 worldGroups 元素结构一致）。 */
export type PlayGroupEntry = {
  groupId: string;
  main: PlayWorld;
  submaps: PlayWorld[];
};

const SUPPORTED_SCHEMA = 1;
// 上下界与 D2 的服务端规范化保持一致（apps/game/server/play-site-config.ts）：
// heightPx 120–720、autoplayMs 2000–20000、默认 320 / 6000、图片与 tab 各 ≤12、
// title ≤80、subtitle ≤160、公告 ≤300、tab 标签 ≤40。客户端再夹一次纯属防御，
// 绝不把服主选的高度截成另一个值。
const BANNER_HEIGHT_DEFAULT = 320;
const BANNER_HEIGHT_MIN = 120;
const BANNER_HEIGHT_MAX = 720;
const AUTOPLAY_DEFAULT_MS = 6000;
const AUTOPLAY_MIN_MS = 2000;
const AUTOPLAY_MAX_MS = 20000;
const MAX_BANNER_IMAGES = 12;
const MAX_TABS = 12;
const MAX_TITLE_LENGTH = 80;
const MAX_SUBTITLE_LENGTH = 160;
const MAX_TEXT_LENGTH = 300;
const MAX_LABEL_LENGTH = 40;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 跳转地址：站内绝对路径（/p/<publicId>）或 https URL——与 D2 的 validateHref 同标准。
 * 拒绝 javascript:/data:/http: 明文与 //host 协议相对地址，
 * 避免配置被写入后变成跳转注入点。
 */
function asSafeHref(value: unknown): string {
  const href = asText(value);
  if (!href) return '';
  if (href.startsWith('/')) {
    if (href.startsWith('//')) return '';
    if (/^\/\\/.test(href)) return '';
    return href;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return href;
  } catch {
    return '';
  }
}

function asCappedText(value: unknown, max: number): string {
  return asText(value).slice(0, max);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function normalizeBannerImages(value: unknown): PlayBannerImage[] {
  return asList(value)
    .slice(0, MAX_BANNER_IMAGES)
    .flatMap((entry) => {
      const item = asRecord(entry);
      const src = asText(item.src);
      if (!src) return [];
      return [
        {
          src,
          href: asSafeHref(item.href),
          title: asCappedText(item.title, MAX_TITLE_LENGTH),
          subtitle: asCappedText(item.subtitle, MAX_SUBTITLE_LENGTH),
        },
      ];
    });
}

/**
 * 把任意响应体归一化成可信形状；不认识或缺失时返回 null。
 * 纯函数，不触网，方便静态走查与后续补测。
 */
export function normalizePlaySiteConfig(raw: unknown): PlaySiteConfig | null {
  const root = asRecord(raw);
  if (!Object.keys(root).length) return null;
  const schema = clampNumber(root.schema, 0, 0, Number.MAX_SAFE_INTEGER);
  if (schema !== SUPPORTED_SCHEMA) return null;

  const banner = asRecord(root.banner);
  const announcement = asRecord(root.announcement);
  const footer = asRecord(root.footer);
  const tabs = asList(root.tabs)
    .slice(0, MAX_TABS)
    .flatMap((entry) => {
      const tab = asRecord(entry);
      const label = asCappedText(tab.label, MAX_LABEL_LENGTH);
      if (!label) return [];
      return [
        {
          key: asText(tab.key) || label,
          label,
          match: asRecord(tab.match),
        },
      ];
    });

  return {
    schema,
    banner: {
      images: normalizeBannerImages(banner.images),
      heightPx: clampNumber(banner.heightPx, BANNER_HEIGHT_DEFAULT, BANNER_HEIGHT_MIN, BANNER_HEIGHT_MAX),
      autoplayMs: clampNumber(banner.autoplayMs, AUTOPLAY_DEFAULT_MS, AUTOPLAY_MIN_MS, AUTOPLAY_MAX_MS),
    },
    announcement: {
      text: asCappedText(announcement.text, MAX_TEXT_LENGTH),
      href: asSafeHref(announcement.href),
    },
    tabs,
    footer: { text: asCappedText(footer.text, MAX_TEXT_LENGTH) },
  };
}

/** 拉取站级配置；任何失败都只影响 banner/tab，不阻塞地图列表。 */
export async function loadPlaySiteConfig(signal?: AbortSignal): Promise<PlaySiteConfig | null> {
  try {
    const response = await globalThis.fetch(PLAY_SITE_CONFIG_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    return normalizePlaySiteConfig(await response.json());
  } catch {
    return null;
  }
}

/** 配置里是否真的有需要渲染的区块（全空时首页壳层保持改版前形态）。 */
export function hasPlaySiteHero(config: PlaySiteConfig | null): boolean {
  if (!config) return false;
  return Boolean(
    config.banner.images.length || config.announcement.text || config.tabs.length,
  );
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function haystackOf(group: PlayGroupEntry): string {
  return [group.main.name, group.main.author, group.main.description, group.main.version]
    .join(' ')
    .toLowerCase();
}

const KEYWORD_MATCH_KEYS = ['keyword', 'keywords', 'query', 'tag', 'tags'] as const;

/**
 * tab.match 的判定语义**逐条对齐** D2 的服务端实现
 * （apps/game/server/play-site-config.ts 的 worldMatchesTab）：
 *   - mapGroupId：按“地图组解析值”比较，即 world.mapGroupId || mainProjectId || id；
 *     首页的 group.groupId 正是用同一条规则算出来的，所以这里直接比 group.groupId；
 *   - mapRole：按 main / submap；
 *   - publicId：按地图公开 ID；
 *   - 键缺省（undefined）不参与判定，空 match = 命中全部（默认 “地图展厅” tab）。
 * 额外支持 keyword/tags 的子串匹配；其余未知键一律忽略——
 * 「忽略未知键」是刻意的：匹配维度将来扩充时，最坏情况是该 tab 退化成「全部」，
 * 绝不允许出现整块列表被清空。
 */
export function groupMatchesPlaySiteTab(
  group: PlayGroupEntry,
  match: Record<string, unknown>,
): boolean {
  const entries = Object.entries(asRecord(match));
  if (!entries.length) return true;

  for (const [key, expected] of entries) {
    if (key === 'mapGroupId') {
      if (expected !== undefined && group.groupId !== asText(expected)) return false;
      continue;
    }
    if (key === 'mapRole') {
      if (expected !== undefined && group.main.mapRole !== asText(expected)) return false;
      continue;
    }
    if (key === 'publicId') {
      if (expected !== undefined && group.main.publicId !== asText(expected)) return false;
      continue;
    }
    if ((KEYWORD_MATCH_KEYS as readonly string[]).includes(key)) {
      const words = (Array.isArray(expected) ? expected : [expected]).map(textOf).filter(Boolean);
      if (!words.length) continue;
      const haystack = haystackOf(group);
      if (!words.some((word) => haystack.includes(word))) return false;
      continue;
    }
    // 其余键忽略，不参与判定。
  }
  return true;
}

export function filterGroupsByPlaySiteTab(
  groups: PlayGroupEntry[],
  tab: PlaySiteTab | null,
): PlayGroupEntry[] {
  if (!tab) return groups;
  const matched = groups.filter((group) => groupMatchesPlaySiteTab(group, tab.match));
  // 匹配为空的 tab 不该把展厅关成白屏：退回全量，让用户仍能进图。
  return matched.length ? matched : groups;
}
