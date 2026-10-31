import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import { getLocalProjectManager } from '../../../server/local-project-manager';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, req.method === 'PATCH' ? 'projects.edit' : 'projects.view')) return;
  const manager = getLocalProjectManager();
  try {
    if (req.method === 'GET') {
      // The manager intentionally returns only a boolean for the secret.
      return res.status(200).json({ configuration: manager.getAssetDistributionConfiguration() });
    }
    if (req.method === 'PATCH') {
      return res.status(200).json({
        configuration: manager.saveAssetDistributionConfiguration(req.body || {}),
      });
    }
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
