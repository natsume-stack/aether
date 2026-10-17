import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    apiVersion: 'v1',
    engineVersion: process.env.BOX_IMAGE_TAG || '0.2.0',
    serverInstanceId: process.env.BOX_CREATOR_INSTANCE_ID || 'local-engine',
    issuer: process.env.BOX_CREATOR_ISSUER || process.env.BOX_WEB_ORIGIN || 'local-engine',
    deploymentMode: process.env.BOX_DEPLOYMENT_MODE || 'local',
  });
}
