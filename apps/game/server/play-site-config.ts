import fs from 'fs';
import path from 'path';

import { getPlayWorlds } from './play-worlds';
import type { PlayWorld } from './play-worlds';

/**
 * Play 站级配置（banner / 公告 / 分区 tab / 页脚）。
 * 存储位置：默认在 Play 地图库目录内 <BOX_PLAY_LIBRARY_PATH>/site-config.json，
 * 可用 BOX_PLAY_SITE_CONFIG_PATH 覆盖。选择库目录内而非同级：现网 compose 把
 * /app/play-worlds 作为可写 bind 卷挂载（地图导入已证明可写），而库同级的
 * /app 属于镜像文件系统、生产上可能只读。getPlayWorlds 只枚举 ID 合法且
 * isDirectory 的条目，site-config.json(.bak/.tmp) 落在库内不会被当作地图。
 * 该文件缺失时读取端必须返回结构完整的默认值；文件损坏时降级默认值并记日志，
 * 但绝不静默吞错。写入走临时文件 + rename 的原子路径，并保留上一版 .bak。
 */

export const PLAY_SITE_CONFIG_SCHEMA = 1;
export const DEFAULT_BANNER_HEIGHT_PX = 320;
export const DEFAULT_BANNER_AUTOPLAY_MS = 6000;

const MAX_BANNER_IMAGES = 12;
const MAX_TABS = 12;
const MAX_TITLE_LENGTH = 80;
const MAX_SUBTITLE_LENGTH = 160;
const MAX_TEXT_LENGTH = 300;
const MAX_LABEL_LENGTH = 40;
const MAX_PATH_LENGTH = 500;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 720;
const MIN_AUTOPLAY_MS = 2_000;
const MAX_AUTOPLAY_MS = 20_000;

const worldIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const tabKeyPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type PlaySiteBannerImageInput = {
  /** 引用已安装地图（推荐，零新文件面）：读取时解析为该地图 cover。 */
  worldId?: string;
  /** 服务器属主手填图源：仅允许站内绝对路径或 HTTPS URL（worldId 解析结果原样透出）。 */
  src?: string;
  href?: string;
  title?: string;
  subtitle?: string;
};

export type PlaySiteBannerImage = {
  src: string;
  href: string;
  title: string;
  subtitle: string;
};

export type PlaySiteTabMatch = {
  mapGroupId?: string;
  mapRole?: string;
  publicId?: string;
};

export type PlaySiteTab = {
  key: string;
  label: string;
  match: PlaySiteTabMatch;
};

export type PlaySiteConfig = {
  schema: number;
  banner: {
    images: PlaySiteBannerImageInput[];
    heightPx: number;
    autoplayMs: number;
  };
  announcement: { text: string; href: string };
  tabs: PlaySiteTab[];
  footer: { text: string };
};

/** GET /api/play-site-config 的响应形状（接口契约固定，字段不得增删改名）。 */
export type PublicPlaySiteConfig = {
  schema: number;
  banner: {
    images: PlaySiteBannerImage[];
    heightPx: number;
    autoplayMs: number;
  };
  announcement: { text: string; href: string };
  tabs: PlaySiteTab[];
  footer: { text: string };
};

function defaultTabs(): PlaySiteTab[] {
  return [{ key: 'all', label: '地图展厅', match: {} }];
}

export function defaultPlaySiteConfig(): PlaySiteConfig {
  return {
    schema: PLAY_SITE_CONFIG_SCHEMA,
    banner: {
      images: [],
      heightPx: DEFAULT_BANNER_HEIGHT_PX,
      autoplayMs: DEFAULT_BANNER_AUTOPLAY_MS,
    },
    announcement: { text: '', href: '' },
    tabs: defaultTabs(),
    footer: { text: '' },
  };
}

export function siteConfigPath(): string | null {
  const override = String(process.env.BOX_PLAY_SITE_CONFIG_PATH || '').trim();
  if (override) return path.resolve(override);
  const libraryRoot = String(process.env.BOX_PLAY_LIBRARY_PATH || '').trim();
  if (!libraryRoot) return null;
  return path.join(path.resolve(libraryRoot), 'site-config.json');
}

