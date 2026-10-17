import type { NextApiRequest, NextApiResponse } from 'next';

import { allowPlayLibraryAdmin } from '../../../server/play-admin-security';
import { getPlaySiteConfig, savePlaySiteConfig } from '../../../server/play-site-config';

/**
 * 服主管理站级配置（banner / 公告 / 分区 / 页脚）。
 * 鉴权复用 allowPlayLibraryAdmin（与 play-admin/worlds 同一套令牌与限流）。
 * GET 返回存储形态（banner 项保留 worldId 引用，便于管理端回写）；
 * PUT 全量替换、PATCH 按区块合并；写入为临时文件 + rename 原子路径并保留 .bak。
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PUT, PATCH');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ config: getPlaySiteConfig() });
    }
    return res.status(200).json({
      config: savePlaySiteConfig(req.body || {}, { merge: req.method === 'PATCH' }),
    });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
