import { playerAdminIdentity } from '../../../../server/player-admin-authorization';
import {
  deletePlayerAdminPermissionGroup,
  updatePlayerAdminPermissionGroup,
} from '../../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';
import {
  parseUpdatePermissionGroup,
  parseUuid,
} from '../../../../server/player-admin-validation';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

export default playerAdminRoute({
  methods: ['PATCH', 'DELETE'],
  requirement: 'owner',
  parse: (req) => {
    const id = parseUuid(
      Array.isArray(req.query.id) ? req.query.id[0] : req.query.id || '',
      '权限组 ID ',
    );
    return req.method === 'PATCH'
      ? { kind: 'update' as const, id, changes: parseUpdatePermissionGroup(req.body) }
      : { kind: 'delete' as const, id };
  },
  errorContext: 'Permission group update failed',
}, async ({ req, res, actor, input: operation }) => {
  const identity = playerAdminIdentity(actor);
  if (operation.kind === 'update') {
    return res.status(200).json({
      group: await updatePlayerAdminPermissionGroup(
        operation.id,
        operation.changes,
        identity,
        req,
      ),
    });
  }
  await deletePlayerAdminPermissionGroup(operation.id, identity, req);
  return res.status(200).json({ deleted: true });
});