// ---------------------------------------------------------------------------
// 输入校验（写入端严格拒绝；读取端宽容降级，两者共用同一批断言的宽松版本）
// ---------------------------------------------------------------------------

function asTrimmedString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function assertText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label}长度不能超过 ${max} 个字符`);
  return trimmed;
}

/**
 * 站内绝对路径或 https URL。防目录穿越 / 协议注入：
 * - 必须以单个 '/' 开头（拒绝 '//evil.com' 协议相对地址）；
 * - 拒绝反斜杠、'..' 段、查询/哈希、百分号编码与除白名单外的字符；
 * - URL 仅允许 https，禁止内嵌凭据/查询/哈希（与 play-admin 资源分发校验同标准）。
 * 本模块从不按 src 读取磁盘文件，此校验面向浏览器侧消费。
 */
function validateAssetSrc(value: unknown, label: string, required: boolean): string {
  const text = assertText(value, MAX_PATH_LENGTH, label);
  if (!text) {
    if (required) throw new Error(`${label}不能为空`);
    return '';
  }
  if (text.startsWith('/')) {
    if (text.startsWith('//')) throw new Error(`${label}不能是协议相对地址`);
    if (text.includes('\\')) throw new Error(`${label}包含非法字符`);
    if (/[?#%]/.test(text)) throw new Error(`${label}不能包含查询、哈希或百分号编码`);
    if (text.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`${label}包含越权路径段`);
    }
    if (!/^\/[A-Za-z0-9@:._~-]+(\/[A-Za-z0-9@:._~-]+)*$/.test(text)) {
      throw new Error(`${label}包含非法字符`);
    }
    return text;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}必须是站内绝对路径或完整 URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}只允许站内路径或 HTTPS 地址`);
  if (url.username || url.password) throw new Error(`${label}不能包含账号凭据`);
  if (url.search || url.hash) throw new Error(`${label}不能包含查询或片段参数`);
  return text;
}

