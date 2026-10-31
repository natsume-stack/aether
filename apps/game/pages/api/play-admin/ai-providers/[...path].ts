import {listAiExecutionRuns} from '../../../../server/ai-execution-ledger';
import type { NextApiRequest, NextApiResponse } from 'next';

import { authorizePlayerAdmin } from '../../../../server/player-admin-authorization';
import {
  AiProviderError,
  shareAdminAiProvider,
  readAiExecutionPolicy,
  writeAiExecutionPolicy,
  createAdminAiProvider,
  deleteAdminAiProvider,
  getAdminAiProviderSecret,
  listAdminAiProviders,
  markAdminAiProviderTest,
  setAdminDefaultAiProvider,
  updateAdminAiProvider,
} from '../../../../server/ai-provider-store';
import { fetchProviderModels, testProviderConnection } from '../../../../server/ai-provider-probe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function segments(req: NextApiRequest) {
  const value = req.query.path;
  const parts = (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);
  if (parts.length > 2) return null;
  if (parts.length === 1 && ['control','runs'].includes(parts[0])) return parts;
  if (parts.length >= 1 && !UUID.test(parts[0])) return null;
  if (parts.length === 2 && !['default', 'test', 'models','sharing'].includes(parts[1])) return null;
  return parts;
}

function body(req: NextApiRequest): Record<string, any> {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { throw new AiProviderError('INVALID_JSON', '请求体不是合法 JSON'); }
  }
  return req.body as Record<string, any>;
}

function fail(res: NextApiResponse, error: unknown) {
  if (error instanceof AiProviderError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  return res.status(500).json({ code: 'AI_PROVIDER_INTERNAL_ERROR', message: 'AI provider service failed' });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!await authorizePlayerAdmin(req, res, 'owner')) return;
  const parts = segments(req);
  if (!parts) return res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
  try {
    if(parts[0]==='runs') {
      if(req.method!=='GET') {res.setHeader('Allow','GET');return res.status(405).end();}
      return res.status(200).json({runs:await listAiExecutionRuns()});
    }
    if (parts[0] === 'control') {
      if (req.method === 'GET') return res.status(200).json(await readAiExecutionPolicy());
      if (req.method === 'PATCH') return res.status(200).json(await writeAiExecutionPolicy(body(req)));
      res.setHeader('Allow', 'GET, PATCH');
      return res.status(405).end();
    }
    if (parts.length === 0) {
      if (req.method === 'GET') return res.status(200).json({ success: true, providers: await listAdminAiProviders() });
      if (req.method === 'POST') return res.status(201).json({ success: true, provider: await createAdminAiProvider(body(req)) });
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).end();
    }
    const id = parts[0];
    if (parts.length === 1) {
      if (req.method === 'PATCH') return res.status(200).json({ success: true, provider: await updateAdminAiProvider(id, body(req)) });
      if (req.method === 'DELETE') {
        const deleted = await deleteAdminAiProvider(id);
        if (!deleted) return res.status(404).json({ code: 'AI_PROVIDER_NOT_FOUND', message: '管理员渠道不存在' });
        return res.status(200).json({ success: true });
      }
      res.setHeader('Allow', 'PATCH, DELETE');
      return res.status(405).end();
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).end();
    }
    if(parts[1]==='sharing') return res.status(200).json(await shareAdminAiProvider(id,body(req).userIds));
    if (parts[1] === 'default') {
      await setAdminDefaultAiProvider(id);
      return res.status(200).json({ success: true });
    }
    if (parts[1] === 'test') {
      const provider = await getAdminAiProviderSecret(id);
      const result = await testProviderConnection(provider, body(req).model);
      await markAdminAiProviderTest(id, result.ok ? `ok ${result.status} ${result.latencyMs}ms` : `fail ${result.status} ${result.message}`.slice(0, 200));
      return res.status(200).json({ success: true, result });
    }
    const provider = await getAdminAiProviderSecret(id);
    const models = await fetchProviderModels(provider);
    if (models.length) await updateAdminAiProvider(id, { models });
    return res.status(200).json({ success: true, models });
  } catch (error) {
    return fail(res, error);
  }
}
