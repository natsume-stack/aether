import type { NextApiRequest, NextApiResponse } from 'next';

import { playLibraryAdminRoute } from '../../../../server/play-library-admin-proxy';

export const config = { api: { bodyParser: false } };

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  req.query.section = 'import';
  return playLibraryAdminRoute(req, res);
}