function validateHref(value: unknown, label: string): string {
  const text = assertText(value, MAX_PATH_LENGTH, label);
  if (!text) return '';
  if (text.startsWith('/')) {
    if (text.startsWith('//')) throw new Error(`${label}不能是协议相对地址`);
    if (text.includes('\\') || /[?#%]/.test(text)) throw new Error(`${label}包含非法字符`);
    if (text.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`${label}包含越权路径段`);
    }
    if (!/^\/[A-Za-z0-9@:._~-]+(\/[A-Za-z0-9@:._~-]+)*$/.test(text)) {
      throw new Error(`${label}包含非法字符`);
    }
    return text;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}必须是站内路径或完整 URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}只允许站内路径或 HTTPS 地址`);
  if (url.username || url.password) throw new Error(`${label}不能包含账号凭据`);
  if (url.search || url.hash) throw new Error(`${label}不能包含查询或片段参数`);
  return text;
}

function worldHrefFor(publicId: string): string {
  return `/p/${encodeURIComponent(publicId)}`;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number, label: string, strict: boolean): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number)) {
    if (strict) throw new Error(`${label}必须是整数`);
    return fallback;
  }
  if (number < min || number > max) {
    if (strict) throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
    return Math.min(max, Math.max(min, number));
  }
  return number;
}

// ---------------------------------------------------------------------------
// 严格规范化（写入端）与宽容降级（读取端）
// ---------------------------------------------------------------------------

type NormalizeOptions = { strict: boolean };

function normalizeBannerInputList(value: unknown, warnings: string[], options: NormalizeOptions): PlaySiteBannerImageInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (options.strict) throw new Error('banner.images 必须是数组');
    warnings.push('banner.images 不是数组，已忽略');
    return [];
  }
  if (value.length > MAX_BANNER_IMAGES) {
    if (options.strict) throw new Error(`banner 图片最多 ${MAX_BANNER_IMAGES} 张`);
    warnings.push(`banner 图片超过 ${MAX_BANNER_IMAGES} 张，已截断`);
  }
  const images: PlaySiteBannerImageInput[] = [];
  for (const entry of value.slice(0, MAX_BANNER_IMAGES)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      if (options.strict) throw new Error('banner 图片项必须是对象');
      continue;
    }
    const record = entry as Record<string, unknown>;
    const worldIdRaw = typeof record.worldId === 'string' ? record.worldId.trim() : '';
    let src = '';
    let href = '';
    try {
      src = validateAssetSrc(record.src, 'banner 图片地址', false);
      href = validateHref(record.href, 'banner 跳转链接');
    } catch (error) {
      if (options.strict) throw error;
      warnings.push(`banner 图片项被拒绝：${(error as Error).message}`);
      continue;
    }
    if (worldIdRaw && !worldIdPattern.test(worldIdRaw)) {
      if (options.strict) throw new Error('banner 引用的地图 ID 不合法');
      warnings.push(`banner 引用的地图 ID 不合法：${worldIdRaw.slice(0, 80)}`);
      continue;
    }
    if (!worldIdRaw && !src) {
      if (options.strict) throw new Error('banner 图片必须引用地图（worldId）或提供 src');
      warnings.push('banner 图片项缺少 worldId 与 src，已忽略');
      continue;
    }
    let title = '';
    let subtitle = '';
    try {
      title = assertText(record.title, MAX_TITLE_LENGTH, 'banner 标题');
      subtitle = assertText(record.subtitle, MAX_SUBTITLE_LENGTH, 'banner 副标题');
    } catch (error) {
      if (options.strict) throw error;
      warnings.push(`banner 图片项文案被拒绝：${(error as Error).message}`);
      continue;
    }
    const image: PlaySiteBannerImageInput = {};
    if (worldIdRaw) image.worldId = worldIdRaw;
    if (src) image.src = src;
    if (href) image.href = href;
    if (title) image.title = title;
    if (subtitle) image.subtitle = subtitle;
    images.push(image);
  }
  return images;
}

function normalizeTabs(value: unknown, warnings: string[], options: NormalizeOptions): PlaySiteTab[] {
  if (value === undefined || value === null) return defaultTabs();
  if (!Array.isArray(value)) {
    if (options.strict) throw new Error('tabs 必须是数组');
    warnings.push('tabs 不是数组，已回退为默认分区');
    return defaultTabs();
  }
  if (value.length > MAX_TABS) {
    if (options.strict) throw new Error(`分区最多 ${MAX_TABS} 个`);
    warnings.push(`分区超过 ${MAX_TABS} 个，已截断`);
  }
  const tabs: PlaySiteTab[] = [];
  const seenKeys = new Set<string>();
  for (const entry of value.slice(0, MAX_TABS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      if (options.strict) throw new Error('分区项必须是对象');
      continue;
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    if (!tabKeyPattern.test(key)) {
      if (options.strict) throw new Error('分区 key 只能包含小写字母、数字、下划线和连字符，长度为 1–32 个字符');
      continue;
    }
    if (seenKeys.has(key)) {
      if (options.strict) throw new Error(`分区 key 重复：${key}`);
      continue;
    }
    let label = '';
    try {
      label = assertText(record.label, MAX_LABEL_LENGTH, '分区名称');
    } catch (error) {
      if (options.strict) throw error;
      continue;
    }
    const match: PlaySiteTabMatch = {};
    const rawMatch = record.match;
    if (rawMatch !== undefined && rawMatch !== null) {
      if (typeof rawMatch !== 'object' || Array.isArray(rawMatch)) {
        if (options.strict) throw new Error('分区 match 必须是对象');
      } else {
        for (const [field, candidate] of Object.entries(rawMatch as Record<string, unknown>)) {
          if (field !== 'mapGroupId' && field !== 'mapRole' && field !== 'publicId') {
            if (options.strict) throw new Error(`分区 match 不支持字段：${field}`);
            continue;
          }
          const text = typeof candidate === 'string' ? candidate.trim() : '';
          if (!text || text.length > MAX_LABEL_LENGTH * 2) {
            if (options.strict) throw new Error(`分区 match.${field} 不合法`);
            continue;
          }
          if (field === 'mapRole' && text !== 'main' && text !== 'submap') {
            if (options.strict) throw new Error('分区 match.mapRole 只能是 main 或 submap');
            continue;
          }
          (match as Record<string, string>)[field] = text;
        }
      }
    }
    seenKeys.add(key);
    tabs.push({ key, label, match });
  }
  if (!tabs.length) {
    if (options.strict && value.length) throw new Error('至少需要一个有效分区');
    return defaultTabs();
  }
  return tabs;
}

/** 读取端与写入端共用：strict=false 时宽容降级并输出诊断信息。 */
function normalizeStoredConfig(raw: unknown, warnings: string[]): PlaySiteConfig {
  const options: NormalizeOptions = { strict: false };
  const fallback = defaultPlaySiteConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  if (record.schema !== PLAY_SITE_CONFIG_SCHEMA) {
    warnings.push(`site-config.json 的 schema=${String(record.schema)} 不受支持，已回退默认配置`);
    return fallback;
  }
  const bannerRaw = record.banner;
  const banner = bannerRaw && typeof bannerRaw === 'object' && !Array.isArray(bannerRaw)
    ? bannerRaw as Record<string, unknown>
    : {};
  if (record.banner !== undefined && !Object.keys(banner).length) warnings.push('banner 不是对象，已回退默认值');
  const announcementRaw = record.announcement;
  const announcementSource = announcementRaw && typeof announcementRaw === 'object' && !Array.isArray(announcementRaw)
    ? announcementRaw as Record<string, unknown>
    : {};
  const footerRaw = record.footer;
  const footerSource = footerRaw && typeof footerRaw === 'object' && !Array.isArray(footerRaw)
    ? footerRaw as Record<string, unknown>
    : {};
  let href = '';
  try {
    href = validateHref(announcementRaw === undefined || announcementSource.href === undefined ? '' : announcementSource.href, '公告链接');
  } catch (error) {
    warnings.push(`公告链接被拒绝：${(error as Error).message}`);
  }
  return {
    schema: PLAY_SITE_CONFIG_SCHEMA,
    banner: {
      images: normalizeBannerInputList(banner.images, warnings, options),
      heightPx: clampInteger(banner.heightPx, DEFAULT_BANNER_HEIGHT_PX, MIN_HEIGHT_PX, MAX_HEIGHT_PX, 'banner 高度', false),
      autoplayMs: clampInteger(banner.autoplayMs, DEFAULT_BANNER_AUTOPLAY_MS, MIN_AUTOPLAY_MS, MAX_AUTOPLAY_MS, 'banner 自动播放间隔', false),
    },
    announcement: {
      text: asTrimmedString(announcementSource.text, MAX_TEXT_LENGTH),
      href,
    },
    tabs: normalizeTabs(record.tabs, warnings, options),
    footer: { text: asTrimmedString(footerSource.text, MAX_TEXT_LENGTH) },
  };
}

/** 写入端严格校验：任何非法值抛出带中文原因的错误，绝不静默修正。 */
function validateStoredConfigStrict(input: unknown): PlaySiteConfig {
  const options: NormalizeOptions = { strict: true };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置内容必须是 JSON 对象');
  }
  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !['schema', 'banner', 'announcement', 'tabs', 'footer'].includes(key));
  if (unknownKeys.length) throw new Error(`不支持的配置字段：${unknownKeys.slice(0, 5).join('、')}`);
  const bannerRaw = record.banner;
  if (bannerRaw !== undefined && bannerRaw !== null && (typeof bannerRaw !== 'object' || Array.isArray(bannerRaw))) {
    throw new Error('banner 必须是对象');
  }
  const banner = (bannerRaw || {}) as Record<string, unknown>;
  const bannerKeys = Object.keys(banner).filter((key) => !['images', 'heightPx', 'autoplayMs'].includes(key));
  if (bannerKeys.length) throw new Error(`banner 不支持字段：${bannerKeys.slice(0, 5).join('、')}`);
  const announcementRaw = record.announcement;
  if (announcementRaw !== undefined && announcementRaw !== null && (typeof announcementRaw !== 'object' || Array.isArray(announcementRaw))) {
    throw new Error('announcement 必须是对象');
  }
  const announcement = (announcementRaw || {}) as Record<string, unknown>;
  const announcementKeys = Object.keys(announcement).filter((key) => !['text', 'href'].includes(key));
  if (announcementKeys.length) throw new Error(`announcement 不支持字段：${announcementKeys.slice(0, 5).join('、')}`);
  const footerRaw = record.footer;
  if (footerRaw !== undefined && footerRaw !== null && (typeof footerRaw !== 'object' || Array.isArray(footerRaw))) {
    throw new Error('footer 必须是对象');
  }
  const footer = (footerRaw || {}) as Record<string, unknown>;
  const footerKeys = Object.keys(footer).filter((key) => !['text'].includes(key));
  if (footerKeys.length) throw new Error(`footer 不支持字段：${footerKeys.slice(0, 5).join('、')}`);
  return {
    schema: PLAY_SITE_CONFIG_SCHEMA,
    banner: {
      images: normalizeBannerInputList(banner.images, [], options),
      heightPx: clampInteger(banner.heightPx, DEFAULT_BANNER_HEIGHT_PX, MIN_HEIGHT_PX, MAX_HEIGHT_PX, 'banner 高度', true),
      autoplayMs: clampInteger(banner.autoplayMs, DEFAULT_BANNER_AUTOPLAY_MS, MIN_AUTOPLAY_MS, MAX_AUTOPLAY_MS, 'banner 自动播放间隔', true),
    },
    announcement: {
      text: assertText(announcement.text, MAX_TEXT_LENGTH, '公告文本'),
      href: validateHref(announcement.href, '公告链接'),
    },
    tabs: normalizeTabs(record.tabs, [], options),
    footer: { text: assertText(footer.text, MAX_TEXT_LENGTH, '页脚文本') },
  };
}

// ---------------------------------------------------------------------------
// 读取 / 写入
// ---------------------------------------------------------------------------

type ReadResult = { config: PlaySiteConfig; existed: boolean };

function logConfigDiagnostics(configPath: string, reason: string, detail: string) {
  // 诊断日志仅落服务端控制台；HTTP 响应绝不包含路径或错误细节。
  console.error(`[play-site-config] ${configPath} ${reason}，已降级为默认配置：${detail}`);
}

function readStoredConfig(): ReadResult {
  const configPath = siteConfigPath();
  if (!configPath) return { config: defaultPlaySiteConfig(), existed: false };
  let rawText: string;
  try {
    rawText = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logConfigDiagnostics(configPath, '读取失败', `${code || '未知错误'}：${(error as Error).message}`);
    }
    return { config: defaultPlaySiteConfig(), existed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    logConfigDiagnostics(configPath, '不是合法 JSON', (error as Error).message);
    return { config: defaultPlaySiteConfig(), existed: true };
  }
  const warnings: string[] = [];
  const config = normalizeStoredConfig(parsed, warnings);
  for (const warning of warnings) {
    console.warn(`[play-site-config] ${configPath} ${warning}`);
  }
  return { config, existed: true };
}

/** 管理端视图：返回存储形态（banner 项保留 worldId 引用），永不调用失败。 */
export function getPlaySiteConfig(): PlaySiteConfig {
  return readStoredConfig().config;
}

function resolveBannerImages(
  config: PlaySiteConfig,
  worlds: PlayWorld[],
): PlaySiteBannerImage[] {
  const images: PlaySiteBannerImage[] = [];
  for (const entry of config.banner.images) {
    const world = entry.worldId
      ? worlds.find((candidate) => candidate.id === entry.worldId || candidate.publicId === entry.worldId)
      : undefined;
    // 地图 cover 与首页卡片同源（浏览器已在直接渲染 world.cover），
    // 因此这里原样透出，不施加管理端手填 src 的严格校验，避免行为回归。
    const src = entry.src || (world ? String(world.cover || '') : '');
    if (!src) continue;
    const href = entry.href || (world ? worldHrefFor(world.publicId || world.id) : '');
    const title = entry.title || (world ? String(world.name || '').slice(0, MAX_TITLE_LENGTH) : '');
    const subtitle = entry.subtitle || '';
    images.push({ src, href, title, subtitle });
  }
  return images;
}

/** 公开端点视图：契约形状，不含 worldId、路径或其他内部字段。 */
export function buildPublicPlaySiteConfig(config: PlaySiteConfig, worlds: PlayWorld[]): PublicPlaySiteConfig {
  return {
    schema: PLAY_SITE_CONFIG_SCHEMA,
    banner: {
      images: resolveBannerImages(config, worlds),
      heightPx: config.banner.heightPx,
      autoplayMs: config.banner.autoplayMs,
    },
    announcement: { text: config.announcement.text, href: config.announcement.href },
    tabs: config.tabs.map((tab) => ({ key: tab.key, label: tab.label, match: { ...tab.match } })),
    footer: { text: config.footer.text },
  };
}

export function getPublicPlaySiteConfig(): PublicPlaySiteConfig {
  return buildPublicPlaySiteConfig(getPlaySiteConfig(), getPlayWorlds());
}

/**
 * tab 过滤语义（供首页分区渲染使用）：
 * match 为空对象 = 命中全部（默认 "all" tab 即如此，与改版前行为一致）；
 * 指定字段时要求全部相等 —— mapGroupId 按“地图组解析值”比较
 * （world.mapGroupId || world.mainProjectId || world.id，与首页分组规则同一），
 * mapRole 按 main/submap，publicId 按地图公开 ID。
 */
export function worldMatchesTab(world: PlayWorld, match: PlaySiteTabMatch): boolean {
  if (match.mapGroupId !== undefined) {
    const group = String(world.mapGroupId || world.mainProjectId || world.id);
    if (group !== match.mapGroupId) return false;
  }
  if (match.mapRole !== undefined && world.mapRole !== match.mapRole) return false;
  if (match.publicId !== undefined && world.publicId !== match.publicId) return false;
  return true;
}

function mergeConfigs(current: PlaySiteConfig, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    schema: PLAY_SITE_CONFIG_SCHEMA,
    banner: { ...current.banner },
    announcement: { ...current.announcement },
    tabs: current.tabs,
    footer: { ...current.footer },
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'schema') continue;
    if (key === 'banner') {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('banner 必须是对象');
      merged.banner = { ...merged.banner as Record<string, unknown>, ...(value as Record<string, unknown>) };
    } else if (key === 'announcement') {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('announcement 必须是对象');
      merged.announcement = { ...merged.announcement as Record<string, unknown>, ...(value as Record<string, unknown>) };
    } else if (key === 'footer') {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('footer 必须是对象');
      merged.footer = { ...merged.footer as Record<string, unknown>, ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * 原子替换：Linux 下 rename 本身原子且不会失败；Windows 开发环境 / Docker Desktop
 * 绑定挂载里，另一并发读者的 copyFileSync 可能让目标短暂“busy”（EPERM/EACCES），
 * 参照 play-admin.ts removeDirectoryWithRetry 的既有做法做有界同步重试。
 * EROFS（只读卷）不重试，直接失败。
 */
function renameFileWithRetry(source: string, target: string) {
  const busyCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || '';
      if (attempt >= 3 || !busyCodes.has(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
  }
}

/**
 * 原子写入：临时文件 + rename（与 play-admin.ts 中 manifest.json 的写法一致），
 * 成功后把替换前的旧内容保留为 <config>.bak 供回滚。merge=true 为 PATCH 语义，
 * 按区块浅合并（banner.images / tabs 传入即整体替换）；merge=false 为 PUT 全量替换。
 */
export function savePlaySiteConfig(input: unknown, options: { merge: boolean }): PlaySiteConfig {
  const configPath = siteConfigPath();
  if (!configPath) {
    throw new Error('站点配置保存路径未配置，请设置 BOX_PLAY_SITE_CONFIG_PATH 或挂载 Play 地图库');
  }
  const current = readStoredConfig().config;
  const patch = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const next = validateStoredConfigStrict(options.merge ? mergeConfigs(current, patch) : patch);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temporaryPath, serialized, { mode: 0o644 });
    const backupPath = `${configPath}.bak`;
    if (fs.existsSync(configPath)) {
      // 先备份再替换；备份写失败不阻断主流程（旧版仍在原文件），仅记录。
      try {
        fs.copyFileSync(configPath, backupPath);
      } catch (error) {
        console.warn(`[play-site-config] ${configPath} 上一版备份失败：${(error as Error).message}`);
      }
    }
    renameFileWithRetry(temporaryPath, configPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EROFS' || code === 'EACCES') {
      throw new Error('站点配置目录不可写，请检查 Play 地图库挂载权限或 BOX_PLAY_SITE_CONFIG_PATH 指向的目录');
    }
    throw error;
  }
  return next;
}
