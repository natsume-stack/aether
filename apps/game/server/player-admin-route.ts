import type { NextApiRequest, NextApiResponse } from 'next';

import {
  authorizePlayerAdmin,
  sendPlayerAdminApiError,
  type PlayerAdminActor,
} from './player-admin-authorization';
import type {
  PlayerAdminRequirement,
} from '@box/player-policy';

type PlayerAdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type PlayerAdminRouteResult = void | NextApiResponse | Promise<void | NextApiResponse>;

type PlayerAdminRouteOptions<Input> = {
  methods: readonly PlayerAdminMethod[];
  requirement:
    | PlayerAdminRequirement
    | PlayerAdminRequirement[]
    | ((req: NextApiRequest) => PlayerAdminRequirement | PlayerAdminRequirement[]);
  parse?: (req: NextApiRequest) => Input;
  errorContext: string;
};

type PlayerAdminRouteContext<Input> = {
  req: NextApiRequest;
  res: NextApiResponse;
  actor: PlayerAdminActor;
  input: Input;
};

type PlayerAdminRouteDependencies = {
  authorize: typeof authorizePlayerAdmin;
  sendError: typeof sendPlayerAdminApiError;
};

export function createPlayerAdminRoute(
  dependencies: PlayerAdminRouteDependencies = {
    authorize: authorizePlayerAdmin,
    sendError: sendPlayerAdminApiError,
  },
) {
  return function playerAdminRoute<Input = undefined>(
    options: PlayerAdminRouteOptions<Input>,
    handler: (context: PlayerAdminRouteContext<Input>) => PlayerAdminRouteResult,
  ) {
    return async function playerAdminApiHandler(
      req: NextApiRequest,
      res: NextApiResponse,
    ) {
      if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') {
        return res.status(404).end();
      }
      const method = req.method as PlayerAdminMethod | undefined;
      if (!method || !options.methods.includes(method)) {
        res.setHeader('Allow', options.methods.join(', '));
        return res.status(405).end();
      }
      const requirement = typeof options.requirement === 'function'
        ? options.requirement(req)
        : options.requirement;
      const actor = await dependencies.authorize(req, res, requirement);
      if (!actor) return;
      try {
        const input = options.parse
          ? options.parse(req)
          : (undefined as Input);
        return await handler({ req, res, actor, input });
      } catch (error) {
        return dependencies.sendError(res, error, options.errorContext);
      }
    };
  };
}

export const playerAdminRoute = createPlayerAdminRoute();
