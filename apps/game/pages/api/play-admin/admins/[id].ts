import { playerAdminIdentity } from '../../../../server/player-admin-authorization';
import {
  deletePlayerAdminAccount,
  updatePlayerAdminAccount,
} from '../../../../server/player-admin-identity';
import { playerAdminRoute } from '../../../../server/player-admin-route';
import {
  parseUpdateAdminAccount,
  parseUuid,
} from '../../../../server/player-admin-validation';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

export default playerAdminRoute({
  methods: ['PATCH', 'DELETE'],
  requirement: 'owner',
  parse: (req) => {
    const id = parseUuid(
      Array.isArray(req.query.id) ? req.query.id[0] : req.query.id || '',
      '管理员账号 ID ',
    );
    return req.method === 'PATCH'
      ? { kind: 'update' as const, id, changes: parseUpdateAdminAccount(req.body) }
      : { kind: 'delete' as const, id };
  },
  errorContext: 'Player admin account update failed',
}, async ({ req, res, actor, input: operation }) => {
  const identity = playerAdminIdentity(actor);
  if (operation.kind === 'update') {
    return res.status(200).json({
      admin: await updatePlayerAdminAccount(
        operation.id,
        operation.changes,
        identity,
        req,
      ),
    });
  }
  await deletePlayerAdminAccount(operation.id, identity, req);
  return res.status(200).json({ deleted: true });
});
