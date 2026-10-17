import type { NextApiRequest, NextApiResponse } from 'next';

const healthCheckHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  return res.status(200).json({});
};

export default healthCheckHandler;
