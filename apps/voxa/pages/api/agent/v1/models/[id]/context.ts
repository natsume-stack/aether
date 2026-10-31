import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateVoxaAgent } from '../../../../../../server/agent-access';
import { setLocalCors } from '../../../../../../server/local-cors';
import { getBlob, getModel } from '../../../../../../server/local-voxa-store';
import { summarizeAgentModelSource } from '../../../../../../server/agent-model-context';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!setLocalCors(req,res)) return res.status(403).end();
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization');
  res.setHeader('Cache-Control','no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authenticateVoxaAgent(String(req.headers.authorization || '')).ok)
    return res.status(401).json({code:'AGENT_AUTH_REQUIRED'});
  if (req.method !== 'GET') return res.status(405).end();
  const id = Number(req.query.id);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  const limit = req.query.limit === undefined ? 128 : Number(req.query.limit);
  const paletteOffset = req.query.paletteOffset === undefined ? 0 : Number(req.query.paletteOffset);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({code:'INVALID_MODEL_ID'});
  const model = getModel(id);
  if (!model) return res.status(404).json({code:'MODEL_NOT_FOUND'});
  const blob = getBlob(model.projectFileHash);
  if (!blob) return res.status(409).json({code:'MODEL_SOURCE_MISSING'});
  try {
    return res.status(200).json({modelId:id,name:model.modelName,revision:model.revision,
      projectFileHash:model.projectFileHash,modelFileHash:model.modelFileHash,
      editorUrl:`/?modelId=${id}&editType=${model.creativeMode === 2 ? 1 : 0}`,
      ...summarizeAgentModelSource(new Uint8Array(blob.data),offset,limit,paletteOffset)});
  } catch(error) {
    const message = (error as Error).message;
    const code = ['MODEL_SOURCE_SCOPE_TOO_LARGE','MODEL_SOURCE_VERSION_UNSUPPORTED','INVALID_CONTEXT_PAGE'].includes(message)
      ? message : 'MODEL_SOURCE_INVALID';
    return res.status(422).json({code});
  }
}
