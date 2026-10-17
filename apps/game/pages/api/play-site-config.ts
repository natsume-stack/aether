import type { NextApiRequest, NextApiResponse } from 'next';

import { getPublicPlaySiteConfig } from '../../server/play-site-config';

/**
 * 公开只读站级配置。返回值经服务端规范化，仅含契约字段，
 * 不包含任何路径、密钥或环境变量信息；读取端永不调用失败（缺文件/损坏均降级默认值）。
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(getPublicPlaySiteConfig());
}
