import fs from 'fs';
import path from 'path';

export type PlayWorld = {
  id: string;
  permanentMapId: string;
  publicId: string;
  name: string;
  author: string;
  description: string;
  cover: string;
  loadingCover?: string;
  version: string;
  mapGroupId: string;
  mapRole: 'main' | 'submap';
  mainProjectId: string;
  playEnabled: boolean;
  /** 可选附加字段（additive）：地图内容最后更新时间，ISO 字符串或 ''。 */
  updatedAt?: string;
  /**
   * 引擎当前没有浏览计数的存储来源，本轮不提供该字段（保持 undefined，
   * 不造假数据、不新增存储写放大）。前端按缺省隐藏。
   */
  browseCount?: number;
};

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// updatedAt 取值优先级：manifest.createdAt（发布/更新时由创作者端写入的 ISO 时间，
// 是“地图内容”真正的最后更新时间，且随游玩包携带、不受容器/挂载 mtime 误差影响）
// → manifest.json 文件 mtime（兼容没有 createdAt 的旧包）→ ''。
function resolveUpdatedAt(manifest: Record<string, unknown>, manifestPath: string): string {
  const createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt.trim() : '';
  if (createdAt && isoDatePattern.test(createdAt)) return createdAt;
  try {
    return fs.statSync(manifestPath).mtime.toISOString();
  } catch {
    return '';
  }
}

export function getPlayWorlds(): PlayWorld[] {
  const root = process.env.BOX_PLAY_LIBRARY_PATH;
  if (!root) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
      .flatMap((entry) => {
        try {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(root, entry.name, 'manifest.json'), 'utf8'),
          );
          const state = JSON.parse(
            fs.readFileSync(
              path.join(root, entry.name, 'data/project-state.json'),
              'utf8',
            ),
          );
          if (
            manifest.id !== entry.name ||
            !manifest.permissionHash ||
            state.permissionHash !== manifest.permissionHash ||
            !fs.statSync(path.join(root, entry.name, 'data/blobs')).isDirectory()
          ) {
            return [];
          }
          return [{
            id: entry.name,
            permanentMapId: String(manifest.permanentMapId || entry.name),
            publicId: idPattern.test(String(manifest.publicId || ''))
              ? String(manifest.publicId)
              : entry.name,
            name: manifest.projectName || entry.name,
            author: manifest.author || '',
            description: manifest.description || '',
            cover: manifest.cover || '',
            loadingCover: manifest.loadingCover || '',
            version: manifest.version || '',
            mapGroupId: manifest.mapGroupId,
            mapRole: manifest.mapRole,
            mainProjectId: manifest.mainProjectId,
            playEnabled: manifest.playEnabled !== false,
            updatedAt: resolveUpdatedAt(manifest, path.join(root, entry.name, 'manifest.json')),
          }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function findPlayWorld(reference: string) {
  return getPlayWorlds().find(
    (world) => world.id === reference || world.publicId === reference,
  );
}
