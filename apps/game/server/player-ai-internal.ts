import {beginAiExecution, recordAiExecution} from './ai-execution-ledger';
import type { NextApiRequest, NextApiResponse } from 'next';

import { isInternalIdentityRequest, resolvePlayerIdentity } from './local-player-identity';
import {
  AiProviderError,
  isAiExecutionUserActive,
  readAiExecutionPolicy,
  createAiProvider,
  deleteAiProvider,
  getAiProviderSecret,
  listAiProviders,
  markAiProviderTest,
  readAiPreferences,
  resolveAiProvider,
  updateAiProvider,
  writeAiPreference,
} from './ai-provider-store';
import { fetchProviderModels, testProviderConnection } from './ai-provider-probe';
import {limitAiProviderOperation} from './ai-provider-rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathSegments(req: NextApiRequest) {
  const value = req.query.path;
  return (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);
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

export async function handlePlayerAiInternal(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();

  // Service-to-service resolution for the edit runtime. It carries the
  // caller's user id explicitly and never accepts a browser session, so only
  // the shared internal secret can reach the decrypted key.
  const parts = pathSegments(req);
  if(parts[0]==='execution' && parts.length===1) {
    if(req.method!=='POST') return res.status(405).end();
    if(!isInternalIdentityRequest(req)) return res.status(401).end();
    try {const input=body(req);return res.status(200).json(input.runId ? await recordAiExecution(input.userId,input.runId,input.event) : await beginAiExecution(input.userId,input.scope,input.mode,{providerId:input.providerId,model:input.model}));} catch(error) {return fail(res,error);}
  }
  if (parts[0] === 'policy' && parts.length === 1) {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isInternalIdentityRequest(req)) return res.status(401).end();
    try {
      const input = body(req);
      if (!/^[1-9][0-9]{0,18}$/.test(String(input.userId || ''))) throw new AiProviderError('INVALID_USER', 'Invalid user');
      const policy = await readAiExecutionPolicy();
      return res.status(200).json({allowed: await isAiExecutionUserActive(input.userId) && policy.enabled && !policy.blockedUsers.includes(String(input.userId)) && !policy.blockedMaps.includes(String(input.mapId || ''))});
    } catch (error) { return fail(res, error); }
  }
  if (parts[0] === 'resolve') {
    if (parts.length !== 1) return res.status(404).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).end();
    }
    if (!isInternalIdentityRequest(req)) return res.status(401).json({ code: 'INTERNAL_AUTH_REQUIRED', message: '内部鉴权失败' });
    try {
      const input = body(req);
      const requestedUserId = String(input.userId || '');
      if (!/^[1-9][0-9]{0,18}$/.test(requestedUserId)) {
        return res.status(400).json({ code: 'INVALID_USER', message: 'userId 不合法' });
      }
      if (input.providerId && (typeof input.providerId !== 'string' || !UUID.test(input.providerId))) {
        throw new AiProviderError('INVALID_PROVIDER_ID', 'Invalid provider ID');
      }
      const provider = await resolveAiProvider(requestedUserId, input.providerId || undefined);
      return res.status(200).json({ success: true, provider });
    } catch (error) {
      return fail(res, error);
    }
  }

  let identity;
  try {
    identity = await resolvePlayerIdentity(req, res);
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'AUTH_REQUIRED') return res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录' });
    if (message === 'IP_BANNED' || message === 'DEVICE_BANNED' || message === 'PLAYER_BANNED') {
      return res.status(403).json({ code: message, message: '账号当前不可用' });
    }
    return res.status(503).json({ code: 'PLAYER_SERVICE_UNAVAILABLE', message: '无法验证玩家身份' });
  }
  if (identity.status !== 'active') return res.status(403).json({ code: 'PLAYER_BANNED', message: '账号当前不可用' });

  const userId = identity.userId;
  try {
    if (req.method !== 'GET') limitAiProviderOperation(String(userId), 'configure', 30);
    if (parts[2] === 'test' || parts[2] === 'models') limitAiProviderOperation(String(userId), 'probe', 10);
    if (parts[0] === 'preferences') {
      if (parts.length !== 1) return res.status(404).end();
      if (req.method === 'GET') return res.status(200).json({ success: true, preferences: await readAiPreferences(userId) });
      if (req.method === 'PUT') return res.status(200).json({ success: true, preference: await writeAiPreference(userId, body(req)) });
      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).end();
    }

    if (parts[0] !== 'providers') return res.status(404).end();
    if (parts.length === 1) {
      if (req.method === 'GET') return res.status(200).json({ success: true, providers: await listAiProviders(userId) });
      if (req.method === 'POST') return res.status(201).json({ success: true, provider: await createAiProvider(userId, body(req)) });
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).end();
    }

    const id = parts[1];
    if (!UUID.test(id)) return res.status(400).json({ code: 'INVALID_PROVIDER_ID', message: '渠道 ID 不合法' });

    if (parts.length === 2) {
      if (req.method === 'PATCH') return res.status(200).json({ success: true, provider: await updateAiProvider(userId, id, body(req)) });
      if (req.method === 'DELETE') {
        const deleted = await deleteAiProvider(userId, id);
        if (!deleted) return res.status(404).json({ code: 'AI_PROVIDER_NOT_FOUND', message: '渠道不存在' });
        return res.status(200).json({ success: true });
      }
      res.setHeader('Allow', 'PATCH, DELETE');
      return res.status(405).end();
    }

    if (parts.length === 3 && req.method === 'POST' && parts[2] === 'test') {
      const provider = await getAiProviderSecret(userId, id);
      const result = await testProviderConnection(provider, body(req).model);
      await markAiProviderTest(userId, id, result.ok ? `ok ${result.status} ${result.latencyMs}ms` : `fail ${result.status} ${result.message}`.slice(0, 200));
      return res.status(200).json({ success: true, result });
    }

    if (parts.length === 3 && req.method === 'POST' && parts[2] === 'models') {
      const provider = await getAiProviderSecret(userId, id);
      const models = await fetchProviderModels(provider);
      if (provider.owner === 'user' && models.length) {
        await updateAiProvider(userId, id, { models });
      }
      return res.status(200).json({ success: true, models });
    }

    return res.status(404).end();
  } catch (error) {
    return fail(res, error);
  }
}
