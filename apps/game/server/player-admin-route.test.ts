import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  authorizePlayerAdmin,
  sendPlayerAdminApiError,
  type PlayerAdminActor,
} from './player-admin-authorization';
import { PlayerAdminRequestError } from './player-admin-errors';
import { createPlayerAdminRoute } from './player-admin-route';

function request(method = 'GET', values: Partial<NextApiRequest> = {}) {
  return {
    method,
    headers: { host: '127.0.0.1:3125' },
    query: {},
    body: {},
    ...values,
  } as NextApiRequest;
}

function response() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: jest.fn((name: string, value: string) => {
      headers.set(name, value);
      return res;
    }),
    status: jest.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    send: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    end: jest.fn(() => res),
  };
  return { res: res as unknown as NextApiResponse, state: res, headers };
}

const actor: PlayerAdminActor = {
  actor: 'admin:test',
  actorDisplayName: '测试管理员',
  actorRole: 'admin' as const,
  actorPermissions: ['players.view' as const],
  subjectId: '550e8400-e29b-41d4-a716-446655440000',
  credential: 'account' as const,
  ip: '127.0.0.1',
  userAgent: 'jest',
  deviceHash: '',
};

function authorization(result: PlayerAdminActor | null) {
  return jest.fn(async (..._args: Parameters<typeof authorizePlayerAdmin>) => result);
}

describe('player administration route seam', () => {
  const deploymentMode = process.env.BOX_DEPLOYMENT_MODE;

  beforeEach(() => {
    process.env.BOX_DEPLOYMENT_MODE = 'player-service';
  });

  afterEach(() => {
    if (deploymentMode === undefined) delete process.env.BOX_DEPLOYMENT_MODE;
    else process.env.BOX_DEPLOYMENT_MODE = deploymentMode;
    jest.restoreAllMocks();
  });

  test('hides player-service routes outside player-service deployments', async () => {
    process.env.BOX_DEPLOYMENT_MODE = 'play';
    const authorize = authorization(actor);
    const route = createPlayerAdminRoute({
      authorize,
      sendError: sendPlayerAdminApiError,
    })({
      methods: ['GET'],
      requirement: 'players.view',
      errorContext: 'test route failed',
    }, async () => undefined);
    const { res, state } = response();

    await route(request(), res);

    expect(state.statusCode).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
  });

  test('rejects unsupported methods before authorization', async () => {
    const authorize = authorization(actor);
    const route = createPlayerAdminRoute({
      authorize,
      sendError: sendPlayerAdminApiError,
    })({
      methods: ['GET', 'POST'],
      requirement: 'players.view',
      errorContext: 'test route failed',
    }, async () => undefined);
    const { res, state, headers } = response();

    await route(request('DELETE'), res);

    expect(state.statusCode).toBe(405);
    expect(headers.get('Allow')).toBe('GET, POST');
    expect(authorize).not.toHaveBeenCalled();
  });

  test('authorizes before parsing user-controlled input', async () => {
    const authorize = authorization(null);
    const parse = jest.fn(() => ({ search: 'player' }));
    const handler = jest.fn(async () => undefined);
    const route = createPlayerAdminRoute({
      authorize,
      sendError: sendPlayerAdminApiError,
    })({
      methods: ['GET'],
      requirement: 'players.view',
      parse,
      errorContext: 'test route failed',
    }, async () => {
      await handler();
    });
    const { res } = response();

    await route(request(), res);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('passes normalized input and a dynamically selected requirement to the handler', async () => {
    const authorize = authorization(actor);
    const handler = jest.fn();
    const route = createPlayerAdminRoute({
      authorize,
      sendError: sendPlayerAdminApiError,
    })({
      methods: ['POST'],
      requirement: () => 'players.manage',
      parse: (req) => ({ name: String(req.body.name).trim() }),
      errorContext: 'test route failed',
    }, async (context) => {
      handler(context);
      return context.res.status(200).json(context.input);
    });
    const req = request('POST', { body: { name: '  玩家  ' } });
    const { res, state } = response();

    await route(req, res);

    expect(authorize).toHaveBeenCalledWith(req, res, 'players.manage');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      input: { name: '玩家' },
    }));
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ name: '玩家' });
  });

  test('maps request errors and masks unexpected implementation failures', async () => {
    const authorize = authorization(actor);
    const buildRoute = createPlayerAdminRoute({
      authorize,
      sendError: sendPlayerAdminApiError,
    });
    const invalid = buildRoute({
      methods: ['POST'],
      requirement: 'players.manage',
      parse: () => {
        throw new PlayerAdminRequestError('请求字段无效');
      },
      errorContext: 'validation failed',
    }, async () => undefined);
    const first = response();

    await invalid(request('POST'), first.res);

    expect(first.state.statusCode).toBe(400);
    expect(first.state.body).toEqual({ message: '请求字段无效' });

    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = buildRoute({
      methods: ['GET'],
      requirement: 'players.view',
      errorContext: 'database failed',
    }, async () => {
      throw new Error('postgres password leaked');
    });
    const second = response();

    await failed(request(), second.res);

    expect(second.state.statusCode).toBe(503);
    expect(second.state.body).toEqual({ message: '玩家管理服务暂时不可用' });
  });
});
