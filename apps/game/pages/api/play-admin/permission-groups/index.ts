import { playerAdminIdentity } from '../../../../server/player-admin-authorization';
import {
  createPlayerAdminPermissionGroup,
  listPlayerAdminPermissionGroups,
} from '../../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';
import { parseCreatePermissionGroup } from '../../../../server/player-admin-validation';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

export default playerAdminRoute({
  methods: ['GET', 'POST'],
  requirement: 'owner',
  parse: (req) => req.method === 'POST'
    ? { kind: 'create' as const, values: parseCreatePermissionGroup(req.body) }
    : { kind: 'list' as const },
  errorContext: 'Permission group operation failed',
}, async ({ req, res, actor, input: operation }) => {
  const identity = playerAdminIdentity(actor);
  if (operation.kind === 'list') {
    return res.status(200).json({
      groups: await listPlayerAdminPermissionGroups(identity),
    });
  }
  return res.status(201).json({
    group: await createPlayerAdminPermissionGroup(operation.values, identity, req),
  });
});
